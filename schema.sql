-- jmp2.io schema. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS tenants (
  id                 TEXT PRIMARY KEY,    -- subdomain label, e.g. "dongxu"
  name               TEXT,
  quota_bytes        INTEGER NOT NULL DEFAULT 1073741824,
  created_at         INTEGER NOT NULL,
  -- Suspension is separate from deletion: abuse response needs to stop a
  -- tenant serving while the evidence is still there to look at.
  disabled_at        INTEGER,
  disabled_reason    TEXT,
  -- Ownership is (provider, subject) so a second identity provider needs no
  -- schema change: 'github' + the numeric id, 'google' + the OIDC subject.
  owner_provider     TEXT,
  owner_subject      TEXT,
  owner_label        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS tenants_owner
  ON tenants(owner_provider, owner_subject) WHERE owner_subject IS NOT NULL;

CREATE TABLE IF NOT EXISTS tokens (
  hash         TEXT PRIMARY KEY,          -- sha256 hex of the plaintext token
  id           TEXT,                      -- short public id, for list/revoke
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,                   -- NULL = never
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_tenant ON tokens(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS tokens_public_id ON tokens(id) WHERE id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sites (
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,
  current_version INTEGER,                -- NULL until first publish
  title           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  -- 'public'  listed on the tenant index, publicly readable
  -- 'secret'  publicly readable by URL, but never listed publicly
  visibility      TEXT NOT NULL DEFAULT 'public',
  -- Set only for secret sites that additionally require Basic auth.
  password_hash   TEXT,
  -- Optional; NULL means any username is accepted.
  auth_user       TEXT,
  PRIMARY KEY (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS sites_public ON sites(tenant_id, visibility, updated_at);

CREATE TABLE IF NOT EXISTS versions (
  tenant_id  TEXT NOT NULL,
  slug       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  state      TEXT NOT NULL DEFAULT 'staging',   -- staging | live | retired
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, slug, version)
);

-- Manifest of every file in a version. Lets us render a sidebar / file tree
-- and enumerate objects for deletion without paging R2.
--
-- `src_version` is the version whose R2 prefix actually holds the bytes, which
-- is usually but not always `version`: staging a single file inherits the rest
-- of the live version by copying manifest rows rather than objects, so editing
-- one file in a 500-file site costs one R2 write instead of 500.
CREATE TABLE IF NOT EXISTS files (
  tenant_id   TEXT NOT NULL,
  slug        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  path        TEXT NOT NULL,              -- normalized, no leading slash
  bytes       INTEGER NOT NULL,
  ctype       TEXT NOT NULL,
  src_version INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, slug, version, path)
);
CREATE INDEX IF NOT EXISTS files_src ON files(tenant_id, slug, src_version, path);

-- Fixed-window counters for the write API and the signup flow. Only writes are
-- counted: reads are served from the edge cache and never reach D1.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
