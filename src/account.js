import { clearCookie, readSession } from './auth.js';
import { mintToken } from './tokens.js';
import { LIMITS as RATE, hit } from './ratelimit.js';
import { escapeHtml, now } from './util.js';
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

function sitesSection(sites, tenantId, rootDomain) {
  if (!sites.length) {
    return `<p class="lede">Nothing published yet. Push a folder and it appears here.</p>
<pre><code>tar czf - ./docs | curl -T - https://${escapeHtml(rootDomain)}/_api/sites/handbook/tarball \\
  -H "Authorization: Bearer $JMP2_TOKEN"</code></pre>`;
  }
  const rows = sites.map((s) => {
    const url = `https://${tenantId}.${rootDomain}/${s.slug}/`;
    const live = s.current_version != null;
    return `<tr>
  <td>${live ? `<a href="${escapeHtml(url)}">${escapeHtml(s.slug)}</a>` : escapeHtml(s.slug)}
      ${s.title && s.title !== s.slug ? `<div class="sub">${escapeHtml(s.title)}</div>` : ''}</td>
  <td>${live ? `v${s.current_version}` : '<span class="sub">draft</span>'}</td>
  <td>${s.file_count ?? 0}</td>
  <td>${humanBytes(s.bytes ?? 0)}</td>
  <td class="sub">${escapeHtml(humanWhen(s.updated_at))}</td>
</tr>`;
  }).join('');
  return `<table>
<thead><tr><th>Site</th><th>Version</th><th>Files</th><th>Size</th><th>Updated</th></tr></thead>
<tbody>${rows}</tbody></table>`;
}

function tokensSection(tokens) {
  const rows = tokens.map((t) => `<tr>
  <td><code>${escapeHtml(t.id || '—')}</code>
      ${t.name ? `<div class="sub">${escapeHtml(t.name)}</div>` : ''}</td>
  <td class="sub">${escapeHtml(humanWhen(t.created_at))}</td>
  <td class="sub">${escapeHtml(humanWhen(t.last_used_at))}</td>
  <td>${t.revoked_at
    ? '<span class="sub">revoked</span>'
    : `<form method="post" action="/account/tokens/${escapeHtml(t.id)}/revoke" class="inline">
         <button class="danger" type="submit">Revoke</button></form>`}</td>
</tr>`).join('');
  return `<table>
<thead><tr><th>Token</th><th>Created</th><th>Last used</th><th></th></tr></thead>
<tbody>${rows}</tbody></table>
<form method="post" action="/account/tokens" class="inline">
  <input type="hidden" name="name" value="dashboard">
  <button type="submit">Mint a new token</button>
</form>`;
}

function dashboardHtml({ tenant, rootDomain, sites, tokens, usedBytes, freshToken }) {
  const pct = Math.min(100, Math.round((usedBytes / tenant.quota_bytes) * 100));
  const home = `https://${tenant.id}.${rootDomain}/`;

  const suspended = tenant.disabled_at
    ? `<p class="error">This subdomain is suspended${tenant.disabled_reason ? `: ${escapeHtml(tenant.disabled_reason)}` : ''}.</p>`
    : '';

  const minted = freshToken
    ? `<div class="callout">
  <strong>Copy this token now.</strong> It is shown once and cannot be recovered.
  <pre><code>${escapeHtml(freshToken)}</code></pre>
</div>`
    : '';

  return `${suspended}${minted}
<p class="lede">Your sites live at <a href="${escapeHtml(home)}">${escapeHtml(tenant.id)}.${escapeHtml(rootDomain)}</a>.</p>

<div class="meter" title="${usedBytes} of ${tenant.quota_bytes} bytes">
  <div class="meter-fill" style="width:${pct}%"></div>
</div>
<p class="sub">${humanBytes(usedBytes)} of ${humanBytes(tenant.quota_bytes)} used · ${sites.length} site${sites.length === 1 ? '' : 's'}</p>

<h2>Sites</h2>
${sitesSection(sites, tenant.id, rootDomain)}

<h2>Tokens</h2>
<p class="sub">Tokens are stored hashed, so the value is only ever shown once. Revoking takes effect immediately.</p>
${tokensSection(tokens)}

<h2>Publish</h2>
<pre><code>tar czf - ./docs | curl -T - https://${escapeHtml(rootDomain)}/_api/sites/handbook/tarball \\
  -H "Authorization: Bearer $JMP2_TOKEN"</code></pre>

<p><a href="/auth/signout">Sign out</a></p>`;
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

export async function handleAccount(request, env, pathname) {
  if (pathname === '/account' && request.method === 'GET') return dashboard(request, env);
  if (pathname === '/account/tokens' && request.method === 'POST') return createToken(request, env);
  const revoke = /^\/account\/tokens\/([A-Za-z0-9]{1,32})\/revoke$/.exec(pathname);
  if (revoke && request.method === 'POST') return revokeToken(request, env, revoke[1]);
  if (pathname.startsWith('/account')) {
    return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
  }
  return null;
}

export { clearCookie };
