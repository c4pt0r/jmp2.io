import { clearCookie, readSession } from './auth.js';
import { mintToken } from './tokens.js';
import { hashPassword } from './password.js';
import { LIMITS as RATE, hit } from './ratelimit.js';
import { ctypeFor, escapeHtml, isMarkdown, normalizePath, now } from './util.js';
import { objectKey } from './serve.js';
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
  const session = await readSession(request, env.SESSION_SECRET);
  if (!session?.gh) return null;
  const tenant = await env.DB.prepare(
    'SELECT id, quota_bytes, disabled_at, disabled_reason FROM tenants WHERE owner_github_id = ?1',
  ).bind(session.gh).first();
  return tenant ? { tenant, session } : null;
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

  const gate = await hit(env, `mint:${current.session.gh}`, RATE.signup);
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

  const saved = url.searchParams.get('saved') === '1'
    ? '<div class="callout"><strong>Published.</strong> The previous version is still there to roll back to.</div>'
    : '';

  return authPage({
    rootDomain: env.ROOT_DOMAIN,
    wide: true,
    title: `Editing ${slug}`,
    heading: slug,
    bodyHtml: `${saved}
<div class="summary">
  <a class="host" href="https://${escapeHtml(tenantId)}.${escapeHtml(env.ROOT_DOMAIN)}/${escapeHtml(slug)}/">${escapeHtml(tenantId)}.${escapeHtml(env.ROOT_DOMAIN)}/${escapeHtml(slug)}/</a>
  <span class="stat">v${site.current_version}</span>
  <span class="stat">${editable.length} document${editable.length === 1 ? '' : 's'}</span>
</div>
<div class="filetabs">${tabs}</div>
<form method="post" action="/account/sites/${escapeHtml(slug)}/edit">
  <input type="hidden" name="path" value="${escapeHtml(chosen.path)}">
  <textarea name="content" rows="26" spellcheck="false" autofocus>${escapeHtml(source)}</textarea>
  <p class="actions">
    <button type="submit">Publish changes</button>
    <a class="btn btn-quiet" href="/account">Back to sites</a>
  </p>
  <p class="fine">Saving publishes a new version of the whole site.</p>
</form>`,
  });
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

  const site = await env.DB.prepare(
    'SELECT current_version FROM sites WHERE tenant_id = ?1 AND slug = ?2',
  ).bind(tenantId, slug).first();
  if (!site || site.current_version == null) return redirect('/account');

  // Copy the live manifest into a fresh version, overwrite the one file, then
  // flip the pointer — the same copy-on-write publish the API performs.
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
  if (pathname.startsWith('/account')) {
    return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
  }
  return null;
}

export { clearCookie };
