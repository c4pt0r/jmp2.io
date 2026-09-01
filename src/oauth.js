import { clearCookie, readSession, setCookie, sign, verify } from './auth.js';
import { mintToken } from './tokens.js';
import { LIMITS, clientIp, hit } from './ratelimit.js';
import { RESERVED_SUBDOMAINS, escapeHtml, isValidTenantId, now } from './util.js';
import { authPage } from './theme.js';

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';

const STATE_TTL = 600;      // 10 minutes to complete the round trip
// Long enough that the dashboard is not a re-login every visit. The cookie is
// stateless, so this is also how long a stolen cookie stays valid; tenant state
// (suspension, ownership) is re-read from the database on every page.
const SESSION_TTL = 86400;

const configured = (env) => Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.SESSION_SECRET);

const redirect = (to, headers = {}) =>
  new Response(null, { status: 302, headers: { location: to, ...headers } });

const notConfigured = () => authPage({
  status: 503,
  title: 'Signup unavailable',
  heading: 'Signup is not configured',
  bodyHtml: '<p class="lede">This deployment has no GitHub OAuth credentials set. Ask the operator for an invite instead.</p>',
});

/** GET /auth/github — start the round trip. */
async function start(env) {
  const state = crypto.randomUUID();
  const cookie = await sign({ state, exp: now() + STATE_TTL }, env.SESSION_SECRET);
  const url = new URL(GITHUB_AUTHORIZE);
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', `https://${env.ROOT_DOMAIN}/auth/github/callback`);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', ''); // identity only; no repo or email access
  url.searchParams.set('allow_signup', 'false');
  return redirect(url.toString(), { 'set-cookie': setCookie(cookie, STATE_TTL) });
}

/** GET /auth/github/callback — verify state, exchange the code, remember who it is. */
async function callback(request, env, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const pending = await readSession(request, env.SESSION_SECRET);

  if (!code || !state || !pending?.state || pending.state !== state) {
    return authPage({
      status: 400, title: 'Sign-in failed', heading: 'Sign-in failed',
      bodyHtml: '<p class="lede">That sign-in link expired or did not match. Start again.</p><p><a href="/signup">Back to signup</a></p>',
      headers: { 'set-cookie': clearCookie() },
    });
  }

  const tokenRes = await fetch(GITHUB_TOKEN, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'jmp2' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `https://${env.ROOT_DOMAIN}/auth/github/callback`,
    }),
  });
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenBody.access_token) {
    return authPage({
      status: 502, title: 'Sign-in failed', heading: 'GitHub would not issue a token',
      bodyHtml: `<p class="lede">${escapeHtml(tokenBody.error_description || 'Try again in a moment.')}</p><p><a href="/signup">Back to signup</a></p>`,
      headers: { 'set-cookie': clearCookie() },
    });
  }

  const userRes = await fetch(GITHUB_USER, {
    headers: {
      authorization: `Bearer ${tokenBody.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'jmp2',
    },
  });
  const user = await userRes.json().catch(() => ({}));
  if (!user.id) {
    return authPage({
      status: 502, title: 'Sign-in failed', heading: 'Could not read your GitHub account',
      bodyHtml: '<p class="lede">Try again in a moment.</p><p><a href="/signup">Back to signup</a></p>',
      headers: { 'set-cookie': clearCookie() },
    });
  }

  // The GitHub access token is deliberately not kept: identity is all we wanted.
  const session = await sign(
    { gh: String(user.id), login: user.login, exp: now() + SESSION_TTL },
    env.SESSION_SECRET,
  );
  return redirect('/signup', { 'set-cookie': setCookie(session, SESSION_TTL) });
}

const signedOutPage = (rootDomain) => authPage({
  rootDomain,
  title: 'Get a subdomain',
  heading: 'Claim your subdomain',
  bodyHtml: `<p class="lede">Sign in with GitHub, pick a name, and push markdown to it.
    We read your public account id and nothing else — no repository access, no email.</p>
  <p><a class="button" href="/auth/github">Sign in with GitHub</a></p>`,
});

function claimFormPage(login, rootDomain, error) {
  return authPage({
    rootDomain,
    title: 'Pick a subdomain',
    heading: `Hi ${login}`,
    bodyHtml: `${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <p class="lede">Pick the subdomain you want. This is permanent, so choose carefully.</p>
  <form method="post" action="/auth/claim">
    <label>
      <input name="subdomain" placeholder="your-name" maxlength="63"
             pattern="[a-z0-9][a-z0-9-]{1,62}" required autofocus>
      <span class="suffix">.${escapeHtml(rootDomain)}</span>
    </label>
    <button type="submit">Claim it</button>
  </form>
  <p class="fine">Lowercase letters, digits and hyphens. 2-63 characters.</p>`,
  });
}

function issuedPage(tenantId, rootDomain, token) {
  const cli = rootDomain.split('.')[0];
  return authPage({
    rootDomain,
    title: 'You are set up',
    heading: `${tenantId}.${rootDomain} is yours`,
    bodyHtml: `<p class="lede">Copy this token now. It is shown once and cannot be recovered — mint a new one if you lose it.</p>
  <pre><code>${escapeHtml(token)}</code></pre>
  <h2>Publish something</h2>
  <pre><code>mkdir -p ~/.${escapeHtml(cli)} &amp;&amp; echo '${escapeHtml(token)}' > ~/.${escapeHtml(cli)}/token
chmod 600 ~/.${escapeHtml(cli)}/token

tar czf - ./docs | curl -T - https://${escapeHtml(rootDomain)}/_api/sites/handbook/tarball \\
  -H "Authorization: Bearer ${escapeHtml(token)}"</code></pre>
  <p>Then it is live at <a href="https://${escapeHtml(tenantId)}.${escapeHtml(rootDomain)}/handbook/">${escapeHtml(tenantId)}.${escapeHtml(rootDomain)}/handbook/</a>.</p>
  <p><a href="/account">Go to your dashboard</a></p>`,
  });
}

/** GET /signup — one page that adapts to what we know about the visitor. */
async function signup(request, env) {
  if (!configured(env)) return notConfigured();
  const session = await readSession(request, env.SESSION_SECRET);
  if (!session?.gh) return signedOutPage(env.ROOT_DOMAIN);

  const owned = await env.DB.prepare('SELECT id FROM tenants WHERE owner_github_id = ?1')
    .bind(session.gh).first();
  return owned ? redirect('/account') : claimFormPage(session.login || 'there', env.ROOT_DOMAIN);
}

/** POST /auth/claim — create the tenant and hand over the first token. */
async function claim(request, env) {
  if (!configured(env)) return notConfigured();

  // SameSite=Lax already blocks cross-site form posts; this makes it explicit.
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).hostname !== env.ROOT_DOMAIN) {
    return authPage({ status: 403, title: 'Blocked', heading: 'Blocked', bodyHtml: '<p class="lede">Cross-site form post rejected.</p>' });
  }

  const session = await readSession(request, env.SESSION_SECRET);
  if (!session?.gh) return redirect('/signup');

  const gate = await hit(env, `signup:${clientIp(request)}`, LIMITS.signup);
  if (!gate.ok) {
    return authPage({
      status: 429, title: 'Slow down', heading: 'Too many attempts',
      bodyHtml: '<p class="lede">Try again later.</p>',
    });
  }

  const form = await request.formData().catch(() => null);
  const wanted = String(form?.get('subdomain') || '').trim().toLowerCase();

  if (!isValidTenantId(wanted)) {
    const why = RESERVED_SUBDOMAINS.has(wanted)
      ? 'That name is reserved.'
      : 'Use 2-63 characters: lowercase letters, digits, and hyphens, not starting or ending with a hyphen.';
    return claimFormPage(session.login || 'there', env.ROOT_DOMAIN, why);
  }

  const taken = await env.DB.prepare('SELECT id FROM tenants WHERE id = ?1').bind(wanted).first();
  if (taken) {
    return claimFormPage(session.login || 'there', env.ROOT_DOMAIN, `${wanted}.${env.ROOT_DOMAIN} is taken.`);
  }

  const already = await env.DB.prepare('SELECT id FROM tenants WHERE owner_github_id = ?1')
    .bind(session.gh).first();
  if (already) return redirect('/account');

  try {
    await env.DB.prepare(
      `INSERT INTO tenants (id, name, created_at, owner_github_id, owner_github_login)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(wanted, session.login || null, now(), session.gh, session.login || null).run();
  } catch {
    // Unique index on id or owner_github_id lost a race.
    return claimFormPage(session.login || 'there', env.ROOT_DOMAIN, 'That name was just taken. Try another.');
  }

  const { token } = await mintToken(env, wanted, 'signup');
  return issuedPage(wanted, env.ROOT_DOMAIN, token);
}

/** GET /auth/mint — recovery path for someone who lost every token they had. */
async function mint(request, env) {
  if (!configured(env)) return notConfigured();
  const session = await readSession(request, env.SESSION_SECRET);
  if (!session?.gh) return redirect('/auth/github');

  const owned = await env.DB.prepare('SELECT id FROM tenants WHERE owner_github_id = ?1')
    .bind(session.gh).first();
  if (!owned) return redirect('/signup');

  const gate = await hit(env, `mint:${session.gh}`, LIMITS.signup);
  if (!gate.ok) {
    return authPage({ status: 429, title: 'Slow down', heading: 'Too many tokens', bodyHtml: '<p class="lede">Try again later.</p>' });
  }

  const { token } = await mintToken(env, owned.id, 'recovery');
  return issuedPage(owned.id, env.ROOT_DOMAIN, token);
}

/** Routes served on the apex for the browser-facing signup flow. */
export async function handleAuth(request, env, pathname) {
  if (pathname === '/signup') return signup(request, env);
  if (pathname === '/auth/github' && request.method === 'GET') {
    return configured(env) ? start(env) : notConfigured();
  }
  if (pathname === '/auth/github/callback' && request.method === 'GET') {
    return configured(env) ? callback(request, env, new URL(request.url)) : notConfigured();
  }
  if (pathname === '/auth/claim' && request.method === 'POST') return claim(request, env);
  if (pathname === '/auth/mint' && request.method === 'GET') return mint(request, env);
  if (pathname === '/auth/signout') {
    return redirect('/', { 'set-cookie': clearCookie() });
  }
  return null;
}

export const AUTH_PATHS = ['/signup', '/auth/github', '/auth/github/callback', '/auth/claim', '/auth/mint', '/auth/signout'];
