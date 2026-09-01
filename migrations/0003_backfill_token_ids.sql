-- Tokens minted before 0002 have no public id, so they cannot be listed or
-- revoked through the API. Give each one a deterministic id derived from its
-- hash (the hash never leaves the database, so this leaks nothing).
UPDATE tokens SET id = substr(hash, 1, 16) WHERE id IS NULL;
