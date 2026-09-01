import { clearCookie, readSession } from './auth.js';
import { mintToken } from './tokens.js';
import { hashPassword } from './password.js';
import { LIMITS as RATE, hit } from './ratelimit.js';
import { ctypeFor, escapeHtml, isMarkdown, normalizePath, now } from './util.js';
import { objectKey } from './serve.js';
import { deleteSite } from './api.js';
import { sessionIdentity } from './oauth.js';
import { authPage } from './theme.js';

const redirect = (to, headers = {}) =>
  new Response(null, { status: 302, headers: { location: to, ...headers } });

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function humanWhen(seconds) {
  if (!seconds) return 'never';
  const delta = now() - seconds;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d ago`;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** The signed-in tenant, or null. Also the place suspension is noticed. */
async function currentTenant(request, env) {
  const identity = sessionIdentity(await readSession(request, env.SESSION_SECRET));
  if (!identity) return null;
  const tenant = await env.DB.prepare(
    `SELECT id, quota_bytes, disabled_at, disabled_reason FROM tenants
     WHERE owner_provider = ?1 AND owner_subject = ?2`,
  ).bind(identity.provider, identity.subject).first();
  return tenant ? { tenant, identity } : null;
}

async function loadDashboard(env, tenantId) {
  const [sites, tokens, usage] = await Promise.all([
    env.DB.prepare(
      `SELECT s.slug, s.title, s.current_version, s.updated_at,
              s.visibility, s.password_hash IS NOT NULL AS locked, s.auth_user,
              v.bytes, v.file_count
       FROM sites s
       LEFT JOIN versions v
         ON v.tenant_id = s.tenant_id AND v.slug = s.slug AND v.version = s.current_version
       WHERE s.tenant_id = ?1
       ORDER BY s.updated_at DESC`,
    ).bind(tenantId).all(),
    env.DB.prepare(
      `SELECT id, name, created_at, last_used_at, revoked_at
       FROM tokens WHERE tenant_id = ?1 ORDER BY created_at DESC`,
    ).bind(tenantId).all(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(bytes), 0) AS b FROM (
         SELECT DISTINCT slug, src_version, path, bytes FROM files WHERE tenant_id = ?1)`,
    ).bind(tenantId).first(),
  ]);
  return { sites: sites.results, tokens: tokens.results, usedBytes: usage?.b ?? 0 };
}

function siteCard(s, tenantId, rootDomain) {
  const url = `https://${tenantId}.${rootDomain}/${s.slug}/`;
  const live = s.current_version != null;
  const secret = s.visibility !== 'public';

  // In a monochrome palette state has to read as shape: a filled pill is
  // listed, an outline is unlisted, a dot marks a password.
  const pill = s.locked
    ? '<span class="pill"><span class="dot"></span>Password</span>'
    : secret
      ? '<span class="pill">Unlisted</span>'
      : '<span class="pill listed">Listed</span>';

  const facts = [
    live ? `v${s.current_version}` : 'draft',
    `${s.file_count ?? 0} file${s.file_count === 1 ? '' : 's'}`,
    humanBytes(s.bytes ?? 0),
    humanWhen(s.updated_at),
  ].map((f) => `<span>${escapeHtml(f)}</span>`).join('');

  const action = `/account/sites/${escapeHtml(s.slug)}/visibility`;
  return `<div class="card">
  <div class="card-top">
    <div class="card-id">
      <div>${live
        ? `<a class="name" href="${escapeHtml(url)}">${escapeHtml(s.slug)}</a>`
        : `<span class="name">${escapeHtml(s.slug)}</span>`} ${pill}</div>
      ${s.title && s.title !== s.slug ? `<div class="sub">${escapeHtml(s.title)}</div>` : ''}
      <div class="card-facts">${facts}</div>
    </div>
    <div class="actions">
      ${live ? `<a class="btn btn-quiet btn-sm" href="/account/sites/${escapeHtml(s.slug)}/edit">Edit</a>` : ''}
      ${live ? `<a class="btn btn-quiet btn-sm" href="${escapeHtml(url)}">Open</a>` : ''}
    </div>
  </div>

  <details class="disclose">
    <summary>Who can see this</summary>
    <form method="post" action="${action}" class="access">
      <div class="full choices">
        <label class="opt"><input type="radio" name="visibility" value="public"${secret ? '' : ' checked'}> Listed on your index</label>
        <label class="opt"><input type="radio" name="visibility" value="secret"${secret ? ' checked' : ''}> Unlisted</label>
      </div>
      <label class="field"><span>Username (optional)</span>
        <input name="auth_user" value="${escapeHtml(s.auth_user || '')}" autocomplete="off" placeholder="anyone"></label>
      <label class="field"><span>Password</span>
        <input name="password" type="password" autocomplete="new-password"
          placeholder="${s.locked ? 'set — type to replace' : 'none'}"></label>
      <div class="full">
        <button class="btn-sm" type="submit">Save</button>
        ${s.locked ? '<label class="opt"><input type="checkbox" name="clear_password" value="1"> Remove the password</label>' : ''}
        <span class="spacer"></span>
        <a class="danger-link" href="/account/sites/${escapeHtml(s.slug)}/delete">Delete this site</a>
      </div>
    </form>
  </details>
</div>`;
}

function sitesSection(sites, tenantId, rootDomain) {
  if (!sites.length) {
    return `<div class="empty">Nothing published yet. Push a folder and it appears here.
<pre><code>tar czf - ./docs | curl -T - https://${escapeHtml(rootDomain)}/_api/sites/handbook/tarball \\
  -H "Authorization: Bearer $TOKEN"</code></pre></div>`;
  }
  return `<div class="cards">${sites.map((s) => siteCard(s, tenantId, rootDomain)).join('')}</div>
<p class="fine">Unlisted means it is kept off your index, not that it is private:
without a password the URL is still readable by anyone who has it.</p>`;
}

function tokensSection(tokens) {
  const rows = tokens.map((t) => `<div class="row${t.revoked_at ? ' gone' : ''}">
  <div>
    <div class="id">${escapeHtml(t.id || '—')}</div>
    <div class="meta">${escapeHtml(t.name || 'unnamed')} · created ${escapeHtml(humanWhen(t.created_at))} · last used ${escapeHtml(humanWhen(t.last_used_at))}</div>
  </div>
  ${t.revoked_at
    ? '<span class="meta">revoked</span>'
    : `<form method="post" action="/account/tokens/${escapeHtml(t.id)}/revoke" class="inline">
         <button class="danger btn-sm" type="submit">Revoke</button></form>`}
</div>`).join('');
  return `<div class="rows">${rows}</div>`;
}

function dashboardHtml({ tenant, rootDomain, sites, tokens, usedBytes, freshToken }) {
  const pct = Math.min(100, Math.round((usedBytes / tenant.quota_bytes) * 100));
  const home = `https://${tenant.id}.${rootDomain}/`;
  const listed = sites.filter((s) => s.visibility === 'public' && s.current_version != null).length;

  const suspended = tenant.disabled_at
    ? `<div class="callout"><strong>This subdomain is suspended.</strong>${
        tenant.disabled_reason ? ` ${escapeHtml(tenant.disabled_reason)}` : ''}</div>`
    : '';

  const minted = freshToken
    ? `<div class="callout">
  <strong>Copy this token now.</strong> It is shown once and cannot be recovered.
  <pre><code>${escapeHtml(freshToken)}</code></pre>
</div>`
    : '';

  return `${suspended}${minted}
<div class="summary">
  <a class="host" href="${escapeHtml(home)}">${escapeHtml(tenant.id)}.${escapeHtml(rootDomain)}</a>
  <span class="stat">${sites.length} site${sites.length === 1 ? '' : 's'}, ${listed} listed</span>
  <span class="stat">${humanBytes(usedBytes)} of ${humanBytes(tenant.quota_bytes)}</span>
  <div class="meter" title="${usedBytes} of ${tenant.quota_bytes} bytes">
    <div class="meter-fill" style="width:${pct}%"></div>
  </div>
</div>

<div class="section">
  <div class="section-head"><h2>Sites</h2></div>
  ${sitesSection(sites, tenant.id, rootDomain)}
</div>

<div class="section">
  <div class="section-head">
    <h2>Tokens</h2>
    <form method="post" action="/account/tokens" class="inline">
      <input type="hidden" name="name" value="dashboard">
      <button class="btn-quiet btn-sm" type="submit">New token</button>
    </form>
  </div>
  ${tokensSection(tokens)}
  <p class="fine">Tokens are stored hashed, so the value is shown once. Revoking takes effect immediately.</p>
</div>

<div class="section">
  <div class="section-head"><h2>Publish</h2></div>
  <pre><code>tar czf - ./docs | curl -T - https://${escapeHtml(rootDomain)}/_api/sites/handbook/tarball \\
  -H "Authorization: Bearer $TOKEN"</code></pre>
  <p class="actions">
    <a class="btn btn-quiet btn-sm" href="https://${escapeHtml(rootDomain)}/">Docs</a>
    <a class="btn btn-quiet btn-sm" href="/auth/signout">Sign out</a>
  </p>
</div>`;
}

/** GET /account */
async function dashboard(request, env, freshToken = null) {
  const current = await currentTenant(request, env);
  if (!current) return redirect('/signup');
  const data = await loadDashboard(env, current.tenant.id);
  return authPage({
    rootDomain: env.ROOT_DOMAIN,
    title: `${current.tenant.id}.${env.ROOT_DOMAIN}`,
    heading: current.tenant.id,
    wide: true,
    bodyHtml: dashboardHtml({
      tenant: current.tenant, rootDomain: env.ROOT_DOMAIN, ...data, freshToken,
    }),
  });
}

/**
 * Browser-session writes are guarded by SameSite=Lax plus this explicit origin
 * check; there is no bearer token in play, so a cross-site POST is the risk.
 */
function badOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).hostname !== env.ROOT_DOMAIN;
  } catch {
    return true;
  }
}

/** POST /account/tokens */
async function createToken(request, env) {
  if (badOrigin(request, env)) return new Response('cross-site post rejected', { status: 403 });
  const current = await currentTenant(request, env);
  if (!current) return redirect('/signup');
  if (current.tenant.disabled_at) return redirect('/account');

  const gate = await hit(env, `mint:${current.identity.provider}:${current.identity.subject}`, RATE.signup);
  if (!gate.ok) {
    return authPage({
      status: 429, title: 'Slow down', heading: 'Too many tokens',
      bodyHtml: '<p class="lede">Try again later.</p><p><a href="/account">Back</a></p>',
    });
  }
  const form = await request.formData().catch(() => null);
  const { token } = await mintToken(env, current.tenant.id, String(form?.get('name') || 'dashboard'));
  return dashboard(request, env, token);
}

/** POST /account/sites/:slug/visibility */
async function changeVisibility(request, env, slug) {
  if (badOrigin(request, env)) return new Response('cross-site post rejected', { status: 403 });
  const current = await currentTenant(request, env);
  if (!current) return redirect('/signup');

  const form = await request.formData().catch(() => null);
  const visibility = String(form?.get('visibility') || '');
  if (!['public', 'secret'].includes(visibility)) return redirect('/account');

  const password = String(form?.get('password') || '');
  const clear = form?.get('clear_password') === '1';
  const authUser = String(form?.get('auth_user') || '').trim() || null;

  // An empty password field means "leave it alone", not "remove it" — otherwise
  // saving a username would silently unlock the site. Removing is a deliberate
  // checkbox, and making a site public always drops the password, since a
  // listed site that still demanded one would be an odd thing to advertise.
  const sets = ['visibility = ?3', 'auth_user = ?4'];
  const binds = [visibility, visibility === 'secret' ? authUser : null];
  if (visibility === 'public' || clear) {
    sets.push('password_hash = NULL');
  } else if (password) {
    binds.push(await hashPassword(password));
    sets.push(`password_hash = ?${binds.length + 2}`);
  }

  await env.DB.prepare(
    `UPDATE sites SET ${sets.join(', ')} WHERE tenant_id = ?1 AND slug = ?2`,
  ).bind(current.tenant.id, slug, ...binds).run();
  return redirect('/account');
}

/** POST /account/tokens/:id/revoke */
async function revokeToken(request, env, tokenId) {
  if (badOrigin(request, env)) return new Response('cross-site post rejected', { status: 403 });
  const current = await currentTenant(request, env);
  if (!current) return redirect('/signup');
  await env.DB.prepare(
    'UPDATE tokens SET revoked_at = ?3 WHERE tenant_id = ?1 AND id = ?2 AND revoked_at IS NULL',
  ).bind(current.tenant.id, tokenId, now()).run();
  return redirect('/account');
}

/**
 * A plain textarea over one markdown file. No script — the CSP allows only the
 * theme toggle — so this is a form post, and saving publishes a new version
 * through the same staging path the API uses.
 */
async function editor(request, env, slug, url) {
  const current = await currentTenant(request, env);
  if (!current) return redirect('/signup');
  const tenantId = current.tenant.id;

  const site = await env.DB.prepare(
    'SELECT current_version, title FROM sites WHERE tenant_id = ?1 AND slug = ?2',
  ).bind(tenantId, slug).first();
  if (!site || site.current_version == null) {
    return authPage({
      status: 404, rootDomain: env.ROOT_DOMAIN, title: 'No such site',
      heading: 'No such site', bodyHtml: '<p class="lede">Nothing is published at that slug.</p><p><a href="/account">Back</a></p>',
    });
  }

  const { results: files } = await env.DB.prepare(
    `SELECT path, src_version FROM files
     WHERE tenant_id = ?1 AND slug = ?2 AND version = ?3`,
  ).bind(tenantId, slug, site.current_version).all();
  const editable = files.filter((f) => isMarkdown(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  if (!editable.length) {
    return authPage({
      status: 400, rootDomain: env.ROOT_DOMAIN, title: 'Nothing to edit',
      heading: 'Nothing to edit', bodyHtml: '<p class="lede">This site has no markdown files.</p><p><a href="/account">Back</a></p>',
    });
  }

  const wanted = normalizePath(url.searchParams.get('path') || '') || '';
  const chosen = editable.find((f) => f.path === wanted) || editable[0];
  const obj = await env.SITES.get(objectKey(tenantId, slug, chosen.src_version, chosen.path));
  const source = obj ? await obj.text() : '';

  const tabs = editable.map((f) =>
    `<a href="/account/sites/${escapeHtml(slug)}/edit?path=${encodeURIComponent(f.path)}"${
      f.path === chosen.path ? ' class="current"' : ''}>${escapeHtml(f.path)}</a>`).join('');

  const justSaved = url.searchParams.get('saved') === '1';
  const justCreated = url.searchParams.get('created') === '1';
  // Fixed messages keyed by code: nothing the caller sends is echoed back.
  const problem = {
    name: 'That is not a usable file name. Use letters, digits, dashes and slashes.',
    exists: 'A page with that name already exists.',
  }[url.searchParams.get('err')] || '';
  const siteUrl = `https://${tenantId}.${env.ROOT_DOMAIN}/${slug}/`;

  return authPage({
    rootDomain: env.ROOT_DOMAIN,
    bare: true,
    title: `${chosen.path} · ${slug}`,
    heading: '',
    bodyHtml: `<div class="editor-bar">
  <a class="back" href="/account" title="Back to your sites">&larr;</a>
  <span class="where">
    <a class="site" href="${escapeHtml(siteUrl)}">${escapeHtml(slug)}/</a><span class="file">${escapeHtml(chosen.path)}</span>
  </span>
  <span class="spacer"></span>
  ${justSaved ? '<span class="note">Published</span>' : ''}
  ${justCreated ? '<span class="note">Page added</span>' : ''}
  <span class="note">v${site.current_version}</span>
</div>

${problem ? `<div class="callout"><strong>${escapeHtml(problem)}</strong></div>` : ''}

<div class="filetabs">
  ${tabs}
  <form class="newpage" method="post" action="/account/sites/${escapeHtml(slug)}/pages">
    <input name="path" placeholder="guide.md" aria-label="New page name"
      autocomplete="off" autocapitalize="off" spellcheck="false">
    <button class="btn-quiet btn-sm" type="submit">Add page</button>
  </form>
</div>

<form class="editor-form" method="post" action="/account/sites/${escapeHtml(slug)}/edit">
  <input type="hidden" name="path" value="${escapeHtml(chosen.path)}">
  <textarea class="editor" name="content" spellcheck="false" autofocus>${escapeHtml(source)}</textarea>
  <div class="editor-foot">
    <button type="submit">Publish changes</button>
    <a class="btn btn-quiet" href="${escapeHtml(siteUrl)}">View site</a>
    <span class="spacer"></span>
    <span>Publishing writes a new version; the previous one stays available to roll back to.</span>
  </div>
</form>`,
  });
}

/**
 * GET /account/sites/:slug/delete — confirmation.
 *
 * Deleting is irreversible and the CSP admits no script, so there is no
 * confirm dialog to lean on. The page states exactly what disappears and asks
 * the owner to type the slug: a misclick cannot get past that, and it needs
 * nothing the browser has to run.
 */
async function confirmDelete(request, env, slug, error) {
  const current = await currentTenant(request, env);
  if (!current) return redirect('/signup');
  const tenantId = current.tenant.id;

  const site = await env.DB.prepare(
    `SELECT s.slug, s.title, s.current_version,
            (SELECT COUNT(*) FROM versions v WHERE v.tenant_id = s.tenant_id AND v.slug = s.slug) AS versions,
            (SELECT COUNT(*) FROM files f WHERE f.tenant_id = s.tenant_id AND f.slug = s.slug
               AND f.version = s.current_version) AS files
     FROM sites s WHERE s.tenant_id = ?1 AND s.slug = ?2`,
  ).bind(tenantId, slug).first();
  if (!site) return redirect('/account');

  return authPage({
    rootDomain: env.ROOT_DOMAIN,
    title: `Delete ${slug}`,
    heading: `Delete ${slug}?`,
    bodyHtml: `${error ? `<div class="callout"><strong>${escapeHtml(error)}</strong></div>` : ''}
<p class="lede">This removes <code>${escapeHtml(slug)}</code> and everything in it. There is
no undo, and the URL becomes available for anyone to claim.</p>
<div class="rows">
  <div class="row"><span class="id">${escapeHtml(site.slug)}</span>
    <span class="meta">${site.files ?? 0} file${site.files === 1 ? '' : 's'} · ${site.versions} version${site.versions === 1 ? '' : 's'}${site.title && site.title !== site.slug ? ` · ${escapeHtml(site.title)}` : ''}</span></div>
</div>
<form method="post" action="/account/sites/${escapeHtml(slug)}/delete">
  <label class="field"><span>Type <code>${escapeHtml(slug)}</code> to confirm</span>
    <input name="confirm" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus></label>
  <p class="actions">
    <button class="danger" type="submit">Delete permanently</button>
    <a class="btn btn-quiet" href="/account">Keep it</a>
  </p>
</form>`,
  });
}

/** POST /account/sites/:slug/delete */
async function performDelete(request, env, slug) {
  if (badOrigin(request, env)) return new Response('cross-site post rejected', { status: 403 });
  const current = await currentTenant(request, env);
  if (!current) return redirect('/signup');

  const form = await request.formData().catch(() => null);
  if (String(form?.get('confirm') || '').trim() !== slug) {
    return confirmDelete(request, env, slug, 'That did not match, so nothing was deleted.');
  }
  await deleteSite(env, current.tenant.id, slug);
  return redirect('/account');
}

/**
 * Write one file and publish it as a new version, inheriting everything else
 * from the current one. Returns false if the site has nothing live to inherit.
 */
async function publishFile(env, tenantId, slug, path, bytes) {
  const site = await env.DB.prepare(
    'SELECT current_version FROM sites WHERE tenant_id = ?1 AND slug = ?2',
  ).bind(tenantId, slug).first();
  if (!site || site.current_version == null) return false;

  const max = await env.DB.prepare(
    'SELECT COALESCE(MAX(version), 0) AS v FROM versions WHERE tenant_id = ?1 AND slug = ?2',
  ).bind(tenantId, slug).first();
  const version = (max?.v ?? 0) + 1;
  const ts = now();

  await env.DB.prepare(
    `INSERT INTO versions (tenant_id, slug, version, state, created_at)
     VALUES (?1, ?2, ?3, 'live', ?4)`,
  ).bind(tenantId, slug, version, ts).run();
  await env.DB.prepare(
    `INSERT INTO files (tenant_id, slug, version, path, bytes, ctype, src_version)
     SELECT tenant_id, slug, ?4, path, bytes, ctype, src_version
     FROM files WHERE tenant_id = ?1 AND slug = ?2 AND version = ?3`,
  ).bind(tenantId, slug, site.current_version, version).run();

  await env.SITES.put(objectKey(tenantId, slug, version, path), bytes, {
    httpMetadata: { contentType: ctypeFor(path).ctype },
  });
  await env.DB.prepare(
    `INSERT INTO files (tenant_id, slug, version, path, bytes, ctype, src_version)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?3)
     ON CONFLICT(tenant_id, slug, version, path)
     DO UPDATE SET bytes = excluded.bytes, ctype = excluded.ctype, src_version = excluded.src_version`,
  ).bind(tenantId, slug, version, path, bytes.byteLength, ctypeFor(path).ctype).run();

  await env.DB.batch([
    env.DB.prepare(`UPDATE versions SET state = 'retired' WHERE tenant_id = ?1 AND slug = ?2 AND version != ?3 AND state = 'live'`)
      .bind(tenantId, slug, version),
    env.DB.prepare('UPDATE sites SET current_version = ?3, updated_at = ?4 WHERE tenant_id = ?1 AND slug = ?2')
      .bind(tenantId, slug, version, ts),
  ]);
  return true;
}

/**
 * POST /account/sites/:slug/pages — add a document.
 *
 * The new page goes live immediately with a heading taken from its name. The
 * alternative is a draft state, and the dashboard has no concept of one; a
 * stub page the owner is about to edit is easier to explain than a staging
 * area they cannot see.
 */
async function addPage(request, env, slug) {
  if (badOrigin(request, env)) return new Response('cross-site post rejected', { status: 403 });
  const current = await currentTenant(request, env);
  if (!current) return redirect('/signup');
  if (current.tenant.disabled_at) return redirect('/account');
  const tenantId = current.tenant.id;

  const editUrl = (q) => redirect(`/account/sites/${slug}/edit${q}`);
  const form = await request.formData().catch(() => null);
  let raw = String(form?.get('path') || '').trim();
  if (!raw) return editUrl('?err=name');
  if (!/\.(md|markdown)$/i.test(raw)) raw += '.md';

  const path = normalizePath(raw);
  if (!path || !isMarkdown(path) || path.length > 200) return editUrl('?err=name');

  const site = await env.DB.prepare(
    'SELECT current_version FROM sites WHERE tenant_id = ?1 AND slug = ?2',
  ).bind(tenantId, slug).first();
  if (!site || site.current_version == null) return redirect('/account');

  const clash = await env.DB.prepare(
    'SELECT path FROM files WHERE tenant_id = ?1 AND slug = ?2 AND version = ?3 AND path = ?4',
  ).bind(tenantId, slug, site.current_version, path).first();
  if (clash) return editUrl(`?path=${encodeURIComponent(path)}&err=exists`);

  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.(md|markdown)$/i, '');
  const heading = name.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const stub = `# ${heading}\n\n`;

  const ok = await publishFile(env, tenantId, slug, path, new TextEncoder().encode(stub));
  if (!ok) return redirect('/account');
  return editUrl(`?path=${encodeURIComponent(path)}&created=1`);
}

/** POST /account/sites/:slug/edit */
async function saveEdit(request, env, slug) {
  if (badOrigin(request, env)) return new Response('cross-site post rejected', { status: 403 });
  const current = await currentTenant(request, env);
  if (!current) return redirect('/signup');
  if (current.tenant.disabled_at) return redirect('/account');
  const tenantId = current.tenant.id;

  const form = await request.formData().catch(() => null);
  const path = normalizePath(String(form?.get('path') || ''));
  const content = String(form?.get('content') ?? '');
  if (!path || !isMarkdown(path)) return redirect(`/account/sites/${slug}/edit`);

  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > 1024 * 1024) {
    return authPage({
      status: 413, rootDomain: env.ROOT_DOMAIN, title: 'Too large',
      heading: 'Too large', bodyHtml: '<p class="lede">The editor caps a document at 1 MB.</p><p><a href="/account">Back</a></p>',
    });
  }

  const ok = await publishFile(env, tenantId, slug, path, bytes);
  if (!ok) return redirect('/account');
  return redirect(`/account/sites/${slug}/edit?path=${encodeURIComponent(path)}&saved=1`);
}

export async function handleAccount(request, env, pathname) {
  if (pathname === '/account' && request.method === 'GET') return dashboard(request, env);
  if (pathname === '/account/tokens' && request.method === 'POST') return createToken(request, env);
  const revoke = /^\/account\/tokens\/([A-Za-z0-9]{1,32})\/revoke$/.exec(pathname);
  if (revoke && request.method === 'POST') return revokeToken(request, env, revoke[1]);
  const vis = /^\/account\/sites\/([a-z0-9-]{1,63})\/visibility$/.exec(pathname);
  if (vis && request.method === 'POST') return changeVisibility(request, env, vis[1]);
  const edit = /^\/account\/sites\/([a-z0-9-]{1,63})\/edit$/.exec(pathname);
  if (edit && request.method === 'GET') return editor(request, env, edit[1], new URL(request.url));
  if (edit && request.method === 'POST') return saveEdit(request, env, edit[1]);
  const pages = /^\/account\/sites\/([a-z0-9-]{1,63})\/pages$/.exec(pathname);
  if (pages && request.method === 'POST') return addPage(request, env, pages[1]);
  const del = /^\/account\/sites\/([a-z0-9-]{1,63})\/delete$/.exec(pathname);
  if (del && request.method === 'GET') return confirmDelete(request, env, del[1]);
  if (del && request.method === 'POST') return performDelete(request, env, del[1]);
  if (pathname.startsWith('/account')) {
    return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
  }
  return null;
}

export { clearCookie };
