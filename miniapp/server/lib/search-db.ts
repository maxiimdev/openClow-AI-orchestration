/**
 * SQLite FTS5 search database — artifact indexing and full-text search.
 *
 * Uses better-sqlite3 for synchronous, in-process SQLite with FTS5 extension.
 * Database file: .data/search.db (git-ignored, ephemeral per environment).
 */

import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

let _db: Database.Database | null = null

const DB_DIR = join(process.cwd(), '.data')
const DB_PATH = join(DB_DIR, 'search.db')

/** Get or create the singleton database connection. */
export function getDb(): Database.Database {
  if (_db) return _db

  mkdirSync(DB_DIR, { recursive: true })
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  migrate(_db)
  return _db
}

/** Allow injecting a custom DB (for testing with :memory:). */
export function setDb(db: Database.Database): void {
  _db = db
  migrate(_db)
}

/** Close and release the singleton connection. */
export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

// ── Migration ───────────────────────────────────────────────────────────────

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      path        TEXT NOT NULL,
      bytes       INTEGER NOT NULL DEFAULT 0,
      sha256      TEXT NOT NULL DEFAULT '',
      preview     TEXT NOT NULL DEFAULT '',
      indexed_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(task_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
      artifact_id,
      section,
      body,
      tokenize = 'porter unicode61',
      content_rowid = rowid
    );

    CREATE TABLE IF NOT EXISTS fts_chunk_meta (
      rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      section     TEXT NOT NULL DEFAULT '',
      body        TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0
    );
  `)
}
