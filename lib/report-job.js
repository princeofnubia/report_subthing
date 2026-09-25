// lib/report-job.js
//
// Core report generation + send logic, shared by:
//   - cron/send-daily-report.js (scheduled daily run)
//   - server.js's POST /api/reports/send (manual re-run for a specific date)
//
// Each active recipient gets their own report, filtered to their own
// user_id, generated as an Excel (.xlsx) attachment. Every active observer
// email is CC'd on that same message.
//
// Requires: npm install exceljs
//
// Every individual send is logged to report_runs (per report_date +
// user_id + recipient_email) so failures are visible per-recipient and
// can be re-sent individually.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const ExcelJS = require('exceljs');
const { sendMail } = require('./zoho-api-mailer');

const MYSQL_DEFAULTS_FILE = process.env.REPORT_MYSQL_DEFAULTS_FILE || '/root/.my.cnf.do';
const REPORT_TABLE = process.env.REPORT_DB_TABLE || 'database.transactions';
// Users table lives in the same database as transactions — derive it by
// swapping the table name portion, unless explicitly overridden.
const REPORT_USERS_TABLE =
  process.env.REPORT_USERS_TABLE || REPORT_TABLE.replace(/\.[^.]+$/, '.users');
// Where generated reports are stored for download links. Must match the
// directory server.js's /reports/download route reads from.
const REPORT_DOWNLOADS_DIR = process.env.REPORT_DOWNLOADS_DIR || '/var/report-downloads';
// e.g. https://reports.yourdomain.com — required for building download links.
const PUBLIC_BASE_URL = process.env.REPORT_PUBLIC_BASE_URL;
const DOWNLOAD_RETENTION_DAYS = Number(process.env.REPORT_DOWNLOAD_RETENTION_DAYS) || 7;
// Payment instructions printed at the bottom of the stats table in every
// generated report's Excel attachment.
const PAYMENT_ACCOUNT_NAME = process.env.REPORT_PAYMENT_ACCOUNT_NAME || '';
const PAYMENT_BANK_NAME = process.env.REPORT_PAYMENT_BANK_NAME || '';
const PAYMENT_ACCOUNT_NUMBER = process.env.REPORT_PAYMENT_ACCOUNT_NUMBER || '';
const PAYMENT_NARRATION = process.env.REPORT_PAYMENT_NARRATION || 'Payment for Data vending';

// ---------- App DB pool (subscribers, observer_emails, message_templates, report_runs) ----------
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Column order (matches the SELECT below, and the requested
//            Excel layout: id, Name, Email, cost, ...) ----------
const COLUMNS = [
  'id', 'Name', 'Email', 'cost', 'bal_before', 'bal_after', 'prod_name',
  'recipient', 'created_at', 'app_response', 'server_response', 'reference', 'request_id',
];
const COL = {
  ID: 0,
  NAME: 1,
  EMAIL: 2,
  COST: 3,
  BAL_BEFORE: 4,
  BAL_AFTER: 5,
  PROD_NAME: 6,
  RECIPIENT: 7,
  CREATED_AT: 8,
  APP_RESPONSE: 9,
  SERVER_RESPONSE: 10,
  REFERENCE: 11,
  REQUEST_ID: 12,
};

// ---------- Fetch raw transaction rows for one user_id/date, via the
//            separate transactions DB (accessed through the mysql CLI and
//            its own credentials file, since it's a different DB/server
//            than the app's own tables). ----------
// Returns an array of arrays (one array per row, columns in COLUMNS order).
// Uses spawn + readline to STREAM mysql's output line-by-line instead of
// buffering it all through exec(), which has a fixed maxBuffer ceiling
// that large result sets (600K+ rows) blow straight through regardless of
// how high that ceiling is set. Streaming has no such limit — only the
// eventual in-memory rows array is bounded by available RAM.
function fetchTransactionRows(dateStr, userId) {
  return new Promise((resolve, reject) => {
    if (!isValidDate(dateStr)) {
      return reject(new Error(`Invalid date: ${dateStr}`));
    }

    const startDate = `${dateStr} 00:00:00`;
    const endDate = `${dateStr} 23:59:59`;

    const sql = `
      SELECT t.id, COALESCE(u.name, '') AS name, COALESCE(u.email, '') AS email, t.cost,
             t.bal_before, t.bal_after, t.prod_name, t.recipient, t.created_at,
             t.app_response, t.server_response, t.reference, t.request_id
      FROM ${REPORT_TABLE} t
      LEFT JOIN ${REPORT_USERS_TABLE} u ON t.user_id = u.id
      WHERE t.user_id = ${mysql.escape(userId)}
        AND t.created_at BETWEEN '${startDate}'
                             AND '${endDate}';
    `;

    // -N: no column header row. -B: tab-separated batch output.
    const child = spawn('mysql', [`--defaults-extra-file=${MYSQL_DEFAULTS_FILE}`, '-B', '-N', '-e', sql]);

    const rows = [];
    let stderrOutput = '';

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (line.length > 0) {
        rows.push(line.split('\t'));
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrOutput += chunk.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Report generation failed: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Report generation failed: ${stderrOutput || `mysql exited with code ${code}`}`));
      }
      resolve(rows);
    });
  });
}

// ---------- Build the ITEMS / VALUES / Remark stats table rows (written
//            alongside the transaction rows, columns P:R) ----------
function buildStatsTableRows(stats) {
  // No wallet-funding data source exists in this schema — always 0.
  const additionalFunding = 0;
  const netDeduction = stats.openingBalance + additionalFunding - stats.closingBalance;
  const variation = netDeduction - stats.amountDue;

  const rows = [
    { items: 'Opening Balance', values: stats.openingBalance },
    { items: 'Additional Wallet Funding', values: additionalFunding },
    { items: 'Closing Balance', values: stats.closingBalance },
    { items: 'Net Deduction from Wallet', values: netDeduction },
    {
      items: 'Sum of Transaction Amounts',
      values: stats.amountDue,
      remark: 'Total charges per transaction.',
    },
    { items: 'Total Successful Transaction Count', values: stats.successfulCount },
    { items: 'Total Successful Transaction (GB)', values: Number(stats.totalGb.toFixed(2)) },
  ];

  for (const { name, count } of stats.productCounts) {
    rows.push({ items: name, values: count });
  }

  rows.push({ items: '', values: '' });
  rows.push({
    items: 'Variation',
    values: variation,
    remark: 'Variation is the difference between Net Deduction and Transaction Amount',
  });
  rows.push({ items: '', values: '' });
  rows.push({ items: 'Payment Instructions:', values: '', paymentSection: true });
  if (PAYMENT_ACCOUNT_NAME) rows.push({ items: `Account Name: ${PAYMENT_ACCOUNT_NAME}`, values: '', paymentSection: true });
  if (PAYMENT_BANK_NAME) rows.push({ items: `Bank: ${PAYMENT_BANK_NAME}`, values: '', paymentSection: true });
  if (PAYMENT_ACCOUNT_NUMBER) rows.push({ items: `Account Number: ${PAYMENT_ACCOUNT_NUMBER}`, values: '', paymentSection: true });
  rows.push({ items: `Narration: ${PAYMENT_NARRATION}`, values: '', paymentSection: true });

  return rows;
}

// ---------- Build an Excel file at the given path, streaming rows as they're added ----------
// Uses ExcelJS's streaming WorkbookWriter instead of the regular in-memory
// Workbook: committed rows are flushed to disk immediately and released
// from memory, rather than being retained as JS objects for the entire
// workbook until a final writeBuffer() call. For very large reports
// (hundreds of thousands of rows) this is the difference between using a
// few hundred MB of RAM and running the process out of heap entirely.
//
// Writes to a .tmp path first and only renames to the final path once the
// write has fully completed. This guarantees the download route can never
// serve a partial/corrupted file — if the process is killed mid-write
// (e.g. a pm2 restart), the .tmp file is left behind but the real path
// never exists, so the link simply 404s instead of downloading garbage.
//
// Alongside the transaction columns, writes a separate ITEMS / VALUES /
// Remark stats table (opening/closing balance, totals, per-product counts,
// variation, and payment instructions) in columns P:R, matching the
// reconciliation table finance already builds by hand.
async function buildExcelFile(rows, stats, filePath) {
  const tmpPath = `${filePath}.tmp`;

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: tmpPath,
    useStyles: true,
    useSharedStrings: true,
  });

  const sheet = workbook.addWorksheet('Transactions');
  sheet.columns = [
    ...COLUMNS.map((name) => ({
      header: name,
      key: name,
      width: name === 'server_response' ? 40 : name === 'created_at' ? 20 : 16,
    })),
    { header: '', key: 'stat_spacer1', width: 4 },
    { header: '', key: 'stat_spacer2', width: 4 },
    { header: 'ITEMS', key: 'stat_items', width: 36 },
    { header: 'VALUES', key: 'stat_values', width: 18 },
    { header: 'Remark', key: 'stat_remark', width: 40 },
  ];
  // Stats table occupies the 3 columns after COLUMNS + 2 spacer columns:
  // ITEMS, VALUES, Remark.
  const STAT_COL_START = COLUMNS.length + 3;
  const STAT_COL_END = COLUMNS.length + 5;

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  const statHeaderFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFED7D31' } };
  for (let col = STAT_COL_START; col <= STAT_COL_END; col++) {
    const cell = headerRow.getCell(col);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = statHeaderFill;
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const statsRows = buildStatsTableRows(stats);
  const totalRows = Math.max(rows.length, statsRows.length);

  for (let i = 0; i < totalRows; i++) {
    const rowObj = {};
    const dataRow = rows[i];
    if (dataRow) {
      COLUMNS.forEach((name, colIdx) => {
        rowObj[name] = dataRow[colIdx];
      });
    }
    const statRow = statsRows[i];
    if (statRow) {
      rowObj.stat_items = statRow.items;
      rowObj.stat_values = statRow.values;
      rowObj.stat_remark = statRow.remark || '';
    }

    const excelRow = sheet.addRow(rowObj);

    // Zebra-stripe the stats table only: light orange / white, alternating
    // by row (the main transaction columns are left unstyled).
    if (statRow) {
      const fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: i % 2 === 0 ? 'FFFBE4D5' : 'FFFFFFFF' },
      };
      for (let col = STAT_COL_START; col <= STAT_COL_END; col++) {
        excelRow.getCell(col).fill = fill;
      }
    }

    // Bold heading font for the Payment Instructions block.
    if (statRow && statRow.paymentSection) {
      const paymentFont = { bold: true, size: 16, color: { argb: 'FFE4322B' } };
      excelRow.getCell('stat_items').font = paymentFont;
      excelRow.getCell('stat_values').font = paymentFont;
    }

    excelRow.commit();
  }

  sheet.commit();
  await workbook.commit();

  // Only now, after a fully successful write, make the file visible at
  // its real (downloadable) path.
  fs.renameSync(tmpPath, filePath);
}

// ---------- Delete downloaded reports older than the retention window ----------
function cleanupOldDownloads() {
  const retentionMs = DOWNLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = fs.readdirSync(REPORT_DOWNLOADS_DIR);
  } catch (err) {
    return; // directory doesn't exist yet — nothing to clean up
  }
  const now = Date.now();
  for (const entry of entries) {
    const entryPath = path.join(REPORT_DOWNLOADS_DIR, entry);
    try {
      const stat = fs.statSync(entryPath);
      if (now - stat.mtimeMs > retentionMs) {
        fs.unlinkSync(entryPath);
      }
    } catch (err) {
      console.error(`Failed to check/clean up ${entryPath}:`, err.message);
    }
  }
}

// ---------- Recipients / observers / template ----------
async function getActiveRecipients() {
  const [rows] = await pool.execute(
    'SELECT id, email, user_id FROM subscribers WHERE active = 1 AND user_id IS NOT NULL'
  );
  return rows;
}

async function getActiveRecipientById(recipientId) {
  const [rows] = await pool.execute(
    'SELECT id, email, user_id FROM subscribers WHERE id = ? AND active = 1 AND user_id IS NOT NULL',
    [recipientId]
  );
  return rows[0] || null;
}

async function getActiveObserverEmails() {
  const [rows] = await pool.execute('SELECT email FROM observer_emails WHERE active = 1');
  return rows.map((r) => r.email);
}

async function getMessageTemplate() {
  const [rows] = await pool.execute('SELECT subject, body FROM message_templates WHERE id = 1');
  if (rows.length === 0) {
    throw new Error('No message template found — save one from the dashboard first.');
  }
  return rows[0];
}

// ---------- Number to words (Naira) ----------
const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = [
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety',
];

function threeDigitsToWords(num) {
  let str = '';
  if (num >= 100) {
    str += `${ONES[Math.floor(num / 100)]} Hundred`;
    num %= 100;
    if (num > 0) str += ' and ';
  }
  if (num >= 20) {
    str += TENS[Math.floor(num / 10)];
    if (num % 10 > 0) str += ` ${ONES[num % 10]}`;
  } else if (num > 0) {
    str += ONES[num];
  }
  return str;
}

function numberToWordsNaira(amount) {
  const whole = Math.round(Math.abs(amount));
  if (whole === 0) return 'Zero Naira Only';

  const groups = [
    { value: 1000000000, label: 'Billion' },
    { value: 1000000, label: 'Million' },
    { value: 1000, label: 'Thousand' },
  ];

  let remaining = whole;
  const parts = [];

  for (const group of groups) {
    if (remaining >= group.value) {
      const groupValue = Math.floor(remaining / group.value);
      parts.push(`${threeDigitsToWords(groupValue)} ${group.label}`);
      remaining %= group.value;
    }
  }

  if (remaining > 0) {
    parts.push(threeDigitsToWords(remaining));
  }

  return `${parts.join(', ')} Naira Only`;
}

function formatNaira(amount) {
  return `N${Math.abs(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatReportDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function extractGbFromProductName(prodName) {
  const name = prodName || '';
  const gbMatch = /(\d+(?:\.\d+)?)\s*GB/i.exec(name);
  if (gbMatch) return parseFloat(gbMatch[1]);
  const mbMatch = /(\d+(?:\.\d+)?)\s*MB/i.exec(name);
  if (mbMatch) return parseFloat(mbMatch[1]) / 1000;
  return 0;
}

// ---------- Compute summary stats directly from the raw row arrays ----------
function computeReportStats(rows) {
  if (rows.length === 0) {
    return {
      totalTransactions: 0,
      successfulCount: 0,
      totalGb: 0,
      openingBalance: 0,
      closingBalance: 0,
      amountDue: 0,
      productCounts: [],
    };
  }

  const firstRow = rows[0];
  const lastRow = rows[rows.length - 1];

  const openingBalance = parseFloat(firstRow[COL.BAL_AFTER]) || 0;
  const closingBalance = parseFloat(lastRow[COL.BAL_AFTER]) || 0;

  let successfulCount = 0;
  let totalGb = 0;
  let amountDue = 0;
  const productCountMap = new Map();

  for (const row of rows) {
    const appResponse = (row[COL.APP_RESPONSE] || '').toLowerCase();
    if (appResponse.includes('successful')) {
      successfulCount += 1;
      totalGb += extractGbFromProductName(row[COL.PROD_NAME]);
      amountDue += parseFloat(row[COL.COST]) || 0;

      const prodName = row[COL.PROD_NAME] || '(unknown product)';
      productCountMap.set(prodName, (productCountMap.get(prodName) || 0) + 1);
    }
  }

  const productCounts = Array.from(productCountMap, ([name, count]) => ({ name, count }));

  return {
    totalTransactions: rows.length,
    successfulCount,
    totalGb,
    openingBalance,
    closingBalance,
    amountDue,
    productCounts,
  };
}

function buildStatsSummaryHtml(stats, reportDate) {
  const amountWords = numberToWordsNaira(stats.amountDue);
  const amountFormatted = formatNaira(stats.amountDue);
  const gbDisplay = Number.isInteger(stats.totalGb) ? stats.totalGb : stats.totalGb.toFixed(2);
  const formattedDate = formatReportDate(reportDate);

  return `<p>Kindly note that the amount due for payment is ${amountWords} (${amountFormatted}) for ${stats.successfulCount} successful transactions counts for a total of ${gbDisplay}GB on ${formattedDate}.</p>`;
}

// ---------- Run logging ----------
async function logRun({ reportDate, userId, recipientEmail, status, sent, failed, errorMessage }) {
  await pool.execute(
    `INSERT INTO report_runs
       (report_date, user_id, recipient_email, status, recipients_sent, recipients_failed, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [reportDate, userId, recipientEmail, status, sent, failed, errorMessage || null]
  );
}

// ---------- Send one recipient's report (their own user_id, filtered) ----------
async function sendReportForRecipient({ reportDate, userId, recipientEmail, template, observerEmails }) {
  let rows;
  try {
    rows = await fetchTransactionRows(reportDate, userId);
  } catch (err) {
    await logRun({
      reportDate,
      userId,
      recipientEmail,
      status: 'failed',
      sent: 0,
      failed: 1,
      errorMessage: err.message,
    });
    return { success: false, error: err.message };
  }

  const stats = computeReportStats(rows);
  const statsSummaryHtml = buildStatsSummaryHtml(stats, reportDate);

  if (!PUBLIC_BASE_URL) {
    const err = new Error(
      'REPORT_PUBLIC_BASE_URL is not set in .env — cannot build a download link.'
    );
    await logRun({
      reportDate,
      userId,
      recipientEmail,
      status: 'failed',
      sent: 0,
      failed: 1,
      errorMessage: err.message,
    });
    return { success: false, error: err.message };
  }

  fs.mkdirSync(REPORT_DOWNLOADS_DIR, { recursive: true });
  const token = crypto.randomBytes(24).toString('hex');
  const filePath = path.join(REPORT_DOWNLOADS_DIR, `${token}.xlsx`);
  const displayFilename = `transactions-${reportDate}-user${userId}.xlsx`;

  await buildExcelFile(rows, stats, filePath);

  const downloadUrl = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/reports/download/${token}/${encodeURIComponent(displayFilename)}`;

  const reportHtml = `<p>Your transaction report for ${reportDate} is ready: <a href="${downloadUrl}">Download the Excel report</a>. This link expires in ${DOWNLOAD_RETENTION_DAYS} days.</p>${statsSummaryHtml}`;
  const bodyHtml = template.body.replace(/\n/g, '<br>').replace(/\{\{report\}\}/g, reportHtml);
  const subject = template.subject.replace(/\{\{date\}\}/g, formatReportDate(reportDate));

  let sentCount = 0;
  let failedCount = 0;
  let lastError = null;

  try {
    await sendMail({
      to: recipientEmail,
      cc: observerEmails,
      subject,
      html: bodyHtml,
    });
    sentCount += 1;
  } catch (err) {
    failedCount += 1;
    lastError = err.message;
    console.error(`Failed to send to ${recipientEmail} (user_id ${userId}):`, err.message);
  }

  await delay(300);

  const status = failedCount === 0 ? 'success' : 'failed';
  await logRun({
    reportDate,
    userId,
    recipientEmail,
    status,
    sent: sentCount,
    failed: failedCount,
    errorMessage: lastError,
  });

  return { success: failedCount === 0, error: lastError };
}

// ---------- Main entry point ----------
async function sendReportForDate(reportDate) {
  if (!isValidDate(reportDate)) {
    throw new Error(`Invalid date: ${reportDate}`);
  }

  cleanupOldDownloads();

  const [recipients, observerEmails, template] = await Promise.all([
    getActiveRecipients(),
    getActiveObserverEmails(),
    getMessageTemplate(),
  ]);

  if (recipients.length === 0) {
    return { reportDate, recipientsProcessed: 0, total: 0, sent: 0, failed: 0, csvDeleted: true };
  }

  let sent = 0;
  let failed = 0;

  for (const recipient of recipients) {
    const result = await sendReportForRecipient({
      reportDate,
      userId: recipient.user_id,
      recipientEmail: recipient.email,
      template,
      observerEmails,
    });
    if (result.success) {
      sent += 1;
    } else {
      failed += 1;
    }
  }

  return {
    reportDate,
    recipientsProcessed: recipients.length,
    total: recipients.length,
    sent,
    failed,
    csvDeleted: true,
  };
}

// ---------- Regenerate + resend for a single recipient only (e.g. a
//            recipient's download link expired and they just want their
//            own report re-sent, without re-emailing everyone else for
//            that date). Reuses the same regenerate path, so the new
//            file gets its own fresh retention window. ----------
async function sendReportForOneRecipient(reportDate, recipientId) {
  if (!isValidDate(reportDate)) {
    throw new Error(`Invalid date: ${reportDate}`);
  }

  cleanupOldDownloads();

  const [recipient, observerEmails, template] = await Promise.all([
    getActiveRecipientById(recipientId),
    getActiveObserverEmails(),
    getMessageTemplate(),
  ]);

  if (!recipient) {
    throw new Error('Recipient not found or is not active');
  }

  const result = await sendReportForRecipient({
    reportDate,
    userId: recipient.user_id,
    recipientEmail: recipient.email,
    template,
    observerEmails,
  });

  return {
    reportDate,
    recipientsProcessed: 1,
    total: 1,
    sent: result.success ? 1 : 0,
    failed: result.success ? 0 : 1,
  };
}

async function getReportRuns(limit = 10, offset = 0) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 10;
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;

  const [rows] = await pool.query(
    `SELECT id, report_date, user_id, recipient_email, status, recipients_sent, recipients_failed, error_message, run_at
     FROM report_runs ORDER BY run_at DESC LIMIT ? OFFSET ?`,
    [safeLimit, safeOffset]
  );

  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM report_runs');

  return { rows, total, limit: safeLimit, offset: safeOffset };
}

module.exports = {
  pool,
  isValidDate,
  yesterday,
  sendReportForDate,
  sendReportForOneRecipient,
  getReportRuns,
};
