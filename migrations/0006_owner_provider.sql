-- Ownership was keyed on a GitHub id, which does not survive a second identity
-- provider. Generalize to (provider, subject) so adding a third is a config
-- change rather than another migration.
ALTER TABLE tenants ADD COLUMN owner_provider TEXT;
ALTER TABLE tenants ADD COLUMN owner_subject  TEXT;
ALTER TABLE tenants ADD COLUMN owner_label    TEXT;

UPDATE tenants
SET owner_provider = 'github',
    owner_subject  = owner_github_id,
    owner_label    = owner_github_login
WHERE owner_github_id IS NOT NULL;

DROP INDEX IF EXISTS tenants_github_owner;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_owner
  ON tenants(owner_provider, owner_subject)
  WHERE owner_subject IS NOT NULL;
