-- Per-site visibility.
--
--   public              listed on the tenant index, publicly readable
--   secret              publicly readable by URL, but not listed anywhere public
--   secret + password   Basic auth required
--
-- Existing sites become public: that is what they already were, and silently
-- unlisting someone's published work on upgrade would be worse than the
-- privacy-safer default.
ALTER TABLE sites ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE sites ADD COLUMN password_hash TEXT;

CREATE INDEX IF NOT EXISTS sites_public
  ON sites(tenant_id, visibility, updated_at);
