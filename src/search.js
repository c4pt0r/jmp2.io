import { escapeHtml, isValidSlug } from './util.js';
import { renderMarkdown } from './render.js';
import { basicAuthCredentials, usernameMatches, verifyPassword } from './password.js';
import { authPage, docHref } from './theme.js';
import { objectKey } from './serve.js';

/**
 * Full-text search over a tenant's live documents, on D1's FTS5.
 *
 * The index is keyed by (slug, src_version, path) — the same identity as an R2
 * object — and that content never changes once written. So publishing, the
 * copy-on-write manifest and rollback need no index maintenance at all: a
 * query joins against the live manifest and only sees what is live.
 *
 * Documents are indexed lazily, at query time, for whatever the live manifest
 * holds that the index does not. That covers new publishes and backfill with
 * one code path and no hooks on the write side; the cost is that the first
 * search after a large publish does the reading.
 */

export const SEARCH = {
  maxQuery: 200,
  maxTerms: 8,
  results: 20,
  // Documents read from R2 per request. A large backlog is indexed over a few
  // searches rather than blowing the subrequest budget on one.
  fillPerRequest: 100,
  // Characters kept per document. Enough for any real page; stops a 10 MB
  // generated file from dominating the database.
  maxChars: 100_000,
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

/** Markdown to the text a reader would see: rendered, then de-tagged. */
export function plainText(source) {
  const { html, title } = renderMarkdown(source, '');
  const text = html
    .replace(/<a class="anchor"[^>]*>#<\/a>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENTITIES[e])
    .replace(/\s+/g, ' ')
    .trim();
  return { title, text: text.slice(0, SEARCH.maxChars) };
}

/**
 * Split a query into terms. The index uses the trigram tokenizer, which
 * matches substrings in any script — CJK included, which has no spaces for a
 * word tokenizer to split on — but cannot use the index below three
 * characters. Shorter terms fall back to LIKE, a scan that is fine at the
 * sizes this runs at.
 */
export function parseQuery(q) {
  const terms = [...new Set(
    String(q || '').slice(0, SEARCH.maxQuery).trim().split(/\s+/).filter(Boolean),
  )].slice(0, SEARCH.maxTerms);
  const long = terms.filter((t) => [...t].length >= 3);
  const short = terms.filter((t) => [...t].length < 3);
  return {
    terms,
    // Each term quoted, so FTS5 operators in user input are just text.
    match: long.length ? long.map((t) => `"${t.replaceAll('"', '""')}"`).join(' AND ') : null,
    likes: short.map((t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`),
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A window of text around the first hit, escaped, with every term in <mark>. */
export function snippet(text, terms, width = 220) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = Math.max(0, at - 60);
  const piece = text.slice(start, start + width);
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi');
  const marked = piece.split(re)
    .map((s, i) => (i % 2 ? `<mark>${escapeHtml(s)}</mark>` : escapeHtml(s)))
    .join('');
  return (start > 0 ? '…' : '') + marked + (start + width < text.length ? '…' : '');
}

/** Which sites a search may look at: one named site, or every listed one. */
function scope(site) {
  return site
    ? { sql: 's.slug = ?2', bind: site }
    : { sql: "s.visibility = 'public' AND s.password_hash IS NULL AND ?2 IS NULL", bind: null };
}

/** Index whatever live markdown the index does not have yet. Returns true if more remain. */
async function fill(env, tenantId, site) {
  const sc = scope(site);
  const { results } = await env.DB.prepare(
    `SELECT f.slug, f.path, f.src_version FROM files f
     JOIN sites s ON s.tenant_id = f.tenant_id AND s.slug = f.slug AND s.current_version = f.version
     LEFT JOIN search_docs d ON d.tenant_id = f.tenant_id AND d.slug = f.slug
       AND d.src_version = f.src_version AND d.path = f.path
     WHERE f.tenant_id = ?1 AND ${sc.sql} AND d.id IS NULL
       AND (f.path LIKE '%.md' OR f.path LIKE '%.markdown')
     LIMIT ?3`,
  ).bind(tenantId, sc.bind, SEARCH.fillPerRequest + 1).all();
  if (!results.length) return false;

  const todo = results.slice(0, SEARCH.fillPerRequest);
  const docs = [];
  for (let i = 0; i < todo.length; i += 25) {
    docs.push(...await Promise.all(todo.slice(i, i + 25).map(async (r) => {
      const obj = await env.SITES.get(objectKey(tenantId, r.slug, r.src_version, r.path));
      return obj ? { ...r, ...plainText(await obj.text()) } : null;
    })));
  }

  // OR IGNORE: two concurrent searches may both decide to index the same file.
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO search_docs (tenant_id, slug, src_version, path, title, body)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  );
  const rows = docs.filter(Boolean)
    .map((d) => stmt.bind(tenantId, d.slug, d.src_version, d.path, d.title, d.text));
  for (let i = 0; i < rows.length; i += 50) await env.DB.batch(rows.slice(i, i + 50));
  return results.length > SEARCH.fillPerRequest;
}

/** Run a parsed query against the live documents in scope. */
export async function search(env, tenantId, site, parsed) {
  const sc = scope(site);
  const binds = [tenantId, sc.bind];
  const where = [];
  let join = '';
  let order = 's.updated_at DESC, d.path';
  if (parsed.match) {
    binds.push(parsed.match);
    join = `JOIN search_fts ON search_fts.rowid = d.id AND search_fts MATCH ?${binds.length}`;
    // Title hits count for more than body hits.
    order = 'bm25(search_fts, 5.0, 1.0)';
  }
  for (const like of parsed.likes) {
    binds.push(like);
    where.push(`d.body LIKE ?${binds.length} ESCAPE '\\'`);
  }
  binds.push(SEARCH.results);

  const { results } = await env.DB.prepare(
    `SELECT d.slug, d.path, d.title, d.body, s.title AS site_title
     FROM search_docs d
     ${join}
     JOIN sites s ON s.tenant_id = d.tenant_id AND s.slug = d.slug
     JOIN files f ON f.tenant_id = d.tenant_id AND f.slug = d.slug
       AND f.version = s.current_version AND f.path = d.path AND f.src_version = d.src_version
     WHERE d.tenant_id = ?1 AND ${sc.sql} ${where.map((w) => `AND ${w}`).join(' ')}
     ORDER BY ${order}
     LIMIT ?${binds.length}`,
  ).bind(...binds).all();
  return results;
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/**
 * GET `<tenant>.<root>/_search?q=…[&site=slug]`.
 *
 * Without `site` it searches the tenant's listed sites only: secret means
 * unlisted, and a search box that surfaced unlisted pages would be a listing.
 * With `site` it searches that one site whatever its visibility, since the
 * searcher already holds its URL — but a password still has to be presented.
 */
export async function searchPage(request, env, tenantId) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').slice(0, SEARCH.maxQuery).trim();
  const site = url.searchParams.get('site') || null;
  let siteRow = null;

  if (site !== null) {
    siteRow = isValidSlug(site) && await env.DB.prepare(
      `SELECT slug, title, password_hash, auth_user FROM sites
       WHERE tenant_id = ?1 AND slug = ?2 AND current_version IS NOT NULL`,
    ).bind(tenantId, site).first();
    if (!siteRow) return new Response('No such site\n', { status: 404, headers: SECURITY_HEADERS });
    if (siteRow.password_hash) {
      const creds = basicAuthCredentials(request);
      if (creds === null
        || !usernameMatches(siteRow.auth_user, creds.user)
        || !(await verifyPassword(creds.password, siteRow.password_hash))) {
        return new Response('Password required\n', {
          status: 401,
          headers: {
            'www-authenticate': `Basic realm="${site.replace(/[^a-z0-9-]/gi, '')}", charset="UTF-8"`,
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            ...SECURITY_HEADERS,
          },
        });
      }
    }
  }

  const parsed = parseQuery(q);
  let results = [];
  let partial = false;
  if (parsed.terms.length) {
    partial = await fill(env, tenantId, site);
    results = await search(env, tenantId, site, parsed);
  }

  if (url.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify({
      query: q,
      partial,
      results: results.map((r) => ({
        site: r.slug,
        path: r.path,
        title: r.title || r.path,
        url: `${url.origin}${docHref(`/${r.slug}`, r.path)}`,
      })),
    }, null, 2) + '\n', {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': siteRow?.password_hash ? 'private, no-store' : 'no-cache',
        ...SECURITY_HEADERS,
      },
    });
  }

  const label = siteRow ? (siteRow.title || siteRow.slug) : tenantId;
  const items = results.map((r) => `<li>
  <a href="${escapeHtml(docHref(`/${r.slug}`, r.path))}">${escapeHtml(r.title || r.path)}</a>
  <span class="sub">${site ? '' : `${escapeHtml(r.slug)} · `}${escapeHtml(r.path)}</span>
  <p>${snippet(r.body, parsed.terms)}</p>
</li>`).join('');

  let outcome = '';
  if (parsed.terms.length) {
    outcome = results.length
      ? `<ul class="hits">${items}</ul>`
      : '<p class="lede">Nothing matched.</p>';
    if (partial) outcome += '<p class="note">Some pages are still being indexed; searching again will cover more.</p>';
  }

  const back = siteRow ? `/${siteRow.slug}/` : '/';
  return authPage({
    title: q ? `${q} · search ${label}` : `Search ${label}`,
    heading: `Search ${label}`,
    bare: true,
    headers: {
      'cache-control': siteRow?.password_hash ? 'private, no-store' : 'no-cache',
      ...SECURITY_HEADERS,
    },
    bodyHtml: `<form class="search" method="get" action="/_search" role="search">
  ${site ? `<input type="hidden" name="site" value="${escapeHtml(site)}">` : ''}
  <input name="q" value="${escapeHtml(q)}" aria-label="Search" placeholder="Search" autofocus enterkeyhint="search">
  <button type="submit">Search</button>
</form>
${outcome}
<div class="footer"><a href="${escapeHtml(back)}">${escapeHtml(label)}</a></div>`,
  });
}
