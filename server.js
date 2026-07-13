// Crew Clock — server.
// Serves the worker phone app (/) and the owner dashboard (/admin),
// plus a small JSON API. Runs a once-a-minute sweep that auto-logs a
// penalty when a worker misses their travel window.
const path = require('path');
const express = require('express');
const { db } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234'; // change this in the cloud!

// ---------- helpers ----------
const getSetting = (key) =>
  db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
const setSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
const travelMs = () => Number(getSetting('travel_minutes')) * 60 * 1000;
const penaltyHours = () => Number(getSetting('penalty_hours'));

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// Statements reused a lot.
const openShiftFor = db.prepare(
  'SELECT * FROM shifts WHERE worker_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1'
);
const openJobFor = db.prepare(
  'SELECT * FROM jobs WHERE worker_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1'
);
const lastFinishedJobFor = db.prepare(
  'SELECT * FROM jobs WHERE worker_id = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1'
);

// Work out what a worker is doing right now.
// States: off | idle | working | traveling | late
function computeState(workerId) {
  const shift = openShiftFor.get(workerId);
  if (!shift) return { state: 'off', shift: null, job: null, deadline: null };

  const job = openJobFor.get(workerId);
  if (job) return { state: 'working', shift, job, deadline: null };

  // Clocked in but no open job: either idle or traveling to the next job.
  const last = lastFinishedJobFor.get(workerId);
  if (last && last.travel_deadline && last.finished_at >= shift.clock_in) {
    const now = Date.now();
    if (now <= last.travel_deadline) {
      return { state: 'traveling', shift, job: last, deadline: last.travel_deadline };
    }
    // Past the window. Was a penalty already recorded for this job?
    const pen = db
      .prepare('SELECT id FROM penalties WHERE job_id = ?')
      .get(last.id);
    if (pen) return { state: 'late', shift, job: last, deadline: last.travel_deadline };
    // No penalty logged yet (sweep may not have run) — treat as late.
    return { state: 'late', shift, job: last, deadline: last.travel_deadline };
  }
  return { state: 'idle', shift, job: null, deadline: null };
}

// Today's summary numbers for one worker.
function todaySummary(workerId) {
  const from = startOfToday();
  const jobsDone = db
    .prepare(
      'SELECT COUNT(*) AS n FROM jobs WHERE worker_id = ? AND finished_at IS NOT NULL AND finished_at >= ?'
    )
    .get(workerId, from).n;

  const penRows = db
    .prepare(
      'SELECT hours_docked, waived FROM penalties WHERE worker_id = ? AND created_at >= ?'
    )
    .all(workerId, from);
  const penalties = penRows.filter((p) => !p.waived).length;
  const hoursDocked = penRows
    .filter((p) => !p.waived)
    .reduce((s, p) => s + p.hours_docked, 0);

  // Worked minutes today across shifts (open shift counts up to now).
  const shifts = db
    .prepare('SELECT clock_in, clock_out FROM shifts WHERE worker_id = ? AND clock_in >= ?')
    .all(workerId, from);
  let workedMs = 0;
  for (const s of shifts) workedMs += (s.clock_out || Date.now()) - s.clock_in;

  return { jobsDone, penalties, hoursDocked, workedMinutes: Math.round(workedMs / 60000) };
}

// The sweep: catch anyone who ran out of travel time and hasn't been penalised.
function sweep() {
  const now = Date.now();
  const candidates = db
    .prepare(
      `SELECT j.* FROM jobs j
       WHERE j.finished_at IS NOT NULL
         AND j.travel_deadline IS NOT NULL
         AND j.travel_deadline < ?
         AND NOT EXISTS (SELECT 1 FROM penalties p WHERE p.job_id = j.id)`
    )
    .all(now);

  const insertPenalty = db.prepare(
    `INSERT INTO penalties (worker_id, job_id, created_at, minutes_late, hours_docked, reason, waived)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  );

  for (const job of candidates) {
    // Did they start another job after this one finished? Then they were on time.
    const nextJob = db
      .prepare(
        'SELECT id FROM jobs WHERE worker_id = ? AND started_at > ? ORDER BY started_at ASC LIMIT 1'
      )
      .get(job.worker_id, job.finished_at);
    if (nextJob) continue; // moved on in time (they beat the deadline)

    // Did they clock out during the window? Then no penalty (end of day).
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(job.shift_id);
    if (shift && shift.clock_out && shift.clock_out <= job.travel_deadline) continue;

    const minutesLate = Math.max(1, Math.round((now - job.travel_deadline) / 60000));
    insertPenalty.run(
      job.worker_id,
      job.id,
      now,
      minutesLate,
      penaltyHours(),
      `Missed the ${Number(getSetting('travel_minutes'))}-minute travel window after finishing a job`
    );
  }
}
setInterval(sweep, 60 * 1000);
sweep();

// ---------- worker API ----------
app.get('/api/workers', (req, res) => {
  const rows = db
    .prepare('SELECT id, name FROM workers WHERE active = 1 ORDER BY sort_order, name')
    .all();
  res.json(rows);
});

app.get('/api/me/:id', (req, res) => {
  const id = Number(req.params.id);
  const worker = db.prepare('SELECT id, name FROM workers WHERE id = ?').get(id);
  if (!worker) return res.status(404).json({ error: 'not found' });
  const st = computeState(id);
  res.json({
    worker,
    state: st.state,
    deadline: st.deadline,
    currentJob: st.job ? { id: st.job.id, name: st.job.name, startedAt: st.job.started_at } : null,
    travelMinutes: Number(getSetting('travel_minutes')),
    summary: todaySummary(id),
    serverNow: Date.now(),
  });
});

app.post('/api/clock-in', (req, res) => {
  const id = Number(req.body.workerId);
  if (openShiftFor.get(id)) return res.json({ ok: true }); // already in
  db.prepare('INSERT INTO shifts (worker_id, clock_in) VALUES (?, ?)').run(id, Date.now());
  res.json({ ok: true });
});

app.post('/api/start-job', (req, res) => {
  const id = Number(req.body.workerId);
  const shift = openShiftFor.get(id);
  if (!shift) return res.status(400).json({ error: 'not clocked in' });
  if (openJobFor.get(id)) return res.json({ ok: true }); // already on a job
  const name = (req.body.name || '').toString().slice(0, 80) || null;
  db.prepare(
    'INSERT INTO jobs (worker_id, shift_id, name, started_at) VALUES (?, ?, ?, ?)'
  ).run(id, shift.id, name, Date.now());
  res.json({ ok: true });
});

app.post('/api/finish-job', (req, res) => {
  const id = Number(req.body.workerId);
  const job = openJobFor.get(id);
  if (!job) return res.status(400).json({ error: 'no active job' });
  const now = Date.now();
  db.prepare('UPDATE jobs SET finished_at = ?, travel_deadline = ? WHERE id = ?').run(
    now,
    now + travelMs(),
    job.id
  );
  res.json({ ok: true, deadline: now + travelMs() });
});

app.post('/api/clock-out', (req, res) => {
  const id = Number(req.body.workerId);
  const shift = openShiftFor.get(id);
  if (!shift) return res.json({ ok: true });
  const now = Date.now();
  // Auto-finish any dangling open job (no travel timer — they're going home).
  const job = openJobFor.get(id);
  if (job) db.prepare('UPDATE jobs SET finished_at = ? WHERE id = ?').run(now, job.id);
  db.prepare('UPDATE shifts SET clock_out = ? WHERE id = ?').run(now, shift.id);
  res.json({ ok: true });
});

// ---------- admin API ----------
function requireAdmin(req, res, next) {
  const pin = req.get('x-admin-pin') || req.query.pin;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'bad pin' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  res.json({ ok: req.body.pin === ADMIN_PIN });
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const workers = db
    .prepare('SELECT id, name FROM workers WHERE active = 1 ORDER BY sort_order, name')
    .all();
  const rate = Number(getSetting('hourly_rate'));
  const currency = getSetting('currency');
  const crew = workers.map((w) => {
    const st = computeState(w.id);
    return { ...w, state: st.state, deadline: st.deadline, summary: todaySummary(w.id) };
  });
  res.json({
    crew,
    settings: {
      travelMinutes: Number(getSetting('travel_minutes')),
      penaltyHours: penaltyHours(),
      hourlyRate: rate,
      currency,
    },
    serverNow: Date.now(),
  });
});

app.get('/api/admin/penalties', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, w.name AS worker_name FROM penalties p
       JOIN workers w ON w.id = p.worker_id
       ORDER BY p.created_at DESC LIMIT 200`
    )
    .all();
  res.json(rows);
});

app.post('/api/admin/penalties/:id/waive', requireAdmin, (req, res) => {
  const waived = req.body.waived ? 1 : 0;
  db.prepare('UPDATE penalties SET waived = ? WHERE id = ?').run(waived, Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/log', requireAdmin, (req, res) => {
  const from = startOfToday();
  const events = [];
  const shifts = db
    .prepare(
      `SELECT s.*, w.name FROM shifts s JOIN workers w ON w.id = s.worker_id
       WHERE s.clock_in >= ? ORDER BY s.clock_in DESC`
    )
    .all(from);
  for (const s of shifts) {
    events.push({ t: s.clock_in, name: s.name, type: 'Clocked in' });
    if (s.clock_out) events.push({ t: s.clock_out, name: s.name, type: 'Clocked out' });
  }
  const jobs = db
    .prepare(
      `SELECT j.*, w.name FROM jobs j JOIN workers w ON w.id = j.worker_id
       WHERE j.started_at >= ? ORDER BY j.started_at DESC`
    )
    .all(from);
  for (const j of jobs) {
    events.push({ t: j.started_at, name: j.name, type: 'Started job' + (j.name ? ` (${j.name})` : '') });
    if (j.finished_at) events.push({ t: j.finished_at, name: j.name, type: 'Finished job' });
  }
  events.sort((a, b) => b.t - a.t);
  res.json(events.slice(0, 100));
});

app.post('/api/admin/workers', requireAdmin, (req, res) => {
  const name = (req.body.name || '').toString().trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name required' });
  const max = db.prepare('SELECT MAX(sort_order) AS m FROM workers').get().m || 0;
  db.prepare(
    'INSERT INTO workers (name, active, sort_order, created_at) VALUES (?, 1, ?, ?)'
  ).run(name, max + 1, Date.now());
  res.json({ ok: true });
});

app.post('/api/admin/workers/:id/remove', requireAdmin, (req, res) => {
  db.prepare('UPDATE workers SET active = 0 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const allowed = ['travel_minutes', 'penalty_hours', 'hourly_rate', 'currency'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) setSetting.run(key, String(req.body[key]));
  }
  res.json({ ok: true });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, () => {
  console.log(`Crew Clock running on http://localhost:${PORT}`);
  console.log(`Owner dashboard: http://localhost:${PORT}/admin  (PIN: ${ADMIN_PIN})`);
});
