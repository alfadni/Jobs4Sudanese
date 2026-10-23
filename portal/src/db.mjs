/**
 * db.mjs: the portal's own state, in SQLite (node:sqlite, no native addon).
 *
 * This holds ONLY what career-ops has no file for: accounts, sessions, the
 * evaluation job queue and an audit trail. A user's CV, profile, tracker and
 * reports stay in their own career-ops data root as markdown, so the engine
 * scripts keep working on them unchanged (web/AGENTS.md: markdown is the
 * source of truth).
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  lang          TEXT NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar','en')),
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('evaluate','scan')),
  status      TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','stopped')),
  input       TEXT NOT NULL,
  result      TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  user_id     TEXT,
  action      TEXT NOT NULL,
  detail      TEXT
);
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, "portal.sqlite"));
  db.exec(SCHEMA);
  return db;
}

export function audit(db, userId, action, detail = null) {
  db.prepare("INSERT INTO audit (at, user_id, action, detail) VALUES (?, ?, ?, ?)")
    .run(Date.now(), userId, action, detail == null ? null : String(detail).slice(0, 500));
}
