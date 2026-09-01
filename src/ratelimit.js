/**
 * Fixed-window rate limiting backed by D1.
 *
 * Only the write API and the signup flow are counted: reads are served from the
 * edge cache and mostly never reach the Worker, let alone the database. A fixed
 * window lets one row and one statement do the whole job, at the cost of
 * allowing up to 2x the limit across a window boundary — fine for abuse
 * control, which is what this is for.
 */

export const LIMITS = {
  write: { limit: 120, windowSeconds: 60 },  // per tenant
  signup: { limit: 10, windowSeconds: 3600 }, // per IP
  admin: { limit: 60, windowSeconds: 60 },
};

/**
 * Count one hit against `key` and report whether it is over the limit.
 * Failures are treated as allowed: a rate limiter that is down should not take
 * the whole service with it.
 *
 * @returns {Promise<{ok: boolean, remaining: number, resetAt: number}>}
 */
export async function hit(env, key, { limit, windowSeconds }, nowSeconds = Math.floor(Date.now() / 1000)) {
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const resetAt = windowStart + windowSeconds;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start < ?2 THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.window_start < ?2 THEN ?2 ELSE rate_limits.window_start END
       RETURNING count`,
    ).bind(key, windowStart).first();
    const count = row?.count ?? 1;
    return { ok: count <= limit, remaining: Math.max(0, limit - count), resetAt };
  } catch (e) {
    console.error('rate limit unavailable', key, e?.message);
    return { ok: true, remaining: limit, resetAt };
  }
}

export const clientIp = (request) =>
  request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';

export const retryHeaders = ({ resetAt }, nowSeconds = Math.floor(Date.now() / 1000)) => ({
  'retry-after': String(Math.max(1, resetAt - nowSeconds)),
});
