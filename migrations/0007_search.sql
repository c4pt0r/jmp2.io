-- Full-text search. Rows are keyed like R2 objects, by (src_version, path),
-- so they are immutable and a query joins the live manifest to see only what
-- is live. Filled lazily by the search endpoint, which also backfills sites
-- published before this existed.
CREATE TABLE IF NOT EXISTS search_docs (
  id          INTEGER PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  slug        TEXT NOT NULL,
  src_version INTEGER NOT NULL,
  path        TEXT NOT NULL,
  title       TEXT,
  body        TEXT NOT NULL,
  UNIQUE (tenant_id, slug, src_version, path)
);

-- Trigram rather than the default word tokenizer: it matches substrings in any
-- script, and CJK text has no spaces for a word tokenizer to split on.
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title, body, content = 'search_docs', content_rowid = 'id', tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO search_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO search_fts (search_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
