// Database layer: SQLite via better-sqlite3.
// One file on disk (crew.db). Everything is stored as UTC epoch milliseconds.
const path = require('path');
const Database = require('better-sqlite3');

// Allow the host to point the DB at a persistent disk (e.g. Render disk mount).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'crew.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS workers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id  INTEGER NOT NULL,
    clock_in   INTEGER NOT NULL,
    clock_out  INTEGER,
    FOREIGN KEY (worker_id) REFERENCES workers(id)
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id      INTEGER NOT NULL,
    shift_id       INTEGER NOT NULL,
    name           TEXT,
    started_at     INTEGER NOT NULL,
    finished_at    INTEGER,
    travel_deadline INTEGER,
    FOREIGN KEY (worker_id) REFERENCES workers(id),
    FOREIGN KEY (shift_id) REFERENCES shifts(id)
  );

  CREATE TABLE IF NOT EXISTS penalties (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id    INTEGER NOT NULL,
    job_id       INTEGER,
    created_at   INTEGER NOT NULL,
    minutes_late INTEGER NOT NULL DEFAULT 0,
    hours_docked REAL NOT NULL DEFAULT 1,
    reason       TEXT,
    waived       INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (worker_id) REFERENCES workers(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Scheduled jobs the owner assigns to a worker for a given day.
  CREATE TABLE IF NOT EXISTS assignments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id    INTEGER NOT NULL,
    title        TEXT NOT NULL,
    address      TEXT,
    notes        TEXT,
    date         TEXT NOT NULL,          -- YYYY-MM-DD (local) for grouping
    scheduled_at INTEGER,                -- optional exact time (epoch ms)
    status       TEXT NOT NULL DEFAULT 'assigned', -- assigned|in_progress|done|skipped
    job_id       INTEGER,                -- links to the jobs row once started
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    FOREIGN KEY (worker_id) REFERENCES workers(id)
  );

  CREATE TABLE IF NOT EXISTS checklist_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL,
    text          TEXT NOT NULL,
    done          INTEGER NOT NULL DEFAULT 0,
    done_at       INTEGER,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id)
  );

  CREATE TABLE IF NOT EXISTS photos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER,
    worker_id     INTEGER NOT NULL,
    filename      TEXT NOT NULL,
    lat           REAL,
    lng           REAL,
    created_at    INTEGER NOT NULL
  );

  -- Event-based GPS pings captured at clock-in / job start / finish / photo.
  CREATE TABLE IF NOT EXISTS locations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id  INTEGER NOT NULL,
    lat        REAL NOT NULL,
    lng        REAL NOT NULL,
    accuracy   REAL,
    context    TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message    TEXT NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS announcement_reads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    announcement_id INTEGER NOT NULL,
    worker_id       INTEGER NOT NULL,
    read_at         INTEGER NOT NULL
  );
`);

// Lightweight migrations: add columns to existing tables if missing.
const jobCols = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
if (!jobCols.includes('assignment_id')) {
  db.exec('ALTER TABLE jobs ADD COLUMN assignment_id INTEGER');
}
const asgCols = db.prepare('PRAGMA table_info(assignments)').all().map((c) => c.name);
if (!asgCols.includes('calendar_uid')) {
  db.exec('ALTER TABLE assignments ADD COLUMN calendar_uid TEXT'); // links to a Google Calendar event
}

// Default settings (only inserted once).
const DEFAULT_SETTINGS = {
  travel_minutes: '30',   // grace window to reach the next job
  penalty_hours: '1',     // hours docked per late arrival
  hourly_rate: '0',       // 0 = don't show money, just hours
  currency: '£',
  business_name: 'Premier Cleaning',
  brand_color: '#1f7a4d', // Premier Cleaning green
  require_photo: '1',     // must add an after-photo before finishing a scheduled job
  require_checklist: '1', // must tick every checklist item before finishing
  calendar_ical_url: '',  // Premier calendar "Secret address in iCal format" — jobs flow in from here
};
const insertSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

// Seed a couple of example workers on first run so the owner sees how it looks.
const workerCount = db.prepare('SELECT COUNT(*) AS n FROM workers').get().n;
if (workerCount === 0) {
  const seed = db.prepare(
    'INSERT INTO workers (name, active, sort_order, created_at) VALUES (?, 1, ?, ?)'
  );
  const now = Date.now();
  ['Example Worker 1', 'Example Worker 2'].forEach((name, i) =>
    seed.run(name, i, now)
  );
}

module.exports = { db };
