// server.js
// Admin UI backend: session-based login + CRUD API for:
//   - recipients (subscribers): now email + user_id pairs — each recipient
//     gets their own report filtered to their own user_id
//   - observer emails: get a separate copy of every per-user_id email sent
//   - message template (subject/body sent by the cron job)
//   - report send / history (manual re-run from the dashboard)
//
// Setup:
//   npm install express express-session mysql2 bcryptjs dotenv
//
// Required environment variables (see .env.example):
//   DB_HOST, DB_USER, DB_PASSWORD, DB_NAME
//   ADMIN_USERNAME, ADMIN_PASSWORD_HASH   (hash generated with bcrypt, see setup docs)
//   SESSION_SECRET
//   PORT (optional, defaults to 3003)

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3003;

// Must match REPORT_DOWNLOADS_DIR in lib/report-job.js.
const REPORT_DOWNLOADS_DIR = process.env.REPORT_DOWNLOADS_DIR || '/var/report-downloads';

// ---------- DB POOL ----------
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'db_user',
  password: process.env.DB_PASSWORD || 'db_password',
  database: process.env.DB_NAME || 'your_database',
  waitForConnections: true,
  connectionLimit: 5,
});

// ---------- MIDDLEWARE ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
      // secure: true, // enable once served over HTTPS
    },
  })
);
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session && req.session.isAuthenticated) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login.html');
}

// ---------- AUTH ROUTES ----------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  const validUsername = process.env.ADMIN_USERNAME;
  const validHash = process.env.ADMIN_PASSWORD_HASH;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (username !== validUsername) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const match = await bcrypt.compare(password, validHash || '');
  if (!match) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.isAuthenticated = true;
  req.session.username = username;
  return res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/session', (req, res) => {
  res.json({ isAuthenticated: !!(req.session && req.session.isAuthenticated) });
});

// ---------- PROTECT EVERYTHING BELOW ----------
app.use((req, res, next) => {
  if (
    req.path === '/login.html' ||
    req.path === '/api/login' ||
    req.path === '/api/session' ||
    req.path.startsWith('/css/') ||
    req.path.startsWith('/js/') ||
    req.path.startsWith('/reports/download/')
  ) {
    return next();
  }
  return requireAuth(req, res, next);
});

// Root serves the dashboard (protected)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ======================================================================
// RECIPIENTS (subscribers) — each row is one (email, user_id) pair
// ======================================================================

// LIST all recipients
app.get('/api/recipients', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, email, user_id, active, created_at FROM subscribers ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch recipients' });
  }
});

// CREATE a recipient (email + user_id pair)
app.post('/api/recipients', async (req, res) => {
  const { email, user_id } = req.body;

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  const userId = Number(user_id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'A valid user_id (positive integer) is required' });
  }

  try {
    const [result] = await pool.execute(
      'INSERT INTO subscribers (email, user_id, active) VALUES (?, ?, 1)',
      [email.trim().toLowerCase(), userId]
    );
    res.status(201).json({ id: result.insertId, email, user_id: userId, active: 1 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'This email is already linked to this user_id' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create recipient' });
  }
});

// UPDATE a recipient (email, user_id, and/or active status)
app.put('/api/recipients/:id', async (req, res) => {
  const { id } = req.params;
  const { email, user_id, active } = req.body;

  if (email !== undefined && !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }
  if (user_id !== undefined) {
    const userId = Number(user_id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'A valid user_id (positive integer) is required' });
    }
  }

  try {
    const fields = [];
    const values = [];
    if (email !== undefined) {
      fields.push('email = ?');
      values.push(email.trim().toLowerCase());
    }
    if (user_id !== undefined) {
      fields.push('user_id = ?');
      values.push(Number(user_id));
    }
    if (active !== undefined) {
      fields.push('active = ?');
      values.push(active ? 1 : 0);
    }
    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    values.push(id);

    const [result] = await pool.execute(
      `UPDATE subscribers SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Recipient not found' });
    }
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'This email is already linked to this user_id' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to update recipient' });
  }
});

// DELETE a recipient
app.delete('/api/recipients/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.execute('DELETE FROM subscribers WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Recipient not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete recipient' });
  }
});

// ======================================================================
// OBSERVER EMAILS — receive a separate copy of every per-user_id email
// ======================================================================

app.get('/api/observers', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, email, active, created_at FROM observer_emails ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch observer emails' });
  }
});

app.post('/api/observers', async (req, res) => {
  const { email } = req.body;
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  try {
    const [result] = await pool.execute(
      'INSERT INTO observer_emails (email, active) VALUES (?, 1)',
      [email.trim().toLowerCase()]
    );
    res.status(201).json({ id: result.insertId, email, active: 1 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'This email already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to add observer email' });
  }
});

app.put('/api/observers/:id', async (req, res) => {
  const { id } = req.params;
  const { email, active } = req.body;

  if (email !== undefined && !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  try {
    const fields = [];
    const values = [];
    if (email !== undefined) {
      fields.push('email = ?');
      values.push(email.trim().toLowerCase());
    }
    if (active !== undefined) {
      fields.push('active = ?');
      values.push(active ? 1 : 0);
    }
    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    values.push(id);

    const [result] = await pool.execute(
      `UPDATE observer_emails SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Observer email not found' });
    }
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'This email already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to update observer email' });
  }
});

app.delete('/api/observers/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.execute('DELETE FROM observer_emails WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Observer email not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete observer email' });
  }
});

// ---------- MESSAGE TEMPLATE (subject/body sent by the cron job) ----------

// GET the current template (single row, id = 1)
app.get('/api/message-template', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT subject, body, updated_at FROM message_templates WHERE id = 1'
    );
    if (rows.length === 0) {
      return res.json({ subject: '', body: '' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch message template' });
  }
});

// UPDATE the template
app.put('/api/message-template', async (req, res) => {
  const { subject, body } = req.body;

  if (!subject || !subject.trim()) {
    return res.status(400).json({ error: 'Subject is required' });
  }
  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Message body is required' });
  }

  try {
    await pool.execute(
      `INSERT INTO message_templates (id, subject, body) VALUES (1, ?, ?)
       ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body)`,
      [subject.trim(), body]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update message template' });
  }
});

// ---------- REPORT SEND / HISTORY (manual re-run from the dashboard) ----------
const { sendReportForDate, getReportRuns, isValidDate } = require('./lib/report-job');

// Trigger a generate + send for a specific date. This does NOT wait for
// the job to finish — large reports (hundreds of thousands of rows) can
// take minutes, well past any reverse proxy's default timeout (nginx's
// default is ~60s), which would otherwise return a 504 to the browser
// even though the job kept running fine in the background. Instead, this
// responds immediately once the job is kicked off, and progress/results
// are visible in the Report Runs table (GET /api/reports) as each
// recipient's send completes.
app.post('/api/reports/send', async (req, res) => {
  const { date } = req.body;

  if (!date || !isValidDate(date)) {
    return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required' });
  }

  // Fire and forget — errors are already logged per-recipient inside
  // sendReportForDate via report_runs. Catch anything that escapes that
  // (e.g. a missing message template) so it doesn't crash the process.
  sendReportForDate(date).catch((err) => {
    console.error(`Report send for ${date} failed before completing:`, err.message);
  });

  res.status(202).json({ started: true, reportDate: date });
});

// Recent run history (paginated) — for showing which date/user_id/recipient
// combos succeeded or failed, 10 at a time, queryable backward.
app.get('/api/reports', async (req, res) => {
  const limit = Number(req.query.limit) || 10;
  const offset = Number(req.query.offset) || 0;

  try {
    const result = await getReportRuns(limit, offset);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch report history' });
  }
});

// ---------- REPORT DOWNLOAD (public, token-based — recipients don't log in) ----------

// Serves a generated report by its random token. The token itself is the
// only credential — 24 random bytes (48 hex chars) is effectively
// unguessable, and the route only ever accepts an exact match against
// that fixed format, so there's no directory listing or enumeration
// surface. :filename is cosmetic only (sets the downloaded file's name);
// it plays no role in locating the file.
app.get('/reports/download/:token/:filename', (req, res) => {
  const { token, filename } = req.params;

  if (!/^[a-f0-9]{48}$/.test(token)) {
    return res.status(400).send('Invalid or malformed download link.');
  }

  const filePath = path.join(REPORT_DOWNLOADS_DIR, `${token}.xlsx`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('This download link has expired or does not exist.');
  }

  const safeName = (filename || 'report.xlsx').replace(/[^a-zA-Z0-9._-]/g, '_');
  res.download(filePath, safeName);
});

app.listen(PORT, () => {
  console.log(`Recipient admin UI running on http://localhost:${PORT}`);
});
