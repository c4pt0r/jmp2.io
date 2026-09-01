/**
 * Signed-cookie sessions for the browser-facing signup flow.
 *
 * The API itself is bearer-token only and stateless; these sessions exist just
 * to carry a verified GitHub identity from the OAuth callback to the moment the
 * user picks a subdomain. They are HMAC-signed rather than stored, so nothing
 * has to be cleaned up and a lost session simply means signing in again.
 */

const enc = new TextEncoder();

const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64url = (s) => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

async function key(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** `<payload>.<sig>`, both base64url. */
export async function sign(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** Verify and decode; returns null on any tampering, malformed input, or expiry. */
export async function verify(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(secret), unb64url(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64url(body)));
    if (payload.exp && payload.exp < nowSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}

export const COOKIE = '__Host-jmp2_session';

export function readCookie(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * `__Host-` requires Secure and Path=/ with no Domain, which also pins the
 * cookie to the apex — tenant subdomains can never see or set it.
 */
export const setCookie = (value, maxAgeSeconds) =>
  `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;

export const clearCookie = () => `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

export const readSession = (request, secret) => verify(readCookie(request, COOKIE), secret);
