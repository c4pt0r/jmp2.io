import { ctypeFor, escapeHtml, isMarkdown, isValidSlug, normalizePath } from './util.js';
import { renderMarkdown } from './render.js';
import { basicAuthCredentials, usernameMatches, verifyPassword } from './password.js';
import { CSP, RENDER_VERSION, docPage, messagePage, plainPage } from './theme.js';

const INDEX_NAMES = ['index.md', 'index.markdown', 'README.md', 'readme.md'];
const MD_SUFFIXES = ['.md', '.markdown'];

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

const notFound = (siteRoot) =>
  messagePage({
    status: 404,
    heading: 'Not found',
    message: 'There is nothing published at this URL.',
    links: siteRoot ? [{ href: `${siteRoot}/`, text: 'site home' }] : [],
  });

/** 301 rather than 302: the trailing slash is a permanent property of the URL. */
const redirect = (to) => new Response(null, { status: 301, headers: { location: to } });

/**
 * Resolve a request path within a site to a concrete stored file.
 *
 * Document URLs are extensionless (`docs/guide.md` is served at `docs/guide`),
 * which is what makes relative links in the markdown resolve correctly. The
 * cost is that one URL can mean several things, so the order here matters:
 * an exact stored file always wins over an inferred one.
 *
 * @param {Set<string>} paths every file path in the live version
 * @param {string} rest       request path within the site, no leading slash
 * @returns {{kind:'render'|'raw'|'asset'|'redirect'|'missing', path?:string, to?:string}}
 */
export function resolve(paths, rest) {
  if (rest !== '' && !rest.endsWith('/') && paths.has(rest)) {
    return { kind: isMarkdown(rest) ? 'raw' : 'asset', path: rest };
  }

  if (rest === '' || rest.endsWith('/')) {
    for (const name of INDEX_NAMES) {
      if (paths.has(rest + name)) return { kind: 'render', path: rest + name };
    }
    return { kind: 'missing' };
  }

  // `docs/index` is a second URL for `docs/`; collapse it instead of serving both.
  if (/(^|\/)(index|readme)$/i.test(rest)) {
    const dir = rest.slice(0, rest.lastIndexOf('/') + 1);
    for (const name of INDEX_NAMES) {
      if (paths.has(dir + name)) return { kind: 'redirect', to: dir };
    }
  }

  for (const suffix of MD_SUFFIXES) {
    if (paths.has(rest + suffix)) return { kind: 'render', path: rest + suffix };
  }

  // `docs` when only `docs/index.md` exists: send the browser to `docs/` so
  // relative links inside that document resolve one level deeper.
  for (const name of INDEX_NAMES) {
    if (paths.has(`${rest}/${name}`)) return { kind: 'redirect', to: `${rest}/` };
  }

  return { kind: 'missing' };
}

async function loadSite(env, tenantId, slug) {
  const site = await env.DB.prepare(
    `SELECT current_version, title, visibility, password_hash, auth_user, updated_at
     FROM sites WHERE tenant_id = ?1 AND slug = ?2`,
  ).bind(tenantId, slug).first();
  return site?.current_version == null ? null : site;
}

/** 401 that makes the browser prompt. Never cached, by anyone. */
const askForPassword = (slug) => new Response('Password required\n', {
  status: 401,
  headers: {
    'www-authenticate': `Basic realm="${slug.replace(/[^a-z0-9-]/gi, '')}", charset="UTF-8"`,
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  },
});

/**
 * The live version's file list, as a path -> src_version map. A version can
 * inherit rows from an older one, so the object's key is not always derived
 * from the version being served.
 */
async function loadManifest(env, tenantId, slug, version) {
  const { results } = await env.DB.prepare(
    'SELECT path, src_version FROM files WHERE tenant_id = ?1 AND slug = ?2 AND version = ?3',
  ).bind(tenantId, slug, version).all();
  return new Map(results.map((r) => [r.path, r.src_version]));
}

export const objectKey = (tenantId, slug, version, path) =>
  `sites/${tenantId}/${slug}/${version}/${path}`;

function assetResponse(obj, path) {
  const { ctype, download } = ctypeFor(path);
  const headers = new Headers(SECURITY_HEADERS);
  obj.writeHttpMetadata(headers);
  headers.set('content-type', ctype);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=300');
  if (download) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    headers.set('content-disposition', `attachment; filename="${name.replace(/["\\]/g, '')}"`);
  }
  // A directly-navigated SVG is a document, and documents can run script.
  // Sandboxing it keeps a hostile SVG from acting inside its own tenant origin.
  if (ctype === 'image/svg+xml') {
    headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
  return new Response(obj.body, { headers });
}

/** The tenant's own front page: every site they have published. */
async function tenantIndex(env, tenantId, rootDomain) {
  const { results } = await env.DB.prepare(
    `SELECT slug, title, updated_at FROM sites
     WHERE tenant_id = ?1 AND current_version IS NOT NULL AND visibility = 'public'
     ORDER BY updated_at DESC`,
  ).bind(tenantId).all();

  const body = results.length
    ? `<ul class="sites">${results.map((s) =>
        `<li><a href="/${escapeHtml(s.slug)}/">${escapeHtml(s.title || s.slug)}</a>` +
        (s.title && s.title !== s.slug ? `<span class="sub"> ${escapeHtml(s.slug)}</span>` : '') +
        '</li>').join('')}</ul>`
    : '<p class="lede">No published sites yet.</p>';

  return plainPage({
    title: `${tenantId}.${rootDomain}`,
    heading: tenantId,
    bodyHtml: `${body}<div class="footer"><span>served by <a href="https://${escapeHtml(rootDomain)}/">${escapeHtml(rootDomain)}</a></span></div>`,
    headers: SECURITY_HEADERS,
  });
}

/** GET/HEAD handler for `<tenant>.<root>/...`. */
export async function serveTenant(request, env, ctx, tenantId) {
  const url = new URL(request.url);

  const tenant = await env.DB.prepare('SELECT id, disabled_at FROM tenants WHERE id = ?1')
    .bind(tenantId).first();
  if (!tenant) {
    return messagePage({
      status: 404, heading: 'No such tenant',
      message: `${tenantId}.${env.ROOT_DOMAIN} is not registered.`,
      links: [{ href: `https://${env.ROOT_DOMAIN}/`, text: env.ROOT_DOMAIN }],
    });
  }
  // Suspended tenants stop serving immediately but keep their data, so an
  // abuse report can still be investigated after the content is offline.
  if (tenant.disabled_at) {
    return messagePage({
      status: 403, heading: 'Suspended',
      message: 'This subdomain has been suspended.',
      links: [{ href: `https://${env.ROOT_DOMAIN}/`, text: env.ROOT_DOMAIN }],
    });
  }

  const segments = url.pathname.split('/').slice(1);
  const slug = segments[0] ?? '';
  if (slug === '') return tenantIndex(env, tenantId, env.ROOT_DOMAIN);
  if (!isValidSlug(slug)) return notFound(null);
  if (segments.length === 1) return redirect(`/${slug}/`);

  const site = await loadSite(env, tenantId, slug);
  if (!site) return notFound(null);
  const version = site.current_version;
  const siteRoot = `/${slug}`;

  // A password-protected site must never touch the shared edge cache: a cached
  // response would be served to the next visitor with no credentials at all.
  const protectedSite = Boolean(site.password_hash);
  if (protectedSite) {
    const creds = basicAuthCredentials(request);
    if (creds === null
      || !usernameMatches(site.auth_user, creds.user)
      || !(await verifyPassword(creds.password, site.password_hash))) {
      return askForPassword(slug);
    }
  }

  // Qualified by both the content version and a fingerprint of the rendering
  // code, so publishing a new version *and* deploying new markup each
  // invalidate every page of the site without an explicit purge.
  const cacheKey = new Request(
    `${url.origin}${url.pathname}?__v=${version}&__r=${RENDER_VERSION}`,
    { method: 'GET' },
  );
  const cache = caches.default;
  if (!protectedSite) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  // Normalize the directory case too: the trailing slash is meaningful, but the
  // rest of the path still has to survive traversal checks before we trust it.
  const rest = segments.slice(1).join('/');
  const trailing = rest.endsWith('/');
  const core = trailing ? rest.slice(0, -1) : rest;
  let normalized = '';
  if (core !== '') {
    const clean = normalizePath(core);
    if (clean === null) return notFound(siteRoot);
    normalized = trailing ? `${clean}/` : clean;
  }

  const manifest = await loadManifest(env, tenantId, slug, version);
  const docPaths = [...manifest.keys()];
  const found = resolve(new Set(docPaths), normalized);

  if (found.kind === 'missing') return notFound(siteRoot);
  if (found.kind === 'redirect') return redirect(`${siteRoot}/${found.to}`);

  const obj = await env.SITES.get(
    objectKey(tenantId, slug, manifest.get(found.path), found.path),
  );
  if (!obj) return notFound(siteRoot);

  let response;
  if (found.kind === 'render') {
    const source = await obj.text();
    // The mount point for relative links is the document's own directory when
    // it is an index, otherwise the site root prefix its URL sits under.
    const { html, title } = renderMarkdown(source, siteRoot);
    const docDir = found.path.includes('/') ? found.path.slice(0, found.path.lastIndexOf('/') + 1) : '';
    response = new Response(
      docPage({
        title: title ? `${title} · ${slug}` : `${slug} · ${tenantId}`,
        contentHtml: html,
        siteRoot,
        siteLabel: site.title || slug,
        docPaths: docPaths.filter(isMarkdown).sort(),
        currentPath: found.path,
        rawHref: `${siteRoot}/${found.path}`,
        rootDomain: env.ROOT_DOMAIN,
        canonical: `${url.origin}${siteRoot}/${docDir}`,
      }),
      {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': CSP,
          'cache-control': 'public, max-age=300',
          ...SECURITY_HEADERS,
        },
      },
    );
  } else if (found.kind === 'raw') {
    response = new Response(obj.body, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=300',
        etag: obj.httpEtag,
        ...SECURITY_HEADERS,
      },
    });
  } else {
    response = assetResponse(obj, found.path);
  }

  if (protectedSite) {
    // Belt and braces: no shared cache, and no browser or proxy copy either.
    response = new Response(response.body, response);
    response.headers.set('cache-control', 'private, no-store');
  } else {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}
