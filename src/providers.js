/**
 * Identity providers for signup.
 *
 * Each one turns an authorization code into a stable `(provider, subject)` pair
 * and a human label. Nothing else about the account is kept — no access token,
 * no email stored, no scopes beyond identity — so adding a provider is a matter
 * of describing its three endpoints rather than teaching the rest of the app
 * anything new.
 */

const json = async (res) => res.json().catch(() => ({}));

export const PROVIDERS = {
  github: {
    label: 'GitHub',
    idVar: 'GITHUB_CLIENT_ID',
    secretVar: 'GITHUB_CLIENT_SECRET',

    authorizeUrl(env, { redirectUri, state }) {
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('scope', ''); // identity only
      url.searchParams.set('allow_signup', 'false');
      return url.toString();
    },

    async identify(env, { code, redirectUri }) {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'jmp2' },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const token = await json(tokenRes);
      if (!token.access_token) return { error: token.error_description || 'GitHub would not issue a token.' };

      const user = await json(await fetch('https://api.github.com/user', {
        headers: {
          authorization: `Bearer ${token.access_token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'jmp2',
        },
      }));
      if (!user.id) return { error: 'Could not read your GitHub account.' };
      return { subject: String(user.id), label: user.login || null };
    },

    /**
     * Whether a handle is even shaped like one. Kept separate from `lookup` so
     * the caller can tell "you sent nonsense" (400) from "no such user" (404),
     * and so obviously bad input never becomes an outbound request.
     */
    validHandle: (login) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login),

    /** Resolve a human-typed handle to a subject, for the admin claim endpoint. */
    async lookup(login) {
      const res = await fetch(`https://api.github.com/users/${login}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'jmp2' },
      });
      if (!res.ok) return null;
      const user = await json(res);
      return user.id ? { subject: String(user.id), label: user.login } : null;
    },
  },

  google: {
    label: 'Google',
    idVar: 'GOOGLE_CLIENT_ID',
    secretVar: 'GOOGLE_CLIENT_SECRET',

    authorizeUrl(env, { redirectUri, state }) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('state', state);
      // `openid` alone yields the stable subject; `email` only supplies a label.
      url.searchParams.set('scope', 'openid email');
      url.searchParams.set('prompt', 'select_account');
      return url.toString();
    },

    async identify(env, { code, redirectUri }) {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const token = await json(tokenRes);
      if (!token.access_token) return { error: token.error_description || 'Google would not issue a token.' };

      const user = await json(await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' },
      }));
      // `sub` is the only field Google guarantees is stable; an email address
      // can be reassigned within a workspace, so it is a label and nothing more.
      if (!user.sub) return { error: 'Could not read your Google account.' };
      return { subject: String(user.sub), label: user.email || user.name || null };
    },
  },
};

export const providerConfigured = (env, name) => {
  const p = PROVIDERS[name];
  return Boolean(p && env[p.idVar] && env[p.secretVar]);
};

/** The providers this deployment can actually offer, in a stable order. */
export const enabledProviders = (env) =>
  Object.keys(PROVIDERS).filter((name) => providerConfigured(env, name) && env.SESSION_SECRET);
