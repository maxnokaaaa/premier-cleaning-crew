// Database layer: SQLite via libsql (better-sqlite3-compatible).
// Everything is stored as UTC epoch milliseconds.
// If TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are set, data lives in a free Turso
// cloud database (permanent, survives restarts/redeploys). Otherwise it's a
// plain local file — identical behaviour for local development.
const path = require('path');
const Database = require('libsql');

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'crew.db');

let db;
if (TURSO_URL && TURSO_TOKEN) {
  // Embedded replica: reads served from a local cache, writes forwarded to the
  // Turso cloud primary (durable). On boot we pull the cloud copy down first.
  db = new Database(process.env.REPLICA_PATH || '/tmp/crew-replica.db', {
    syncUrl: TURSO_URL,
    authToken: TURSO_TOKEN,
  });
  try { db.sync(); } catch (e) { console.error('Turso initial sync failed:', e.message); }
  setInterval(() => { try { db.sync(); } catch (e) {} }, 60000);
  console.log('Database: Turso cloud (persistent)');
} else {
  db = new Database(DB_PATH);
  console.log('Database: local file', DB_PATH);
}
try { db.pragma('journal_mode = WAL'); } catch (e) { /* not applicable on replicas */ }

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

  -- Clients / sites the crew can be working at. Workers must pick one to clock in.
  CREATE TABLE IF NOT EXISTS clients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  -- A quality checklist attached to a shift, generated from the service-type template.
  CREATE TABLE IF NOT EXISTS shift_checklist_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id   INTEGER NOT NULL,
    text       TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    done_at    INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  -- Web-push subscriptions so we can send notifications to a worker's phone.
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id  INTEGER NOT NULL,
    endpoint   TEXT NOT NULL UNIQUE,
    sub        TEXT NOT NULL,          -- full subscription JSON
    created_at INTEGER NOT NULL
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
const workerCols = db.prepare('PRAGMA table_info(workers)').all().map((c) => c.name);
if (!workerCols.includes('hourly_rate')) {
  db.exec('ALTER TABLE workers ADD COLUMN hourly_rate REAL'); // per-worker rate; null = use global default
}
const shiftCols = db.prepare('PRAGMA table_info(shifts)').all().map((c) => c.name);
if (!shiftCols.includes('place')) {
  db.exec('ALTER TABLE shifts ADD COLUMN place TEXT'); // where the worker is working today
}
if (!shiftCols.includes('last_checkin')) {
  db.exec('ALTER TABLE shifts ADD COLUMN last_checkin INTEGER'); // last check-in push sent
}
if (!shiftCols.includes('service_type')) {
  db.exec('ALTER TABLE shifts ADD COLUMN service_type TEXT'); // standard|deep|postconstruction|airbnb
}
if (!shiftCols.includes('notes')) {
  db.exec('ALTER TABLE shifts ADD COLUMN notes TEXT'); // client / property details the cleaner fills in
}
if (!shiftCols.includes('auto_closed')) {
  db.exec('ALTER TABLE shifts ADD COLUMN auto_closed INTEGER NOT NULL DEFAULT 0'); // capped after a forgotten clock-out
}
const photoCols2 = db.prepare('PRAGMA table_info(photos)').all().map((c) => c.name);
if (!photoCols2.includes('shift_id')) {
  db.exec('ALTER TABLE photos ADD COLUMN shift_id INTEGER'); // photos can belong to a shift, not just an assignment
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
  checkin_minutes: '30',  // how often to push a "still on the job?" check-in while clocked in (0 = off)
  require_shift_checklist: '1', // must complete the checklist before clocking out
  max_shift_hours: '14',  // a shift left running longer than this is auto-capped for review (0 = off)
  checklist_standard: [
    'Kitchen surfaces & sink cleaned',
    'Hob & outside of appliances wiped',
    'All bathrooms — toilet, shower/bath, sink, mirror',
    'Dust all surfaces & furniture',
    'Floors vacuumed and mopped',
    'Mirrors & glass cleaned',
    'Bins emptied & fresh bags',
    'Beds made / rooms tidied',
    'Before photos taken',
    'After photos taken',
    'Final walk-through done',
  ].join('\n'),
  checklist_deep: [
    'Kitchen surfaces, sink & tiles cleaned',
    'Inside oven cleaned',
    'Inside fridge / freezer cleaned',
    'Outside of all appliances',
    'Bathrooms — toilet, shower, bath, sink, taps',
    'Limescale removed (taps, shower screen)',
    'Interior windows & sills',
    'Skirting boards & door frames',
    'Cupboards wiped inside & out',
    'Dust everywhere incl. high & low',
    'Floors vacuumed & mopped',
    'Bins emptied',
    'Before photos taken',
    'After photos taken',
    'Final walk-through done',
  ].join('\n'),
  checklist_postconstruction: [
    'Remove all dust, debris & builders\' rubble',
    'Remove paint / plaster / adhesive spots',
    'Wash all walls & ceilings as needed',
    'Clean all windows, frames & sills (inside)',
    'Deep clean floors — sweep, scrub, mop',
    'Skirting boards, doors & frames',
    'Kitchen — units inside & out, worktops',
    'Bathrooms — full sanitise, grout, fixtures',
    'Light fittings, switches & sockets wiped',
    'Radiators & vents cleaned',
    'Final dust pass (settles after first clean)',
    'Before photos taken',
    'After photos taken',
    'Final walk-through done',
  ].join('\n'),
  checklist_airbnb: [
    'All beds stripped & remade with fresh linen',
    'Fresh towels laid out',
    'Bathrooms sanitised — toilet, shower, sink',
    'Kitchen reset & dishes done',
    'Fridge cleared of guest leftovers',
    'Consumables restocked (toilet roll, soap, coffee)',
    'All bins emptied & taken out',
    'Check for damage — report anything',
    'Check for guest left-behind items',
    'Floors vacuumed & mopped',
    'Staging / welcome setup done',
    'Before photos taken',
    'After photos taken',
  ].join('\n'),
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
