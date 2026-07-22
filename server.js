// Premier Cleaning — Crew Clock server.
// Worker phone app (/) + owner dashboard (/admin) + JSON API.
// Features: clock in/out, 30-min travel leash with auto penalties, GPS proof,
// job scheduling, per-job checklists + photo proof, payroll, announcements.
// Malta business — anchor all "today" calculations to Malta local time even on a UTC host.
process.env.TZ = process.env.TZ || 'Europe/Malta';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const ical = require('node-ical');
const webpush = require('web-push');
const { db } = require('./db');

const app = express();
app.use(express.json({ limit: '20mb' })); // room for base64 photos

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

// ---------- settings helpers ----------
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
const setSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
const travelMs = () => Number(getSetting('travel_minutes')) * 60 * 1000;
const penaltyHours = () => Number(getSetting('penalty_hours'));
const brand = () => ({ businessName: getSetting('business_name'), brandColor: getSetting('brand_color') });
// A worker's own rate if set, else the global default.
const workerRate = (w) => {
  const r = (w.hourly_rate !== null && w.hourly_rate !== undefined && w.hourly_rate !== '') ? Number(w.hourly_rate) : Number(getSetting('hourly_rate'));
  return isNaN(r) ? 0 : r;
};

// ---------- web push (phone notifications) ----------
let VAPID_PUBLIC = getSetting('vapid_public');
let VAPID_PRIVATE = getSetting('vapid_private');
if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  const keys = webpush.generateVAPIDKeys();
  VAPID_PUBLIC = keys.publicKey; VAPID_PRIVATE = keys.privateKey;
  setSetting.run('vapid_public', VAPID_PUBLIC);
  setSetting.run('vapid_private', VAPID_PRIVATE);
}
webpush.setVapidDetails('mailto:nokliginger123@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

async function sendPush(workerId, payload) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE worker_id = ?').all(workerId);
  const body = JSON.stringify(payload);
  for (const s of subs) {
    try {
      await webpush.sendNotification(JSON.parse(s.sub), body);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
    }
  }
}
function pushAll(payload) {
  for (const w of db.prepare('SELECT id FROM workers WHERE active = 1').all()) sendPush(w.id, payload);
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---------- Premier calendar (iCal) integration ----------
let calCache = { url: null, at: 0, events: [] };
async function loadCalendar() {
  const url = getSetting('calendar_ical_url');
  if (!url) return [];
  if (calCache.url === url && Date.now() - calCache.at < 120000) return calCache.events; // 2-min cache
  try {
    const data = await ical.async.fromURL(url);
    const events = Object.values(data).filter((e) => e && e.type === 'VEVENT');
    calCache = { url, at: Date.now(), events };
    return events;
  } catch (err) {
    console.error('Calendar fetch failed:', err.message);
    return calCache.url === url ? calCache.events : [];
  }
}
// Pull a labelled field out of a Premier job-sheet description (e.g. "Client: ...", "Address: ...").
function pick(desc, labels) {
  for (const l of labels) {
    const m = (desc || '').match(new RegExp(l + '\\s*:?\\s*([^\\n]+)', 'i'));
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}
function cleanTitle(s) {
  return (s || 'Job').replace(/➡️?\s*MOVED[^—]*—\s*/i, '').replace(/^[\s←-⇿\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]+/u, '').trim();
}
function toJob(e, occStart) {
  const desc = e.description || '';
  const start = occStart || e.start;
  const dateStr = start ? `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}` : '';
  return {
    uid: (e.uid || e.summary || 'job') + '::' + dateStr,
    client: (pick(desc, ['Client']).split(/[,;]/)[0].trim()) || cleanTitle(e.summary),
    title: cleanTitle(e.summary),
    address: e.location || pick(desc, ['Address', 'Property', 'Where', 'Location']) || '',
    details: desc.trim(),
    start: start ? start.getTime() : null,
    end: e.end ? e.end.getTime() : null,
  };
}
const inDay = (d, a, b) => d && d.getTime() >= a && d.getTime() < b;
async function calendarJobsForDate(dateStr) {
  const events = await loadCalendar();
  const dayStart = new Date(dateStr + 'T00:00:00').getTime();
  const dayEnd = dayStart + 24 * 3600 * 1000;
  const out = [];
  for (const e of events) {
    if (e.status === 'CANCELLED') continue;
    if (/DO NOT WORK FROM|REFERENCE COPY ONLY/i.test(e.description || '')) continue;
    try {
      if (e.rrule) {
        for (const occ of e.rrule.between(new Date(dayStart - 86400000), new Date(dayEnd + 86400000), true)) {
          if (!inDay(occ, dayStart, dayEnd)) continue;
          const key = occ.toISOString().slice(0, 10);
          if (e.exdate && e.exdate[key]) continue;
          if (e.recurrences && e.recurrences[key]) out.push(toJob(e.recurrences[key]));
          else out.push(toJob(e, occ));
        }
      } else if (inDay(e.start, dayStart, dayEnd)) {
        out.push(toJob(e));
      }
    } catch (err) { /* skip malformed event */ }
  }
  out.sort((a, b) => (a.start || 0) - (b.start || 0));
  return out;
}
// Merge calendar jobs with a worker's own assignment status for them.
function annotateForWorker(jobs, workerId) {
  return jobs.map((j) => {
    const a = db.prepare('SELECT status FROM assignments WHERE worker_id = ? AND calendar_uid = ?').get(workerId, j.uid);
    const anyone = db.prepare('SELECT w.name FROM assignments a JOIN workers w ON w.id = a.worker_id WHERE a.calendar_uid = ? AND a.worker_id != ?').all(j.uid, workerId);
    return { ...j, myStatus: a ? a.status : 'open', othersOn: anyone.map((r) => r.name) };
  });
}

// ---------- reusable statements ----------
const openShiftFor = db.prepare('SELECT * FROM shifts WHERE worker_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1');
const openJobFor = db.prepare('SELECT * FROM jobs WHERE worker_id = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1');
const lastFinishedJobFor = db.prepare('SELECT * FROM jobs WHERE worker_id = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1');

function recordLocation(workerId, body, context) {
  const { lat, lng, acc } = body || {};
  if (typeof lat === 'number' && typeof lng === 'number') {
    db.prepare('INSERT INTO locations (worker_id, lat, lng, accuracy, context, created_at) VALUES (?,?,?,?,?,?)')
      .run(workerId, lat, lng, acc ?? null, context, Date.now());
  }
}
const latestLocation = db.prepare('SELECT lat, lng, accuracy, context, created_at FROM locations WHERE worker_id = ? ORDER BY created_at DESC LIMIT 1');

// worker state: off | idle | working | traveling | late
function computeState(workerId) {
  const shift = openShiftFor.get(workerId);
  if (!shift) return { state: 'off', shift: null, job: null, deadline: null };
  const job = openJobFor.get(workerId);
  if (job) return { state: 'working', shift, job, deadline: null };
  const last = lastFinishedJobFor.get(workerId);
  if (last && last.travel_deadline && last.finished_at >= shift.clock_in) {
    if (Date.now() <= last.travel_deadline) return { state: 'traveling', shift, job: last, deadline: last.travel_deadline };
    return { state: 'late', shift, job: last, deadline: last.travel_deadline };
  }
  return { state: 'idle', shift, job: null, deadline: null };
}

function todaySummary(workerId) {
  const from = startOfToday();
  const jobsDone = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE worker_id = ? AND finished_at IS NOT NULL AND finished_at >= ?').get(workerId, from).n;
  const penRows = db.prepare('SELECT hours_docked, waived FROM penalties WHERE worker_id = ? AND created_at >= ?').all(workerId, from);
  const penalties = penRows.filter((p) => !p.waived).length;
  const hoursDocked = penRows.filter((p) => !p.waived).reduce((s, p) => s + p.hours_docked, 0);
  const shifts = db.prepare('SELECT clock_in, clock_out FROM shifts WHERE worker_id = ? AND clock_in >= ?').all(workerId, from);
  let workedMs = 0;
  for (const s of shifts) workedMs += (s.clock_out || Date.now()) - s.clock_in;
  return { jobsDone, penalties, hoursDocked, workedMinutes: Math.round(workedMs / 60000) };
}

// Assignment + its checklist + photo count, for a worker's day.
function assignmentDetail(a) {
  const checklist = db.prepare('SELECT id, text, done FROM checklist_items WHERE assignment_id = ? ORDER BY sort_order, id').all(a.id);
  const photos = db.prepare('SELECT id, filename, created_at FROM photos WHERE assignment_id = ? ORDER BY created_at').all(a.id);
  return {
    id: a.id, title: a.title, address: a.address, notes: a.notes,
    scheduledAt: a.scheduled_at, status: a.status, calendarUid: a.calendar_uid || null,
    checklist, photos: photos.map((p) => ({ id: p.id, url: `/uploads/${p.filename}`, at: p.created_at })),
    photoCount: photos.length,
  };
}
function todaysAssignments(workerId) {
  const rows = db.prepare('SELECT * FROM assignments WHERE worker_id = ? AND date = ? ORDER BY sort_order, scheduled_at, id').all(workerId, todayStr());
  return rows.map(assignmentDetail);
}

// ---------- travel-window sweep (auto penalties) ----------
function sweep() {
  const now = Date.now();
  const candidates = db.prepare(
    `SELECT j.* FROM jobs j WHERE j.finished_at IS NOT NULL AND j.travel_deadline IS NOT NULL
       AND j.travel_deadline < ? AND NOT EXISTS (SELECT 1 FROM penalties p WHERE p.job_id = j.id)`
  ).all(now);
  const insertPenalty = db.prepare(
    `INSERT INTO penalties (worker_id, job_id, created_at, minutes_late, hours_docked, reason, waived) VALUES (?,?,?,?,?,?,0)`
  );
  for (const job of candidates) {
    const nextJob = db.prepare('SELECT id FROM jobs WHERE worker_id = ? AND started_at > ? ORDER BY started_at ASC LIMIT 1').get(job.worker_id, job.finished_at);
    if (nextJob) continue;
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(job.shift_id);
    if (shift && shift.clock_out && shift.clock_out <= job.travel_deadline) continue;
    const minutesLate = Math.max(1, Math.round((now - job.travel_deadline) / 60000));
    insertPenalty.run(job.worker_id, job.id, now, minutesLate, penaltyHours(),
      `Missed the ${Number(getSetting('travel_minutes'))}-minute travel window after finishing a job`);
    sendPush(job.worker_id, { title: '⚠️ Penalty logged', body: `You went over the ${Number(getSetting('travel_minutes'))}-minute travel window. ${penaltyHours()}h will be deducted. Start your next job now.`, url: '/' });
  }
}
setInterval(sweep, 60 * 1000);
sweep();

// ---------- check-in sweep: leash workers with periodic + travel-warning pushes ----------
const warned5 = new Set(); // jobs already given a 5-minute warning
function checkInSweep() {
  const now = Date.now();
  const cm = Number(getSetting('checkin_minutes'));
  for (const shift of db.prepare('SELECT * FROM shifts WHERE clock_out IS NULL').all()) {
    const st = computeState(shift.worker_id);
    if (st.state === 'off') continue;
    // 5-minute warning while travelling
    if (st.state === 'traveling' && st.deadline && st.job) {
      const leftMs = st.deadline - now;
      if (leftMs > 0 && leftMs <= 5 * 60000 && !warned5.has(st.job.id)) {
        warned5.add(st.job.id);
        sendPush(shift.worker_id, { title: '⏰ 5 minutes left', body: 'Start your next job now, or a penalty will be logged.', url: '/' });
      }
    }
    // periodic "still on the job?" check-in
    const base = shift.last_checkin || shift.clock_in;
    if (cm > 0 && now - base >= cm * 60000) {
      db.prepare('UPDATE shifts SET last_checkin = ? WHERE id = ?').run(now, shift.id);
      sendPush(shift.worker_id, { title: '📍 Premier Cleaning check-in', body: 'Are you still on the job? Open the app to confirm and keep your clock running.', url: '/' });
    }
  }
}
setInterval(checkInSweep, 60 * 1000);

// ================= WORKER API =================
app.get('/api/config', (req, res) => res.json(brand()));

app.get('/api/workers', (req, res) => {
  res.json(db.prepare('SELECT id, name FROM workers WHERE active = 1 ORDER BY sort_order, name').all());
});

app.get('/api/me/:id', async (req, res) => {
  const id = Number(req.params.id);
  const worker = db.prepare('SELECT id, name FROM workers WHERE id = ?').get(id);
  if (!worker) return res.status(404).json({ error: 'not found' });
  const st = computeState(id);
  let currentAssignment = null;
  if (st.job && st.job.assignment_id) {
    const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(st.job.assignment_id);
    if (a) currentAssignment = assignmentDetail(a);
  }
  // latest active announcement + whether this worker has read it
  const ann = db.prepare('SELECT * FROM announcements WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get();
  let announcement = null;
  if (ann) {
    const read = db.prepare('SELECT 1 FROM announcement_reads WHERE announcement_id = ? AND worker_id = ?').get(ann.id, id);
    announcement = { id: ann.id, message: ann.message, at: ann.created_at, read: !!read };
  }
  res.json({
    worker, state: st.state, deadline: st.deadline,
    currentJob: st.job ? { id: st.job.id, name: st.job.name, startedAt: st.job.started_at, assignmentId: st.job.assignment_id } : null,
    currentAssignment,
    assignments: todaysAssignments(id),
    calendarJobs: annotateForWorker(await calendarJobsForDate(todayStr()), id),
    announcement,
    travelMinutes: Number(getSetting('travel_minutes')),
    requirePhoto: getSetting('require_photo') === '1',
    requireChecklist: getSetting('require_checklist') === '1',
    place: st.shift ? st.shift.place : null,
    checkinMinutes: Number(getSetting('checkin_minutes')),
    vapidPublic: VAPID_PUBLIC,
    summary: todaySummary(id),
    ...brand(),
    serverNow: Date.now(),
  });
});

app.post('/api/clock-in', (req, res) => {
  const id = Number(req.body.workerId);
  const place = (req.body.place || '').toString().trim().slice(0, 120) || null;
  const existing = openShiftFor.get(id);
  if (!existing) db.prepare('INSERT INTO shifts (worker_id, clock_in, place) VALUES (?, ?, ?)').run(id, Date.now(), place);
  else if (place) db.prepare('UPDATE shifts SET place = ? WHERE id = ?').run(place, existing.id);
  recordLocation(id, req.body, 'clock_in');
  res.json({ ok: true });
});

// Worker updates where they're currently working (from the app).
app.post('/api/place', (req, res) => {
  const id = Number(req.body.workerId);
  const shift = openShiftFor.get(id);
  if (shift) db.prepare('UPDATE shifts SET place = ? WHERE id = ?').run((req.body.place || '').toString().trim().slice(0, 120) || null, shift.id);
  res.json({ ok: true });
});

// Frequent live-location ping while the app is open.
app.post('/api/location', (req, res) => {
  recordLocation(Number(req.body.workerId), req.body, (req.body.context || 'ping').toString().slice(0, 20));
  res.json({ ok: true });
});

// ---- push notifications ----
app.get('/api/push/vapid', (req, res) => res.json({ key: VAPID_PUBLIC }));
app.post('/api/push/subscribe', (req, res) => {
  const id = Number(req.body.workerId);
  const sub = req.body.subscription;
  if (!id || !sub || !sub.endpoint) return res.status(400).json({ error: 'bad subscription' });
  db.prepare('INSERT INTO push_subscriptions (worker_id, endpoint, sub, created_at) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET worker_id = excluded.worker_id, sub = excluded.sub')
    .run(id, sub.endpoint, JSON.stringify(sub), Date.now());
  res.json({ ok: true });
});

app.post('/api/start-job', (req, res) => {
  const id = Number(req.body.workerId);
  const shift = openShiftFor.get(id);
  if (!shift) return res.status(400).json({ error: 'not clocked in' });
  if (openJobFor.get(id)) return res.json({ ok: true });
  const assignmentId = req.body.assignmentId ? Number(req.body.assignmentId) : null;
  let name = (req.body.name || '').toString().slice(0, 80) || null;
  if (assignmentId) {
    const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND worker_id = ?').get(assignmentId, id);
    if (a) name = a.title;
  }
  const info = db.prepare('INSERT INTO jobs (worker_id, shift_id, name, started_at, assignment_id) VALUES (?,?,?,?,?)')
    .run(id, shift.id, name, Date.now(), assignmentId);
  if (assignmentId) db.prepare("UPDATE assignments SET status='in_progress', job_id=? WHERE id=?").run(info.lastInsertRowid, assignmentId);
  recordLocation(id, req.body, 'start_job');
  res.json({ ok: true });
});

// Worker taps a client from the Premier calendar; we materialise it as their job.
app.post('/api/start-calendar-job', (req, res) => {
  const id = Number(req.body.workerId);
  const shift = openShiftFor.get(id);
  if (!shift) return res.status(400).json({ error: 'not clocked in' });
  if (openJobFor.get(id)) return res.json({ ok: true });
  const { uid, client, title, address, details, scheduledAt } = req.body;
  if (!uid) return res.status(400).json({ error: 'no job' });
  let a = db.prepare('SELECT * FROM assignments WHERE worker_id = ? AND calendar_uid = ?').get(id, uid);
  if (!a) {
    const info = db.prepare(
      'INSERT INTO assignments (worker_id, title, address, notes, date, scheduled_at, calendar_uid, status, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(id, (client || title || 'Job').toString().slice(0, 120), (address || '').toString().slice(0, 200) || null, (details || '').toString() || null, todayStr(), scheduledAt || null, uid, 'in_progress', 0, Date.now());
    a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(info.lastInsertRowid);
  }
  const jobInfo = db.prepare('INSERT INTO jobs (worker_id, shift_id, name, started_at, assignment_id) VALUES (?,?,?,?,?)').run(id, shift.id, a.title, Date.now(), a.id);
  db.prepare("UPDATE assignments SET status='in_progress', job_id=? WHERE id=?").run(jobInfo.lastInsertRowid, a.id);
  recordLocation(id, req.body, 'start_job');
  res.json({ ok: true });
});

app.get('/api/calendar', async (req, res) => {
  res.json(await calendarJobsForDate((req.query.date || todayStr()).toString()));
});

app.post('/api/finish-job', (req, res) => {
  const id = Number(req.body.workerId);
  const job = openJobFor.get(id);
  if (!job) return res.status(400).json({ error: 'no active job' });
  // Enforce checklist + photo for scheduled jobs.
  if (job.assignment_id) {
    if (getSetting('require_checklist') === '1') {
      const remaining = db.prepare('SELECT COUNT(*) AS n FROM checklist_items WHERE assignment_id = ? AND done = 0').get(job.assignment_id).n;
      if (remaining > 0) return res.status(400).json({ error: 'checklist', reason: `Tick off all ${remaining} remaining checklist item(s) first.` });
    }
    if (getSetting('require_photo') === '1') {
      const photos = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE assignment_id = ?').get(job.assignment_id).n;
      if (photos === 0) return res.status(400).json({ error: 'photo', reason: 'Add at least one photo of the finished job first.' });
    }
  }
  const now = Date.now();
  db.prepare('UPDATE jobs SET finished_at = ?, travel_deadline = ? WHERE id = ?').run(now, now + travelMs(), job.id);
  if (job.assignment_id) db.prepare("UPDATE assignments SET status='done' WHERE id=?").run(job.assignment_id);
  recordLocation(id, req.body, 'finish_job');
  res.json({ ok: true, deadline: now + travelMs() });
});

app.post('/api/clock-out', (req, res) => {
  const id = Number(req.body.workerId);
  const shift = openShiftFor.get(id);
  if (!shift) return res.json({ ok: true });
  const now = Date.now();
  const job = openJobFor.get(id);
  if (job) db.prepare('UPDATE jobs SET finished_at = ? WHERE id = ?').run(now, job.id);
  db.prepare('UPDATE shifts SET clock_out = ? WHERE id = ?').run(now, shift.id);
  recordLocation(id, req.body, 'clock_out');
  res.json({ ok: true });
});

app.post('/api/checklist/:itemId', (req, res) => {
  const done = req.body.done ? 1 : 0;
  db.prepare('UPDATE checklist_items SET done = ?, done_at = ? WHERE id = ?').run(done, done ? Date.now() : null, Number(req.params.itemId));
  res.json({ ok: true });
});

app.post('/api/photo', (req, res) => {
  const id = Number(req.body.workerId);
  const assignmentId = req.body.assignmentId ? Number(req.body.assignmentId) : null;
  const dataUrl = (req.body.dataUrl || '').toString();
  const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'bad image' });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const filename = `${crypto.randomBytes(10).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.from(m[2], 'base64'));
  db.prepare('INSERT INTO photos (assignment_id, worker_id, filename, lat, lng, created_at) VALUES (?,?,?,?,?,?)')
    .run(assignmentId, id, filename, req.body.lat ?? null, req.body.lng ?? null, Date.now());
  recordLocation(id, req.body, 'photo');
  res.json({ ok: true, url: `/uploads/${filename}` });
});

app.post('/api/announcement/:id/read', (req, res) => {
  const annId = Number(req.params.id);
  const workerId = Number(req.body.workerId);
  const seen = db.prepare('SELECT 1 FROM announcement_reads WHERE announcement_id = ? AND worker_id = ?').get(annId, workerId);
  if (!seen) db.prepare('INSERT INTO announcement_reads (announcement_id, worker_id, read_at) VALUES (?,?,?)').run(annId, workerId, Date.now());
  res.json({ ok: true });
});

// ================= ADMIN API =================
function requireAdmin(req, res, next) {
  if ((req.get('x-admin-pin') || req.query.pin) !== ADMIN_PIN) return res.status(401).json({ error: 'bad pin' });
  next();
}
app.post('/api/admin/login', (req, res) => res.json({ ok: req.body.pin === ADMIN_PIN }));

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const workers = db.prepare('SELECT id, name, hourly_rate FROM workers WHERE active = 1 ORDER BY sort_order, name').all();
  const crew = workers.map((w) => {
    const st = computeState(w.id);
    const loc = latestLocation.get(w.id);
    const assignments = todaysAssignments(w.id);
    return {
      id: w.id, name: w.name, hourlyRate: workerRate(w),
      state: st.state, deadline: st.deadline, summary: todaySummary(w.id),
      place: st.shift ? st.shift.place : null,
      location: loc ? { lat: loc.lat, lng: loc.lng, at: loc.created_at, context: loc.context } : null,
      jobsScheduled: assignments.length, jobsDoneScheduled: assignments.filter((a) => a.status === 'done').length,
    };
  });
  res.json({
    crew,
    settings: {
      travelMinutes: Number(getSetting('travel_minutes')), penaltyHours: penaltyHours(),
      hourlyRate: Number(getSetting('hourly_rate')), currency: getSetting('currency'),
      requirePhoto: getSetting('require_photo') === '1', requireChecklist: getSetting('require_checklist') === '1',
      calendarIcalUrl: getSetting('calendar_ical_url') || '',
      checkinMinutes: Number(getSetting('checkin_minutes')),
      ...brand(),
    },
    serverNow: Date.now(),
  });
});

// Workers with their pay rates (for the Workers tab).
app.get('/api/admin/workers', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, name, hourly_rate FROM workers WHERE active = 1 ORDER BY sort_order, name').all()
    .map((w) => ({ id: w.id, name: w.name, rate: (w.hourly_rate ?? null), effectiveRate: workerRate(w) })));
});
app.post('/api/admin/workers/:id/rate', requireAdmin, (req, res) => {
  const raw = req.body.rate;
  const rate = (raw === '' || raw === null || raw === undefined) ? null : Number(raw);
  db.prepare('UPDATE workers SET hourly_rate = ? WHERE id = ?').run(rate, Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/penalties', requireAdmin, (req, res) => {
  res.json(db.prepare(
    `SELECT p.*, w.name AS worker_name FROM penalties p JOIN workers w ON w.id = p.worker_id ORDER BY p.created_at DESC LIMIT 200`
  ).all());
});
app.post('/api/admin/penalties/:id/waive', requireAdmin, (req, res) => {
  db.prepare('UPDATE penalties SET waived = ? WHERE id = ?').run(req.body.waived ? 1 : 0, Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/log', requireAdmin, (req, res) => {
  const from = startOfToday();
  const events = [];
  for (const s of db.prepare(`SELECT s.*, w.name FROM shifts s JOIN workers w ON w.id = s.worker_id WHERE s.clock_in >= ?`).all(from)) {
    events.push({ t: s.clock_in, name: s.name, type: 'Clocked in' });
    if (s.clock_out) events.push({ t: s.clock_out, name: s.name, type: 'Clocked out' });
  }
  for (const j of db.prepare(`SELECT j.*, w.name FROM jobs j JOIN workers w ON w.id = j.worker_id WHERE j.started_at >= ?`).all(from)) {
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
  db.prepare('INSERT INTO workers (name, active, sort_order, created_at) VALUES (?, 1, ?, ?)').run(name, max + 1, Date.now());
  res.json({ ok: true });
});
app.post('/api/admin/workers/:id/remove', requireAdmin, (req, res) => {
  db.prepare('UPDATE workers SET active = 0 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const allowed = ['travel_minutes', 'penalty_hours', 'hourly_rate', 'currency', 'business_name', 'brand_color', 'require_photo', 'require_checklist', 'calendar_ical_url', 'checkin_minutes'];
  for (const key of allowed) if (req.body[key] !== undefined) setSetting.run(key, String(req.body[key]));
  res.json({ ok: true });
});

// ---- scheduling ----
app.get('/api/admin/assignments', requireAdmin, (req, res) => {
  const date = (req.query.date || todayStr()).toString();
  const rows = db.prepare(
    `SELECT a.*, w.name AS worker_name FROM assignments a JOIN workers w ON w.id = a.worker_id
     WHERE a.date = ? ORDER BY w.sort_order, a.sort_order, a.scheduled_at, a.id`
  ).all(date);
  res.json(rows.map((r) => ({ ...assignmentDetail(r), workerId: r.worker_id, workerName: r.worker_name, date: r.date })));
});

app.post('/api/admin/assignments', requireAdmin, (req, res) => {
  const { workerId, title, address, notes, date, time, checklist } = req.body;
  if (!workerId || !title) return res.status(400).json({ error: 'worker and title required' });
  const d = (date || todayStr()).toString();
  // DEDUP: the same worker + title + date is the same job — return the existing
  // assignment instead of stacking duplicates (restarts used to pile these up).
  const dup = db.prepare('SELECT id FROM assignments WHERE worker_id = ? AND title = ? AND date = ?').get(Number(workerId), title.toString().slice(0, 120), d);
  if (dup) return res.json({ ok: true, id: dup.id, deduped: true });
  let scheduledAt = null;
  if (time) { const dt = new Date(`${d}T${time}:00`); if (!isNaN(dt)) scheduledAt = dt.getTime(); }
  const max = db.prepare('SELECT MAX(sort_order) AS m FROM assignments WHERE worker_id = ? AND date = ?').get(Number(workerId), d).m || 0;
  const info = db.prepare(
    'INSERT INTO assignments (worker_id, title, address, notes, date, scheduled_at, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(Number(workerId), title.toString().slice(0, 120), (address || '').toString().slice(0, 200) || null, (notes || '').toString().slice(0, 500) || null, d, scheduledAt, max + 1, Date.now());
  const items = Array.isArray(checklist) ? checklist : (checklist || '').toString().split('\n');
  let i = 0;
  for (const raw of items) {
    const text = raw.toString().trim();
    if (text) db.prepare('INSERT INTO checklist_items (assignment_id, text, sort_order) VALUES (?,?,?)').run(info.lastInsertRowid, text.slice(0, 120), i++);
  }
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.post('/api/admin/assignments/:id/remove', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM checklist_items WHERE assignment_id = ?').run(id);
  db.prepare('DELETE FROM assignments WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.get('/api/admin/assignment/:id', requireAdmin, (req, res) => {
  const a = db.prepare('SELECT a.*, w.name AS worker_name FROM assignments a JOIN workers w ON w.id = a.worker_id WHERE a.id = ?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'not found' });
  const photos = db.prepare('SELECT id, filename, lat, lng, created_at FROM photos WHERE assignment_id = ? ORDER BY created_at').all(a.id);
  res.json({
    ...assignmentDetail(a), workerName: a.worker_name, date: a.date,
    photos: photos.map((p) => ({ id: p.id, url: `/uploads/${p.filename}`, at: p.created_at, lat: p.lat, lng: p.lng })),
  });
});

// ---- calendar (owner view: which workers are on each job) ----
app.get('/api/admin/calendar', requireAdmin, async (req, res) => {
  const jobs = await calendarJobsForDate((req.query.date || todayStr()).toString());
  res.json(jobs.map((j) => ({
    ...j,
    workers: db.prepare('SELECT w.name, a.status FROM assignments a JOIN workers w ON w.id = a.worker_id WHERE a.calendar_uid = ?').all(j.uid),
  })));
});

// ---- announcements ----
app.get('/api/admin/announcements', requireAdmin, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM workers WHERE active = 1').get().n;
  const rows = db.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 50').all();
  res.json(rows.map((a) => ({
    id: a.id, message: a.message, active: !!a.active, at: a.created_at,
    reads: db.prepare('SELECT COUNT(*) AS n FROM announcement_reads WHERE announcement_id = ?').get(a.id).n,
    totalWorkers: total,
  })));
});
app.post('/api/admin/announcements', requireAdmin, (req, res) => {
  const message = (req.body.message || '').toString().trim().slice(0, 500);
  if (!message) return res.status(400).json({ error: 'message required' });
  db.prepare('INSERT INTO announcements (message, active, created_at) VALUES (?,1,?)').run(message, Date.now());
  pushAll({ title: '📣 ' + getSetting('business_name'), body: message, url: '/' });
  res.json({ ok: true });
});
app.post('/api/admin/announcements/:id/deactivate', requireAdmin, (req, res) => {
  db.prepare('UPDATE announcements SET active = 0 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- payroll ----
app.get('/api/admin/payroll', requireAdmin, (req, res) => {
  // weekStart = local YYYY-MM-DD (Monday). Defaults to Monday of the current week.
  let start;
  if (req.query.weekStart) start = new Date(`${req.query.weekStart}T00:00:00`);
  else { start = new Date(); start.setHours(0, 0, 0, 0); const dow = (start.getDay() + 6) % 7; start.setDate(start.getDate() - dow); }
  const from = start.getTime();
  const to = from + 7 * 24 * 60 * 60 * 1000;
  const currency = getSetting('currency');
  const workers = db.prepare('SELECT id, name, hourly_rate FROM workers WHERE active = 1 ORDER BY sort_order, name').all();
  const rows = workers.map((w) => {
    const rate = workerRate(w); // each worker's own rate
    const shifts = db.prepare('SELECT clock_in, clock_out FROM shifts WHERE worker_id = ? AND clock_in >= ? AND clock_in < ?').all(w.id, from, to);
    let ms = 0; const days = new Set();
    for (const s of shifts) { ms += (s.clock_out || Date.now()) - s.clock_in; days.add(new Date(s.clock_in).toDateString()); }
    const hours = ms / 3600000;
    const pens = db.prepare('SELECT hours_docked, waived FROM penalties WHERE worker_id = ? AND created_at >= ? AND created_at < ?').all(w.id, from, to);
    const activePens = pens.filter((p) => !p.waived);
    const docked = activePens.reduce((s, p) => s + p.hours_docked, 0);
    const net = Math.max(0, hours - docked);
    return {
      id: w.id, name: w.name, rate, days: days.size, hours: +hours.toFixed(2),
      penalties: activePens.length, hoursDocked: +docked.toFixed(2), netHours: +net.toFixed(2),
      pay: rate > 0 ? +(net * rate).toFixed(2) : null,
    };
  });
  const anyRate = rows.some((r) => r.rate > 0);
  const fmt = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  res.json({ weekStart: fmt(from), weekEnd: fmt(to - 86400000), rate: anyRate ? 1 : 0, currency, rows });
});

// ---- today's timesheet + earnings ----
app.get('/api/admin/today', requireAdmin, (req, res) => {
  const dateStr = (req.query.date || todayStr()).toString();
  const dayStart = new Date(dateStr + 'T00:00:00').getTime();
  const dayEnd = dayStart + 86400000;
  const currency = getSetting('currency');
  const now = Date.now();
  const rows = db.prepare(
    `SELECT s.id AS shiftId, s.worker_id, s.clock_in, s.clock_out, s.place, w.name, w.hourly_rate
     FROM shifts s JOIN workers w ON w.id = s.worker_id
     WHERE s.clock_in >= ? AND s.clock_in < ? ORDER BY s.clock_in`
  ).all(dayStart, dayEnd);
  let totHours = 0, totPay = 0, openCount = 0;
  const out = rows.map((r) => {
    const rate = workerRate(r);
    const end = r.clock_out || now;
    const hours = Math.max(0, (end - r.clock_in) / 3600000);
    const pay = rate * hours;
    if (!r.clock_out) openCount++;
    totHours += hours; totPay += pay;
    return { shiftId: r.shiftId, workerId: r.worker_id, name: r.name, rate, place: r.place || null,
      clockIn: r.clock_in, clockOut: r.clock_out, open: !r.clock_out, hours: +hours.toFixed(2), pay: +pay.toFixed(2) };
  });
  res.json({ date: dateStr, currency, rows: out, totals: { hours: +totHours.toFixed(2), pay: +totPay.toFixed(2), openCount } });
});

// ---- full wages report (all time, per worker, per shift) ----
app.get('/api/admin/wages', requireAdmin, (req, res) => {
  const now = Date.now();
  const currency = getSetting('currency');
  const workers = db.prepare('SELECT id, name, hourly_rate FROM workers ORDER BY sort_order, name').all();
  let grandHours = 0, grandPay = 0, suspects = 0;
  const out = workers.map((w) => {
    const rate = workerRate(w);
    const shifts = db.prepare('SELECT * FROM shifts WHERE worker_id = ? ORDER BY clock_in').all(w.id).map((s) => {
      const end = s.clock_out || now;
      const hours = Math.max(0, (end - s.clock_in) / 3600000);
      // flag impossible shifts: longer than 14h, or an accidental tap under 5 minutes
      const suspect = hours > 14 || hours < 0.08;
      if (suspect) suspects++;
      return { shiftId: s.id, clockIn: s.clock_in, clockOut: s.clock_out, open: !s.clock_out,
        place: s.place || null, hours: +hours.toFixed(2), pay: +(hours * rate).toFixed(2), suspect };
    });
    const hours = shifts.reduce((a, b) => a + b.hours, 0);
    const pay = shifts.reduce((a, b) => a + b.pay, 0);
    grandHours += hours; grandPay += pay;
    return { id: w.id, name: w.name, rate, shifts, hours: +hours.toFixed(2), pay: +pay.toFixed(2) };
  }).filter((w) => w.shifts.length);
  res.json({ currency, workers: out, totals: { hours: +grandHours.toFixed(2), pay: +grandPay.toFixed(2), suspects } });
});

// Remove a shift entirely (takes its wages off the bill).
// Cascades: a shift's jobs (and any penalties on them) must go first, or the
// foreign key blocks the delete.
app.post('/api/admin/shifts/:id/delete', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  try {
    const jobIds = db.prepare('SELECT id FROM jobs WHERE shift_id = ?').all(id).map((j) => j.id);
    for (const jid of jobIds) {
      db.prepare('DELETE FROM penalties WHERE job_id = ?').run(jid);
      db.prepare("UPDATE assignments SET job_id = NULL, status = 'assigned' WHERE job_id = ?").run(jid);
    }
    db.prepare('DELETE FROM jobs WHERE shift_id = ?').run(id);
    db.prepare('DELETE FROM shifts WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) {
    console.error('shift delete failed', e.message);
    res.status(500).json({ error: 'Could not delete: ' + e.message });
  }
});

// Owner edits a shift's clock-in / clock-out (epoch ms from the browser).
app.post('/api/admin/shifts/:id', requireAdmin, (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(req.params.id));
  if (!shift) return res.status(404).json({ error: 'not found' });
  let ci = shift.clock_in, co = shift.clock_out;
  if (req.body.clockInMs != null) ci = Number(req.body.clockInMs);
  if (req.body.clockOutMs !== undefined) co = req.body.clockOutMs ? Number(req.body.clockOutMs) : null;
  if (!ci || isNaN(ci)) return res.status(400).json({ error: 'bad clock-in' });
  if (co != null && co <= ci) return res.status(400).json({ error: 'Clock-out must be after clock-in.' });
  db.prepare('UPDATE shifts SET clock_in = ?, clock_out = ? WHERE id = ?').run(ci, co, shift.id);
  res.json({ ok: true });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ---------- Bot bookings mirrored into the calendar ----------
// The WhatsApp bot upserts EVERY booking here (ref "pcm-<id>") so the
// subscribed Google Calendar shows the full schedule, assigned or not.
db.exec(`CREATE TABLE IF NOT EXISTS calendar_events (
  ref          TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  date         TEXT NOT NULL,
  time         TEXT,
  duration_min INTEGER DEFAULT 180,
  address      TEXT,
  notes        TEXT,
  status       TEXT DEFAULT 'confirmed',
  updated_at   INTEGER
);`);

app.post('/api/admin/calendar-events', requireAdmin, (req, res) => {
  const { ref, title, date, time, durationMin, address, notes, status } = req.body || {};
  if (!ref || !title || !date) return res.status(400).json({ error: 'ref, title, date required' });
  if (status === 'cancelled') {
    db.prepare('DELETE FROM calendar_events WHERE ref = ?').run(String(ref));
    return res.json({ ok: true, removed: true });
  }
  db.prepare(`INSERT INTO calendar_events (ref, title, date, time, duration_min, address, notes, status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(ref) DO UPDATE SET title=excluded.title, date=excluded.date, time=excluded.time,
        duration_min=excluded.duration_min, address=excluded.address, notes=excluded.notes,
        status=excluded.status, updated_at=excluded.updated_at`)
    .run(String(ref), String(title).slice(0, 140), String(date), time ? String(time) : null,
      Number(durationMin) || 180, address ? String(address).slice(0, 200) : null,
      notes ? String(notes).slice(0, 400) : null, status || 'confirmed', Date.now());
  res.json({ ok: true });
});

// ---------- Calendar feed (subscribe from Google Calendar → "From URL") ----------
// All crew assignments (past 7 days → next 60) as iCal. Add once in Google
// Calendar: Settings → Add calendar → From URL → this address. It then stays
// in sync automatically (jobs the WhatsApp bot or admin dispatches included).
app.get('/calendar.ics', (req, res) => {
  if ((req.query.pin || '') !== ADMIN_PIN) return res.status(401).send('bad pin');
  const rows = db.prepare(`
    SELECT a.*, w.name AS worker FROM assignments a
    JOIN workers w ON w.id = a.worker_id
    WHERE a.date >= date('now','-7 days') AND a.date <= date('now','+60 days')
      AND a.status != 'skipped'
    ORDER BY a.date, a.scheduled_at`).all();
  const pad = (n) => String(n).padStart(2, '0');
  // scheduled_at was parsed on this (UTC) server from Malta wall-clock text, so
  // UTC getters recover the intended wall time; we label it TZID Europe/Malta.
  const fmtWall = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Premier Cleaning//CrewClock//EN',
    'CALSCALE:GREGORIAN', 'X-WR-CALNAME:PCM Jobs', 'X-WR-TIMEZONE:Europe/Malta'];

  // Bot bookings (the full schedule, assigned or not).
  const events = db.prepare(`SELECT * FROM calendar_events
    WHERE date >= date('now','-7 days') AND date <= date('now','+60 days') ORDER BY date, time`).all();
  const bookingRefs = new Set(events.map((e) => e.ref));
  for (const e of events) {
    const start = new Date(`${e.date}T${e.time || '08:00'}:00Z`);
    const end = new Date(start.getTime() + (e.duration_min || 180) * 60000);
    L.push('BEGIN:VEVENT');
    L.push(`UID:${e.ref}@premier-cleaning-crew`);
    L.push(`DTSTART;TZID=Europe/Malta:${fmtWall(start)}`);
    L.push(`DTEND;TZID=Europe/Malta:${fmtWall(end)}`);
    L.push(`SUMMARY:${esc(e.title)}`);
    if (e.address) L.push(`LOCATION:${esc(e.address)}`);
    if (e.notes) L.push(`DESCRIPTION:${esc(e.notes)}`);
    L.push('END:VEVENT');
  }

  // Crew assignments — skipping ones that mirror a bot booking (job #N ↔ pcm-N)
  // so the calendar shows each job once.
  for (const a of rows) {
    const jobRef = (a.title || '').match(/job #(\d+)/i);
    if (jobRef && bookingRefs.has(`pcm-${jobRef[1]}`)) continue;
    const start = a.scheduled_at ? new Date(a.scheduled_at) : new Date(`${a.date}T08:00:00Z`);
    const end = new Date(start.getTime() + 3 * 3600 * 1000);
    L.push('BEGIN:VEVENT');
    L.push(`UID:ccass-${a.id}@premier-cleaning-crew`);
    L.push(`DTSTART;TZID=Europe/Malta:${fmtWall(start)}`);
    L.push(`DTEND;TZID=Europe/Malta:${fmtWall(end)}`);
    L.push(`SUMMARY:${esc(`${a.title} — ${a.worker}${a.status === 'done' ? ' ✅' : ''}`)}`);
    if (a.address) L.push(`LOCATION:${esc(a.address)}`);
    if (a.notes) L.push(`DESCRIPTION:${esc(a.notes)}`);
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.send(L.join('\r\n'));
});

app.listen(PORT, () => {
  console.log(`${getSetting('business_name')} Crew Clock running on http://localhost:${PORT}`);
  console.log(`Owner dashboard: http://localhost:${PORT}/admin  (PIN: ${ADMIN_PIN})`);
});
