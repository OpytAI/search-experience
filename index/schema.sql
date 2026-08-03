PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS search_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  source_json TEXT NOT NULL DEFAULT '{}',
  page_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  built_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  stable_id TEXT NOT NULL UNIQUE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  UNIQUE(collection_id, canonical_url)
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  stable_id TEXT NOT NULL UNIQUE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  heading TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(page_id, ordinal)
);

CREATE INDEX IF NOT EXISTS chunks_collection_page
  ON chunks(collection_id, page_id, ordinal);
CREATE INDEX IF NOT EXISTS pages_collection_url
  ON pages(collection_id, canonical_url);

-- External-content FTS avoids storing a second copy of every title/heading/body.
-- collection_id is carried for provenance/filtering but is not tokenized.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  title,
  heading,
  body,
  collection_id UNINDEXED,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, title, heading, body, collection_id)
  VALUES (new.id, new.title, new.heading, new.body, new.collection_id);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title, heading, body, collection_id)
  VALUES ('delete', old.id, old.title, old.heading, old.body, old.collection_id);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title, heading, body, collection_id)
  VALUES ('delete', old.id, old.title, old.heading, old.body, old.collection_id);
  INSERT INTO chunks_fts(rowid, title, heading, body, collection_id)
  VALUES (new.id, new.title, new.heading, new.body, new.collection_id);
END;

-- VANN uses the same rowid as chunks, making lexical/vector fusion an exact id
-- join. collection_id is a partition so one crawl collection cannot drown out
-- another before presentation policy runs.
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vann(
  embedding float[384] metric=cosine,
  collection_id partition,
  page_id integer,
  updated_at integer,
  M=16,
  ef_construction=100,
  ef_search=64
);

PRAGMA user_version = 1;
