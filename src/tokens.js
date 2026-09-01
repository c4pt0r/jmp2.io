import { now, randomToken, sha256hex } from './util.js';

/**
 * Tokens carry a fixed, deployment-specific prefix. It makes a leaked token
 * recognizable in logs and secret scanners, and it follows ROOT_DOMAIN so a
 * fork's tokens name the fork rather than this repo.
 */
export const tokenPrefix = (rootDomain = '') =>
  `${(rootDomain.split('.')[0] || 'site').replace(/[^a-z0-9]/gi, '').toLowerCase()}_live_`;

/**
 * Mint a site token. The plaintext is returned once and never stored — only its
 * SHA-256 and a short public id used for listing and revocation.
 */
export async function mintToken(env, tenantId, name = null, expiresAt = null) {
  const plaintext = tokenPrefix(env.ROOT_DOMAIN) + randomToken(32);
  const id = randomToken(8);
  await env.DB.prepare(
    `INSERT INTO tokens (hash, id, tenant_id, name, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(await sha256hex(plaintext), id, tenantId, name, now(), expiresAt).run();
  return { token: plaintext, id };
}
