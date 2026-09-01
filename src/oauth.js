import { clearCookie, readSession, setCookie, sign } from './auth.js';
import { mintToken } from './tokens.js';
import { LIMITS, clientIp, hit } from './ratelimit.js';
import { RESERVED_SUBDOMAINS, escapeHtml, isValidTenantId, now } from './util.js';
import { authPage } from './theme.js';
import { PROVIDERS, enabledProviders, providerConfigured } from './providers.js';

const STATE_TTL = 600;      // 10 minutes to complete the round trip
// Long enough that the dashboard is not a re-login every visit. The cookie is
// stateless, so this is also how long a stolen cookie stays valid; tenant state
// (suspension, ownership) is re-read from the database on every page.
const SESSION_TTL = 86400;

const redirect = (to, headers = {}) =>
  new Response(null, { status: 302, headers: { location: to, ...headers } });

const callbackUrl = (env, provider) => `https://${env.ROOT_DOMAIN}/auth/${provider}/callback`;

const notConfigured = () => authPage({
  status: 503,
  title: 'Signup unavailable',
  heading: 'Signup is not configured',
  bodyHtml: '<p class="lede">This deployment has no sign-in provider set up. Ask the operator for an invite instead.</p>',
});

const failed = (heading, detail) => authPage({
  status: 400, title: 'Sign-in failed', heading,
  bodyHtml: `<p class="lede">${escapeHtml(detail)}</p><p><a href="/signup">Back to signup</a></p>`,
  headers: { 'set-cookie': clearCookie() },
});

/**
 * The signed-in identity, tolerating the shape used before a second provider
 * existed so nobody is logged out by the upgrade.
 */
export function sessionIdentity(session) {
  if (!session) return null;
  if (session.p && session.s) return { provider: session.p, subject: session.s, label: session.login };
  if (session.gh) return { provider: 'github', subject: session.gh, label: session.login };
  return null;
}

const ownerOf = (env, identity) => env.DB.prepare(
  'SELECT id FROM tenants WHERE owner_provider = ?1 AND owner_subject = ?2',
).bind(identity.provider, identity.subject).first();

/** GET /auth/:provider — start the round trip. */
async function start(env, provider) {
  const state = crypto.randomUUID();
  // The provider is carried in the signed cookie, not just the path: the
  // callback has to know which one it is talking to before it trusts the URL.
  const cookie = await sign({ state, p: provider, exp: now() + STATE_TTL }, env.SESSION_SECRET);
  return redirect(
    PROVIDERS[provider].authorizeUrl(env, { redirectUri: callbackUrl(env, provider), state }),
    { 'set-cookie': setCookie(cookie, STATE_TTL) },
  );
}

/** GET /auth/:provider/callback — verify state, exchange the code, remember who it is. */
async function callback(request, env, provider, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const pending = await readSession(request, env.SESSION_SECRET);

  if (!code || !state || !pending?.state || pending.state !== state || pending.p !== provider) {
    return failed('Sign-in failed', 'That sign-in link expired or did not match. Start again.');
  }

  const result = await PROVIDERS[provider].identify(env, {
    code, redirectUri: callbackUrl(env, provider),
  });
  if (result.error) return failed('Sign-in failed', result.error);

  // The provider's access token is deliberately not kept: identity is all we
  // wanted, and a token we do not hold is a token that cannot leak.
  const session = await sign(
    { p: provider, s: result.subject, login: result.label, exp: now() + SESSION_TTL },
    env.SESSION_SECRET,
  );
  return redirect('/signup', { 'set-cookie': setCookie(session, SESSION_TTL) });
}

const signedOutPage = (env) => {
  const buttons = enabledProviders(env).map((name, i) =>
    `<a class="btn${i ? ' btn-quiet' : ''}" href="/auth/${name}">Continue with ${PROVIDERS[name].label}</a>`,
  ).join('');
  return authPage({
    rootDomain: env.ROOT_DOMAIN,
    title: 'Get a subdomain',
    heading: 'Claim your subdomain',
    bodyHtml: `<p class="lede">Sign in, pick a name, and push markdown to it. We read the
  account identifier and nothing else — no repositories, no contacts, no mail.</p>
  <p class="actions">${buttons}</p>`,
  });
};

function claimFormPage(env, label, error) {
  return authPage({
    rootDomain: env.ROOT_DOMAIN,
    title: 'Pick a subdomain',
    heading: `Hi ${label}`,
    bodyHtml: `${error ? `<div class="callout"><strong>${escapeHtml(error)}</strong></div>` : ''}
  <p class="lede">Pick the subdomain you want. This is permanent, so choose carefully.</p>
  <form method="post" action="/auth/claim">
    <label>
      <input name="subdomain" placeholder="your-name" maxlength="63"
             pattern="[a-z0-9][a-z0-9-]{1,62}" required autofocus>
      <span class="suffix">.${escapeHtml(env.ROOT_DOMAIN)}</span>
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
    bodyHtml: `<div class="callout"><strong>Copy this token now.</strong> It is shown once and cannot be recovered.
  <pre><code>${escapeHtml(token)}</code></pre></div>
  <h2>Publish something</h2>
  <pre><code>mkdir -p ~/.${escapeHtml(cli)} &amp;&amp; echo '${escapeHtml(token)}' > ~/.${escapeHtml(cli)}/token
chmod 600 ~/.${escapeHtml(cli)}/token

tar czf - ./docs | curl -T - https://${escapeHtml(rootDomain)}/_api/sites/handbook/tarball \\
  -H "Authorization: Bearer ${escapeHtml(token)}"</code></pre>
  <p class="actions"><a class="btn" href="/account">Go to your dashboard</a></p>`,
  });
}

/** GET /signup — one page that adapts to what we know about the visitor. */
async function signup(request, env) {
  if (!enabledProviders(env).length) return notConfigured();
  const identity = sessionIdentity(await readSession(request, env.SESSION_SECRET));
  if (!identity) return signedOutPage(env);
  return (await ownerOf(env, identity)) ? redirect('/account') : claimFormPage(env, identity.label || 'there');
}

/** POST /auth/claim — create the tenant and hand over the first token. */
async function claim(request, env) {
  if (!enabledProviders(env).length) return notConfigured();

  // SameSite=Lax already blocks cross-site form posts; this makes it explicit.
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).hostname !== env.ROOT_DOMAIN) {
    return authPage({ status: 403, title: 'Blocked', heading: 'Blocked', bodyHtml: '<p class="lede">Cross-site form post rejected.</p>' });
  }

  const identity = sessionIdentity(await readSession(request, env.SESSION_SECRET));
  if (!identity) return redirect('/signup');

  const gate = await hit(env, `signup:${clientIp(request)}`, LIMITS.signup);
  if (!gate.ok) {
    return authPage({
      status: 429, title: 'Slow down', heading: 'Too many attempts',
      bodyHtml: '<p class="lede">Try again later.</p>',
    });
  }

  const form = await request.formData().catch(() => null);
  const wanted = String(form?.get('subdomain') || '').trim().toLowerCase();
  const label = identity.label || 'there';

  if (!isValidTenantId(wanted)) {
    return claimFormPage(env, label, RESERVED_SUBDOMAINS.has(wanted)
      ? 'That name is reserved.'
      : 'Use 2-63 characters: lowercase letters, digits, and hyphens, not starting or ending with a hyphen.');
  }

  const taken = await env.DB.prepare('SELECT id FROM tenants WHERE id = ?1').bind(wanted).first();
  if (taken) return claimFormPage(env, label, `${wanted}.${env.ROOT_DOMAIN} is taken.`);
  if (await ownerOf(env, identity)) return redirect('/account');

  try {
    await env.DB.prepare(
      `INSERT INTO tenants (id, name, created_at, owner_provider, owner_subject, owner_label)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(wanted, identity.label || null, now(), identity.provider, identity.subject, identity.label || null).run();
  } catch {
    // A unique index on the id or the owner lost a race.
    return claimFormPage(env, label, 'That name was just taken. Try another.');
  }

  const { token } = await mintToken(env, wanted, 'signup');
  return issuedPage(wanted, env.ROOT_DOMAIN, token);
}

/** GET /auth/mint — recovery path for someone who lost every token they had. */
async function mint(request, env) {
  if (!enabledProviders(env).length) return notConfigured();
  const identity = sessionIdentity(await readSession(request, env.SESSION_SECRET));
  if (!identity) return redirect('/signup');

  const owned = await ownerOf(env, identity);
  if (!owned) return redirect('/signup');

  const gate = await hit(env, `mint:${identity.provider}:${identity.subject}`, LIMITS.signup);
  if (!gate.ok) {
    return authPage({ status: 429, title: 'Slow down', heading: 'Too many tokens', bodyHtml: '<p class="lede">Try again later.</p>' });
  }

  const { token } = await mintToken(env, owned.id, 'recovery');
  return issuedPage(owned.id, env.ROOT_DOMAIN, token);
}

/** Routes served on the apex for the browser-facing signup flow. */
export async function handleAuth(request, env, pathname) {
  if (pathname === '/signup') return signup(request, env);
  if (pathname === '/auth/claim' && request.method === 'POST') return claim(request, env);
  if (pathname === '/auth/mint' && request.method === 'GET') return mint(request, env);
  if (pathname === '/auth/signout') return redirect('/', { 'set-cookie': clearCookie() });

  const match = /^\/auth\/([a-z]+)(\/callback)?$/.exec(pathname);
  if (match && request.method === 'GET') {
    const [, provider, isCallback] = match;
    if (!PROVIDERS[provider]) return null;
    if (!providerConfigured(env, provider) || !env.SESSION_SECRET) return notConfigured();
    return isCallback
      ? callback(request, env, provider, new URL(request.url))
      : start(env, provider);
  }
  return null;
}
