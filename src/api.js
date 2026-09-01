import {
  ctypeFor, err, isValidSlug, isValidTenantId, json, normalizePath, now,
  safeEqual, sha256hex,
} from './util.js';
import { maybeGunzip, parseTar, stripCommonPrefix } from './tar.js';
import { mintToken } from './tokens.js';
import { hashPassword } from './password.js';
import { LIMITS as RATE, clientIp, hit, retryHeaders } from './ratelimit.js';
import { splitFrontmatter } from './render.js';
import { objectKey } from './serve.js';

export const LIMITS = {
  uploadBytes: 25 * 1024 * 1024, // one tarball, compressed or not
  fileBytes: 10 * 1024 * 1024,
  fileCount: 2000,
  keepVersions: 3,
};

/** Resolve a bearer token to its tenant, or null. */
async function authenticate(request, env) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  const hash = await sha256hex(match[1]);
  const row = await env.DB.prepare(
    `SELECT t.hash, t.id, t.tenant_id, t.name, t.expires_at, t.revoked_at,
            n.quota_bytes, n.disabled_at, n.disabled_reason
     FROM tokens t JOIN tenants n ON n.id = t.tenant_id
     WHERE t.hash = ?1`,
  ).bind(hash).first();
  if (!row || row.revoked_at) return null;
  if (row.expires_at && row.expires_at < now()) return null;
  return row;
}

/**
 * Bytes this tenant actually occupies in R2. Versions share objects, so the sum
 * has to be over distinct (slug, src_version, path) rather than over manifest
 * rows, which would count an inherited file once per version that points at it.
 */
async function tenantUsage(env, tenantId) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(bytes), 0) AS b FROM (
       SELECT DISTINCT slug, src_version, path, bytes
       FROM files WHERE tenant_id = ?1
     )`,
  ).bind(tenantId).first();
  return row?.b ?? 0;
}

const isAdmin = (request, env) => {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '');
  return Boolean(env.ADMIN_TOKEN) && Boolean(match) && safeEqual(match[1], env.ADMIN_TOKEN);
};

const findStaging = (env, tenantId, slug) => env.DB.prepare(
  `SELECT version FROM versions
   WHERE tenant_id = ?1 AND slug = ?2 AND state = 'staging'
   ORDER BY version DESC LIMIT 1`,
).bind(tenantId, slug).first();

/**
 * Find the site's open staging version, creating one if needed. Staging is
 * additive across calls so a folder can arrive as many separate PUTs and only
 * become visible when `publish` flips the pointer.
 *
 * With `inherit`, a new staging version starts as a copy of the live version's
 * manifest — rows only, no object copies — so editing one file of a large site
 * republishes the whole site rather than reducing it to that one file.
 */
async function openStaging(env, tenantId, slug, { inherit = false } = {}) {
  const site = await env.DB.prepare(
    'SELECT current_version FROM sites WHERE tenant_id = ?1 AND slug = ?2',
  ).bind(tenantId, slug).first();

  const ts = now();
  if (!site) {
    await env.DB.prepare(
      'INSERT INTO sites (tenant_id, slug, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
    ).bind(tenantId, slug, ts).run();
  }

  const staging = await findStaging(env, tenantId, slug);
  if (staging) return staging.version;

  const max = await env.DB.prepare(
    'SELECT COALESCE(MAX(version), 0) AS v FROM versions WHERE tenant_id = ?1 AND slug = ?2',
  ).bind(tenantId, slug).first();
  const version = (max?.v ?? 0) + 1;
  await env.DB.prepare(
    `INSERT INTO versions (tenant_id, slug, version, state, created_at)
     VALUES (?1, ?2, ?3, 'staging', ?4)`,
  ).bind(tenantId, slug, version, ts).run();

  if (inherit && site?.current_version != null) {
    await env.DB.prepare(
      `INSERT INTO files (tenant_id, slug, version, path, bytes, ctype, src_version)
       SELECT tenant_id, slug, ?4, path, bytes, ctype, src_version
       FROM files WHERE tenant_id = ?1 AND slug = ?2 AND version = ?3`,
    ).bind(tenantId, slug, site.current_version, version).run();
  }
  return version;
}

/** Throw away an open staging version, if any, so the next one starts empty. */
async function resetStaging(env, tenantId, slug) {
  const staging = await findStaging(env, tenantId, slug);
  if (staging) await deleteVersion(env, tenantId, slug, staging.version);
}

async function stageFiles(env, tenantId, slug, version, files) {
  const chunk = 25;
  for (let i = 0; i < files.length; i += chunk) {
    await Promise.all(files.slice(i, i + chunk).map((f) =>
      env.SITES.put(objectKey(tenantId, slug, version, f.path), f.body, {
        httpMetadata: { contentType: ctypeFor(f.path).ctype },
      })));
  }

  const stmt = env.DB.prepare(
    `INSERT INTO files (tenant_id, slug, version, path, bytes, ctype, src_version)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?3)
     ON CONFLICT(tenant_id, slug, version, path)
     DO UPDATE SET bytes = excluded.bytes, ctype = excluded.ctype, src_version = excluded.src_version`,
  );
  for (let i = 0; i < files.length; i += 50) {
    await env.DB.batch(files.slice(i, i + 50).map((f) =>
      stmt.bind(tenantId, slug, version, f.path, f.bytes, ctypeFor(f.path).ctype)));
  }
}

/** Read the staged index document and pull a human title out of it, if any. */
async function stagedTitle(env, tenantId, slug, version) {
  for (const name of ['index.md', 'README.md', 'index.markdown', 'readme.md']) {
    // The bytes may live under an inherited version, so ask the manifest.
    const row = await env.DB.prepare(
      'SELECT src_version FROM files WHERE tenant_id = ?1 AND slug = ?2 AND version = ?3 AND path = ?4',
    ).bind(tenantId, slug, version, name).first();
    if (!row) continue;
    const obj = await env.SITES.get(objectKey(tenantId, slug, row.src_version, name));
    if (!obj) continue;
    const { meta, body } = splitFrontmatter(await obj.text());
    if (meta.title) return meta.title;
    const h1 = /^#\s+(.+)$/m.exec(body);
    return h1 ? h1[1].trim() : null;
  }
  return null;
}

/**
 * Drop a version. Because versions share objects, an object may only be deleted
 * once no other version's manifest still points at that (src_version, path).
 */
async function deleteVersion(env, tenantId, slug, version) {
  const { results } = await env.DB.prepare(
    `SELECT f.src_version, f.path FROM files f
     WHERE f.tenant_id = ?1 AND f.slug = ?2 AND f.version = ?3
       AND NOT EXISTS (
         SELECT 1 FROM files g
         WHERE g.tenant_id = ?1 AND g.slug = ?2 AND g.version <> ?3
           AND g.path = f.path AND g.src_version = f.src_version
       )`,
  ).bind(tenantId, slug, version).all();
  const keys = results.map((r) => objectKey(tenantId, slug, r.src_version, r.path));
  for (let i = 0; i < keys.length; i += 900) await env.SITES.delete(keys.slice(i, i + 900));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM files WHERE tenant_id = ?1 AND slug = ?2 AND version = ?3')
      .bind(tenantId, slug, version),
    env.DB.prepare('DELETE FROM versions WHERE tenant_id = ?1 AND slug = ?2 AND version = ?3')
      .bind(tenantId, slug, version),
  ]);
}

/** Delete a site and every version it owns. */
export async function deleteSite(env, tenantId, slug) {
  const { results: versions } = await env.DB.prepare(
    'SELECT version FROM versions WHERE tenant_id = ?1 AND slug = ?2',
  ).bind(tenantId, slug).all();
  for (const v of versions) await deleteVersion(env, tenantId, slug, v.version);
  const res = await env.DB.prepare('DELETE FROM sites WHERE tenant_id = ?1 AND slug = ?2')
    .bind(tenantId, slug).run();
  return res.meta.changes > 0;
}

async function publish(env, tenantId, slug) {
  const staging = await env.DB.prepare(
    `SELECT version FROM versions
     WHERE tenant_id = ?1 AND slug = ?2 AND state = 'staging'
     ORDER BY version DESC LIMIT 1`,
  ).bind(tenantId, slug).first();
  if (!staging) return { error: 'nothing staged for this site' };

  const version = staging.version;
  const stats = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b
     FROM files WHERE tenant_id = ?1 AND slug = ?2 AND version = ?3`,
  ).bind(tenantId, slug, version).first();
  if (!stats.n) return { error: 'nothing staged for this site' };

  const title = await stagedTitle(env, tenantId, slug, version);
  const ts = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE versions SET state = 'live', bytes = ?4, file_count = ?5
       WHERE tenant_id = ?1 AND slug = ?2 AND version = ?3`,
    ).bind(tenantId, slug, version, stats.b, stats.n),
    env.DB.prepare(
      `UPDATE versions SET state = 'retired'
       WHERE tenant_id = ?1 AND slug = ?2 AND version != ?3 AND state = 'live'`,
    ).bind(tenantId, slug, version),
    env.DB.prepare(
      `UPDATE sites SET current_version = ?3, title = ?4, updated_at = ?5
       WHERE tenant_id = ?1 AND slug = ?2`,
    ).bind(tenantId, slug, version, title, ts),
  ]);

  // Keep a few versions for rollback, drop the rest so R2 doesn't grow forever.
  const { results: old } = await env.DB.prepare(
    `SELECT version FROM versions WHERE tenant_id = ?1 AND slug = ?2
     ORDER BY version DESC LIMIT -1 OFFSET ?3`,
  ).bind(tenantId, slug, LIMITS.keepVersions).all();
  for (const row of old) await deleteVersion(env, tenantId, slug, row.version);

  return { version, files: stats.n, bytes: stats.b, title };
}

async function readBody(request, limit) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) return { error: `payload exceeds ${limit} bytes` };
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.byteLength > limit) return { error: `payload exceeds ${limit} bytes` };
  return { buf };
}

/**
 * Reject a write that would push the tenant past its quota. Checked before any
 * R2 write so an over-quota upload costs nothing to store.
 */
async function quotaCheck(env, tenantId, quotaBytes, incomingBytes) {
  const used = await tenantUsage(env, tenantId);
  if (used + incomingBytes <= quotaBytes) return null;
  return err(413, 'quota exceeded', {
    quota_bytes: quotaBytes, used_bytes: used, incoming_bytes: incomingBytes,
  });
}

const VISIBILITIES = new Set(['public', 'secret']);

/**
 * Visibility requested by an upload. The password arrives in a header rather
 * than the query string: query strings end up in access logs, shell history and
 * `Referer`, and this one is a credential.
 */
function requestedVisibility(request, url) {
  const visibility = url.searchParams.get('visibility') ?? undefined;
  const password = request.headers.get('x-site-password') ?? undefined;
  return visibility === undefined && password === undefined ? null : { visibility, password };
}

/**
 * Apply a visibility change. A password implies `secret` — a listed site with a
 * password would be an odd thing to advertise — and clearing the password is
 * explicit (`password: null`) rather than implied by omitting it, so a routine
 * publish cannot accidentally unlock a protected site.
 */
async function setVisibility(env, tenantId, slug, { visibility, password }) {
  if (visibility !== undefined && !VISIBILITIES.has(visibility)) {
    return err(400, "visibility must be 'public' or 'secret'");
  }
  const sets = [];
  const binds = [];

  if (password !== undefined) {
    if (password === null || password === '') {
      sets.push('password_hash = NULL');
    } else if (typeof password !== 'string' || password.length < 4 || password.length > 256) {
      return err(400, 'password must be 4-256 characters');
    } else {
      binds.push(await hashPassword(password));
      sets.push(`password_hash = ?${binds.length + 2}`);
    }
  }

  const effective = password ? 'secret' : visibility;
  if (effective !== undefined) {
    binds.push(effective);
    sets.push(`visibility = ?${binds.length + 2}`);
  }
  if (!sets.length) return null;

  const res = await env.DB.prepare(
    `UPDATE sites SET ${sets.join(', ')} WHERE tenant_id = ?1 AND slug = ?2`,
  ).bind(tenantId, slug, ...binds).run();
  return res.meta.changes ? null : err(404, 'no such site');
}

const siteUrl = (env, tenantId, slug) => `https://${tenantId}.${env.ROOT_DOMAIN}/${slug}/`;

async function handleAdmin(request, env, parts) {
  if (!isAdmin(request, env)) return err(401, 'admin token required');

  if (parts[0] === 'tenants' && !parts[1] && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || '').toLowerCase();
    if (!isValidTenantId(id)) {
      return err(400, 'invalid tenant id: 2-63 chars, [a-z0-9-], not a reserved name');
    }
    const existing = await env.DB.prepare('SELECT id FROM tenants WHERE id = ?1').bind(id).first();
    if (existing) return err(409, 'tenant already exists');
    await env.DB.prepare(
      'INSERT INTO tenants (id, name, created_at) VALUES (?1, ?2, ?3)',
    ).bind(id, body.name || null, now()).run();
    return json({ tenant: id, url: `https://${id}.${env.ROOT_DOMAIN}/` }, 201);
  }

  if (parts[0] === 'tenants' && !parts[1] && request.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.name, t.created_at, t.disabled_at, t.disabled_reason,
              t.owner_github_login, t.quota_bytes,
              (SELECT COALESCE(SUM(bytes), 0) FROM (
                 SELECT DISTINCT slug, src_version, path, bytes
                 FROM files WHERE tenant_id = t.id)) AS used_bytes
       FROM tenants t ORDER BY t.created_at DESC`,
    ).all();
    return json({ tenants: results });
  }

  if (parts[0] === 'tokens' && !parts[1] && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const tenantId = String(body.tenant_id || '').toLowerCase();
    const tenant = await env.DB.prepare('SELECT id FROM tenants WHERE id = ?1')
      .bind(tenantId).first();
    if (!tenant) return err(404, 'no such tenant');
    // Only time the plaintext exists; the database stores the hash alone.
    const { token, id } = await mintToken(env, tenantId, body.name || null, body.expires_at || null);
    return json({ token, id, tenant: tenantId }, 201);
  }

  if (parts[0] === 'tenants' && parts[2] === 'disable' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const res = await env.DB.prepare(
      'UPDATE tenants SET disabled_at = ?2, disabled_reason = ?3 WHERE id = ?1',
    ).bind(parts[1], now(), body.reason || null).run();
    if (!res.meta.changes) return err(404, 'no such tenant');
    return json({ tenant: parts[1], disabled: true, reason: body.reason || null });
  }

  // Bind a tenant to a GitHub account. Invite-created tenants have no owner, so
  // without this they could never be managed through the self-serve signup flow.
  if (parts[0] === 'tenants' && parts[2] === 'owner' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const login = String(body.github_login || '').trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
      return err(400, 'invalid github login');
    }
    const ghRes = await fetch(`https://api.github.com/users/${login}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'jmp2' },
    });
    if (!ghRes.ok) return err(404, 'no such github user');
    const gh = await ghRes.json();

    const held = await env.DB.prepare('SELECT id FROM tenants WHERE owner_github_id = ?1')
      .bind(String(gh.id)).first();
    if (held && held.id !== parts[1]) {
      return err(409, `that github account already owns ${held.id}`);
    }
    const res = await env.DB.prepare(
      'UPDATE tenants SET owner_github_id = ?2, owner_github_login = ?3 WHERE id = ?1',
    ).bind(parts[1], String(gh.id), gh.login).run();
    if (!res.meta.changes) return err(404, 'no such tenant');
    return json({ tenant: parts[1], github_login: gh.login, github_id: String(gh.id) });
  }

  if (parts[0] === 'tenants' && parts[2] === 'owner' && request.method === 'DELETE') {
    const res = await env.DB.prepare(
      'UPDATE tenants SET owner_github_id = NULL, owner_github_login = NULL WHERE id = ?1',
    ).bind(parts[1]).run();
    if (!res.meta.changes) return err(404, 'no such tenant');
    return json({ tenant: parts[1], github_login: null });
  }

  if (parts[0] === 'tenants' && parts[2] === 'enable' && request.method === 'POST') {
    const res = await env.DB.prepare(
      'UPDATE tenants SET disabled_at = NULL, disabled_reason = NULL WHERE id = ?1',
    ).bind(parts[1]).run();
    if (!res.meta.changes) return err(404, 'no such tenant');
    return json({ tenant: parts[1], disabled: false });
  }

  return err(404, 'unknown admin endpoint');
}

/** Router for `https://<root>/_api/...`. */
export async function handleApi(request, env, ctx, pathname) {
  const parts = pathname.split('/').filter(Boolean).slice(1); // drop "_api"

  if (parts[0] === 'admin') {
    // Per-IP, so a leaked-URL guess at the admin token cannot be brute forced.
    const gate = await hit(env, `admin:${clientIp(request)}`, RATE.admin);
    if (!gate.ok) return err(429, 'rate limit exceeded', {}, retryHeaders(gate));
    return handleAdmin(request, env, parts.slice(1));
  }

  const auth = await authenticate(request, env);
  if (!auth) return err(401, 'invalid or missing token');
  const tenantId = auth.tenant_id;

  if (auth.disabled_at) {
    return err(403, 'this tenant is suspended', { reason: auth.disabled_reason || undefined });
  }

  const gate = await hit(env, `write:${tenantId}`, RATE.write);
  if (!gate.ok) return err(429, 'rate limit exceeded', {}, retryHeaders(gate));

  ctx.waitUntil(env.DB.prepare('UPDATE tokens SET last_used_at = ?2 WHERE hash = ?1')
    .bind(auth.hash, now()).run());

  if (parts[0] === 'whoami') {
    const used = await tenantUsage(env, tenantId);
    return json({
      tenant: tenantId,
      token_name: auth.name,
      url: `https://${tenantId}.${env.ROOT_DOMAIN}/`,
      quota_bytes: auth.quota_bytes,
      used_bytes: used,
    });
  }

  if (parts[0] === 'tokens') {
    const tokenId = parts[1];
    if (!tokenId && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT id, name, created_at, last_used_at, expires_at, revoked_at
         FROM tokens WHERE tenant_id = ?1 ORDER BY created_at DESC`,
      ).bind(tenantId).all();
      // `current` lets a caller tell which row is the token it just used.
      // Guard the null case: pre-migration rows have no public id, and
      // null === null would mark every one of them as current.
      return json({
        tokens: results.map((t) => ({ ...t, current: t.id != null && t.id === auth.id })),
      });
    }
    if (!tokenId && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const minted = await mintToken(env, tenantId, body.name || null, body.expires_at || null);
      return json({ ...minted, tenant: tenantId }, 201);
    }
    if (tokenId && request.method === 'DELETE') {
      const res = await env.DB.prepare(
        'UPDATE tokens SET revoked_at = ?3 WHERE tenant_id = ?1 AND id = ?2 AND revoked_at IS NULL',
      ).bind(tenantId, tokenId, now()).run();
      if (!res.meta.changes) return err(404, 'no such token');
      return json({ revoked: tokenId });
    }
    return err(405, 'method not allowed for this endpoint');
  }

  if (parts[0] !== 'sites') return err(404, 'unknown endpoint');

  if (parts.length === 1 && request.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT slug, title, current_version, updated_at, visibility,
              password_hash IS NOT NULL AS password_protected
       FROM sites WHERE tenant_id = ?1 ORDER BY updated_at DESC`,
    ).bind(tenantId).all();
    return json({
      sites: results.map((s) => ({
        ...s,
        password_protected: Boolean(s.password_protected),
        url: siteUrl(env, tenantId, s.slug),
      })),
    });
  }

  const slug = parts[1];
  if (!isValidSlug(slug)) return err(400, 'invalid slug: 1-63 chars, [a-z0-9-]');
  const action = parts[2];

  if (!action && request.method === 'GET') {
    const row = await env.DB.prepare(
      `SELECT slug, title, current_version, created_at, updated_at, visibility, password_hash
       FROM sites WHERE tenant_id = ?1 AND slug = ?2`,
    ).bind(tenantId, slug).first();
    if (!row) return err(404, 'no such site');
    // The hash never leaves the database; callers only need to know it is set.
    const { password_hash: pw, ...site } = row;
    site.password_protected = Boolean(pw);
    const { results: versions } = await env.DB.prepare(
      `SELECT version, state, bytes, file_count, created_at FROM versions
       WHERE tenant_id = ?1 AND slug = ?2 ORDER BY version DESC`,
    ).bind(tenantId, slug).all();
    return json({ ...site, url: siteUrl(env, tenantId, slug), versions });
  }

  if (!action && request.method === 'DELETE') {
    await deleteSite(env, tenantId, slug);
    return json({ deleted: slug });
  }

  if (action === 'files' && request.method === 'PUT') {
    const path = normalizePath(parts.slice(3).join('/'));
    if (!path) return err(400, 'invalid file path');
    const { buf, error } = await readBody(request, LIMITS.fileBytes);
    if (error) return err(413, error);
    const over = await quotaCheck(env, tenantId, auth.quota_bytes, buf.byteLength);
    if (over) return over;
    const version = await openStaging(env, tenantId, slug, { inherit: true });
    await stageFiles(env, tenantId, slug, version, [{ path, body: buf, bytes: buf.byteLength }]);
    return json({ staged: path, version, bytes: buf.byteLength });
  }

  if (action === 'files' && request.method === 'DELETE') {
    const path = normalizePath(parts.slice(3).join('/'));
    if (!path) return err(400, 'invalid file path');
    const version = await openStaging(env, tenantId, slug, { inherit: true });
    await env.DB.prepare(
      'DELETE FROM files WHERE tenant_id = ?1 AND slug = ?2 AND version = ?3 AND path = ?4',
    ).bind(tenantId, slug, version, path).run();
    return json({ unstaged: path, version });
  }

  if (action === 'tarball' && ['PUT', 'POST'].includes(request.method)) {
    const url = new URL(request.url);
    const { buf, error } = await readBody(request, LIMITS.uploadBytes);
    if (error) return err(413, error);

    let entries;
    try {
      entries = stripCommonPrefix(parseTar(await maybeGunzip(buf)));
    } catch (e) {
      return err(400, `could not read archive: ${e.message}`);
    }
    if (url.searchParams.get('strip') === '0') {
      entries = parseTar(await maybeGunzip(buf));
    }
    if (entries.length === 0) return err(400, 'archive contained no files');
    if (entries.length > LIMITS.fileCount) return err(413, `archive exceeds ${LIMITS.fileCount} files`);

    const staged = [];
    for (const e of entries) {
      const path = normalizePath(e.name);
      if (!path) return err(400, `unsafe path in archive: ${e.name}`);
      if (e.size > LIMITS.fileBytes) return err(413, `${path} exceeds ${LIMITS.fileBytes} bytes`);
      staged.push({ path, body: e.data, bytes: e.size });
    }

    const incoming = staged.reduce((n, f) => n + f.bytes, 0);
    const over = await quotaCheck(env, tenantId, auth.quota_bytes, incoming);
    if (over) return over;

    // A tarball describes the whole site, so by default it replaces rather than
    // merges: files removed from the folder must disappear from the site too.
    const merge = url.searchParams.get('merge') === '1';
    if (!merge) await resetStaging(env, tenantId, slug);
    const version = await openStaging(env, tenantId, slug, { inherit: merge });
    await stageFiles(env, tenantId, slug, version, staged);

    const wanted = requestedVisibility(request, url);
    if (wanted) {
      const failed = await setVisibility(env, tenantId, slug, wanted);
      if (failed) return failed;
    }

    if (url.searchParams.get('publish') === '0') {
      return json({ staged: staged.length, version, published: false });
    }
    const result = await publish(env, tenantId, slug);
    if (result.error) return err(400, result.error);
    return json({ ...result, url: siteUrl(env, tenantId, slug), published: true }, 201);
  }

  if (action === 'visibility' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const failed = await setVisibility(env, tenantId, slug, {
      visibility: body.visibility,
      password: 'password' in body ? body.password : undefined,
    });
    if (failed) return failed;
    const row = await env.DB.prepare(
      'SELECT visibility, password_hash FROM sites WHERE tenant_id = ?1 AND slug = ?2',
    ).bind(tenantId, slug).first();
    return json({
      slug,
      visibility: row.visibility,
      password_protected: Boolean(row.password_hash),
      url: siteUrl(env, tenantId, slug),
    });
  }

  if (action === 'publish' && request.method === 'POST') {
    const result = await publish(env, tenantId, slug);
    if (result.error) return err(400, result.error);
    return json({ ...result, url: siteUrl(env, tenantId, slug) });
  }

  if (action === 'rollback' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const target = Number(body.version);
    const row = await env.DB.prepare(
      `SELECT version FROM versions
       WHERE tenant_id = ?1 AND slug = ?2 AND version = ?3 AND state != 'staging'`,
    ).bind(tenantId, slug, target).first();
    if (!row) return err(404, 'no such published version');
    await env.DB.batch([
      env.DB.prepare(`UPDATE versions SET state = 'retired' WHERE tenant_id = ?1 AND slug = ?2 AND state = 'live'`)
        .bind(tenantId, slug),
      env.DB.prepare(`UPDATE versions SET state = 'live' WHERE tenant_id = ?1 AND slug = ?2 AND version = ?3`)
        .bind(tenantId, slug, target),
      env.DB.prepare('UPDATE sites SET current_version = ?3, updated_at = ?4 WHERE tenant_id = ?1 AND slug = ?2')
        .bind(tenantId, slug, target, now()),
    ]);
    return json({ version: target, url: siteUrl(env, tenantId, slug) });
  }

  return err(405, 'method not allowed for this endpoint');
}
