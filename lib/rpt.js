// lib/report-job.js
//
// Core report generation + send logic, shared by:
//   - cron/send-daily-report.js (scheduled daily run)
//   - server.js's POST /api/reports/send (manual re-run for a specific date
//     from the admin dashboard, e.g. after a failure)
//
// Every run — whether from cron or triggered manually — is logged to the
// report_runs table so failures are visible and a date can be re-sent as
// many times as needed regardless of its previous outcome.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { exec } = require('child_process');
const zlib = require('zlib');
const mysql = require('mysql2/promise');
const { sendMail } = require('./zoho-api-mailer');

const MYSQL_DEFAULTS_FILE = process.env.REPORT_MYSQL_DEFAULTS_FILE || '/root/.my.cnf.do';
const REPORT_TABLE = process.env.REPORT_DB_TABLE || 'database.transactions';
const REPORTS_DIR = process.env.REPORT_OUTPUT_DIR || '/var/reports';

// ---------- App DB pool (subscribers, message_templates, report_runs) ----------
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'db_user',
  password: process.env.DB_PASSWORD || 'db_password',
  database: process.env.DB_NAME || 'your_database',
  waitForConnections: true,
  connectionLimit: 3,
});


function isValidDate(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !Number.isNaN(Date.parse(dateStr));
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ---------- CSV generation (same pipeline as the existing shell process) ----------
function generateCsvForDate(dateStr) {
  return new Promise((resolve, reject) => {
    if (!isValidDate(dateStr)) {
      return reject(new Error(`Invalid date: ${dateStr}`));
    }

    fs.mkdirSync(REPORTS_DIR, { recursive: true });

    const startDate = `${dateStr} 00:00:00`;
    const endDate = `${dateStr} 23:59:59`;
    const outputFile = path.join(REPORTS_DIR, `transactions-${dateStr}.csv`);

    const sql = `
      SELECT id, user_id, cost, bal_before, bal_after, prod_name, recipient,
             created_at, app_response, server_response, reference, request_id
      FROM ${REPORT_TABLE}
      WHERE created_at BETWEEN '${startDate}'
                           AND '${endDate}';
    `;

    const cmd = `mysql --defaults-extra-file=${MYSQL_DEFAULTS_FILE} -B -e "${sql}" | sed 's/\t/","/g;s/^/"/;s/$/"/' > "${outputFile}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) {
        // Clean up any partial file left behind by the failed pipeline.
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
        return reject(new Error(`Report generation failed: ${stderr || err.message}`));
      }
      if (!fs.existsSync(outputFile)) {
        return reject(new Error('Report command completed but no output file was created.'));
      }
      resolve(outputFile);
    });
  });
}

// ---------- Subscribers / template ----------
async function getActiveSubscribers() {
  const [rows] = await pool.execute('SELECT id, email FROM subscribers WHERE active = 1');
  return rows;
}

async function getMessageTemplate() {
  const [rows] = await pool.execute(
    'SELECT subject, body FROM message_templates WHERE id = 1'
  );
  if (rows.length === 0) {
    throw new Error('No message template found — save one from the dashboard first.');
  }
  return rows[0];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Run logging ----------
async function logRun({ reportDate, status, sent, failed, errorMessage }) {
  await pool.execute(
    `INSERT INTO report_runs (report_date, status, recipients_sent, recipients_failed, error_message)
     VALUES (?, ?, ?, ?, ?)`,
    [reportDate, status, sent, failed, errorMessage || null]
  );
}

// ---------- Main entry point ----------
// Generates the CSV for reportDate, emails it to every active subscriber,
// logs the outcome to report_runs, and deletes the CSV once sending has
// completed. Safe to call repeatedly for the same date (e.g. retrying a
// date that previously failed).
async function sendReportForDate(reportDate) {
  if (!isValidDate(reportDate)) {
    throw new Error(`Invalid date: ${reportDate}`);
  }

  let csvPath;
  try {
    csvPath = await generateCsvForDate(reportDate);
  } catch (err) {
    await logRun({ reportDate, status: 'failed', sent: 0, failed: 0, errorMessage: err.message });
    throw err;
  }

  const [subscribers, template] = await Promise.all([
    getActiveSubscribers(),
    getMessageTemplate(),
  ]);

  if (subscribers.length === 0) {
    // Nothing to send to — leave the CSV in place since it was never sent.
    await logRun({
      reportDate,
      status: 'failed',
      sent: 0,
      failed: 0,
      errorMessage: 'No active subscribers to send to.',
    });
    return { reportDate, sent: 0, failed: 0, total: 0, csvDeleted: false };
  }

  // Compress the CSV before attaching — Zoho's API rejects attachments
  // over ~20MB, and this transaction export regularly exceeds that raw.
  const rawCsvContent = fs.readFileSync(csvPath);
  const csvContent = zlib.gzipSync(rawCsvContent);
  const filename = path.basename(csvPath) + '.gz';

  const reportHtml = `<p>The transaction report for ${reportDate} is attached as a CSV (${filename}).</p>`;
  const bodyHtml = template.body
    .replace(/\n/g, '<br>')
    .replace(/\{\{report\}\}/g, reportHtml);

  let sent = 0;
  let failed = 0;

  for (const subscriber of subscribers) {
    try {
      await sendMail({
        to: subscriber.email,
        subject: template.subject,
        html: bodyHtml,
        attachments: [{ filename, content: csvContent }],
      });
      sent += 1;
    } catch (err) {
      failed += 1;
      console.error(`Failed to send to ${subscriber.email}:`, err.message);
    }
    await delay(300); // stay well under Zoho's rate limits
  }

  // The send step ran to completion (even if some individual recipients
  // failed) — clean up the CSV per your process.
  fs.unlinkSync(csvPath);

  const status = failed === 0 ? 'success' : sent === 0 ? 'failed' : 'partial';
  await logRun({
    reportDate,
    status,
    sent,
    failed,
    errorMessage: failed > 0 ? `${failed} of ${subscribers.length} sends failed` : null,
  });

  return { reportDate, sent, failed, total: subscribers.length, csvDeleted: true };
}

async function getReportRuns(limit = 30) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 30;
  const [rows] = await pool.query(
    `SELECT id, report_date, status, recipients_sent, recipients_failed, error_message, run_at
     FROM report_runs ORDER BY run_at DESC LIMIT ${safeLimit}`
  );
  return rows;
}

module.exports = {
  pool,
  isValidDate,
  yesterday,
  sendReportForDate,
  getReportRuns,
};
