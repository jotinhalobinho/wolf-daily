"use strict";

const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "app.db");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS collaborators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  salary REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','collaborator')),
  collaborator_id TEXT REFERENCES collaborators(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  working_days INTEGER NOT NULL,
  deadline TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved')),
  approved_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rateio_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  observations TEXT DEFAULT '',
  submitted INTEGER DEFAULT 0,
  UNIQUE(release_id, collaborator_id)
);

CREATE TABLE IF NOT EXISTS rateio_entry_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES rateio_entries(id) ON DELETE CASCADE,
  unit TEXT,
  name TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 0,
  operations TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  requester TEXT DEFAULT '',
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  cost_centers TEXT NOT NULL DEFAULT '[]',
  splits TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  days INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, collaborator_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Rateio diário pessoal (uso individual, isolado por usuário — não depende de
-- liberação de admin nem afeta os "releases"/rateio mensal por colaborador acima).
CREATE TABLE IF NOT EXISTS daily_periods (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT,
  UNIQUE(user_id, month, year)
);

CREATE TABLE IF NOT EXISTS daily_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id TEXT NOT NULL REFERENCES daily_periods(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  holiday_name TEXT,
  holiday_override INTEGER,
  atestado INTEGER NOT NULL DEFAULT 0,
  UNIQUE(period_id, date)
);

CREATE TABLE IF NOT EXISTS daily_day_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id INTEGER NOT NULL REFERENCES daily_days(id) ON DELETE CASCADE,
  unit TEXT NOT NULL CHECK (unit IN ('wolf','fraga','woncred','profit')),
  project_name TEXT NOT NULL,
  operations TEXT
);
`);

// Migração leve: adiciona a coluna "operations" em bancos criados antes dela existir.
const entryItemColumns = db.prepare("PRAGMA table_info(rateio_entry_items)").all();
if (!entryItemColumns.some((col) => col.name === "operations")) {
  db.exec("ALTER TABLE rateio_entry_items ADD COLUMN operations TEXT");
}

module.exports = db;
