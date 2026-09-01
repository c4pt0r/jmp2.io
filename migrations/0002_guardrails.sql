-- Guardrails needed before signup can be opened to the public:
-- suspendable tenants, user-managed tokens, and a rate-limit counter.

ALTER TABLE tenants ADD COLUMN disabled_at INTEGER;
ALTER TABLE tenants ADD COLUMN disabled_reason TEXT;
ALTER TABLE tenants ADD COLUMN owner_github_id TEXT;
ALTER TABLE tenants ADD COLUMN owner_github_login TEXT;

-- Tokens are addressed by a short public id so a user can list and revoke them
-- without ever handling the plaintext again.
ALTER TABLE tokens ADD COLUMN id TEXT;

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS tenants_github_owner
  ON tenants(owner_github_id) WHERE owner_github_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tokens_public_id
  ON tokens(id) WHERE id IS NOT NULL;
