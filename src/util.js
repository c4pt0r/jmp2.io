export const now = () => Math.floor(Date.now() / 1000);

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body, null, 2) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export const err = (status, message, extra = {}, headers = {}) =>
  json({ error: message, ...extra }, status, headers);

export async function sha256hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const B62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export function randomToken(bytes = 32) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => B62[b % 62]).join('');
}

/** Constant-time compare so admin-token checks don't leak a prefix by timing. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Normalize a user-supplied file path into an R2-safe relative key.
 * Returns null if the path is unsafe. This is the boundary that stops `../`
 * from escaping a site's key prefix, so it rejects rather than repairs.
 */
export function normalizePath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) return null;
  if (raw.includes('\\')) return null;
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  const p = raw.replace(/^\.\//, '').replace(/^\/+/, '');
  if (p.includes('//')) return null;
  const parts = p.split('/');
  for (const seg of parts) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (seg.length > 255) return null;
  }
  return parts.join('/');
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const isValidSlug = (s) => typeof s === 'string' && SLUG_RE.test(s) && !s.endsWith('-');

/**
 * Subdomains that must never become a tenant: infrastructure names, plus
 * brand-adjacent words that would make a phishing URL look official.
 */
export const RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'admin', 'app', 'assets', 'cdn', 'dash', 'dashboard', 'dev',
  'docs', 'ftp', 'go', 'help', 'host', 'id', 'imap', 'internal', 'jmp2',
  'login', 'mail', 'mx', 'ns', 'ns1', 'ns2', 'pay', 'pop', 'raw', 'root',
  'secure', 'signin', 'signup', 'smtp', 'ssl', 'static', 'status', 'support',
  'test', 'staging', 'verify', 'webmail', 'wallet',
]);

export const isValidTenantId = (s) =>
  isValidSlug(s) && s.length >= 2 && !RESERVED_SUBDOMAINS.has(s);

const TEXT = 'charset=utf-8';

/**
 * Content type policy. Two rules matter more than the table itself:
 *   1. Never return user content as text/html. Tenant subdomains are free
 *      hosting with a real certificate, so an attacker-controlled HTML page
 *      would be a phishing page. .html/.htm are served as text/plain.
 *   2. Anything unrecognized downloads instead of rendering.
 * SVG is allowed to render: it can carry script, but each tenant is its own
 * browser origin, so the blast radius is the tenant's own site.
 */
const CTYPES = {
  md: `text/plain; ${TEXT}`, markdown: `text/plain; ${TEXT}`, txt: `text/plain; ${TEXT}`,
  html: `text/plain; ${TEXT}`, htm: `text/plain; ${TEXT}`, xml: `text/plain; ${TEXT}`,
  css: `text/css; ${TEXT}`, js: `text/javascript; ${TEXT}`, mjs: `text/javascript; ${TEXT}`,
  json: `application/json; ${TEXT}`, csv: `text/csv; ${TEXT}`,
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  pdf: 'application/pdf',
};

export function extOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function ctypeFor(path) {
  const ct = CTYPES[extOf(path)];
  return ct
    ? { ctype: ct, download: false }
    : { ctype: 'application/octet-stream', download: true };
}

export const isMarkdown = (path) => ['md', 'markdown'].includes(extOf(path));

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
