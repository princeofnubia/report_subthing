// cron/send-daily-report.js
//
// Scheduled entry point — thin wrapper around lib/report-job.js so the
// cron run and the dashboard's manual "resend for a date" button share
// exactly the same generate -> send -> log -> cleanup logic.
//
// Setup:
//   npm install mysql2 nodemailer dotenv
//
// Required environment variables (see ../.env.example):
//   DB_HOST, DB_USER, DB_PASSWORD, DB_NAME
//   ZOHO_EMAIL, ZOHO_APP_PASSWORD, ZOHO_SMTP_HOST, ZOHO_SMTP_PORT
//   REPORT_MYSQL_DEFAULTS_FILE, REPORT_DB_TABLE, REPORT_OUTPUT_DIR
//
// By default this sends the report for YESTERDAY (the daily 7:00 AM run
// covers the previous full day's transactions). Pass a date to run it for
// a specific day instead, e.g. for a manual backfill:
//   node cron/send-daily-report.js 2026-08-14
//
// To send to a single recipient only (e.g. to reissue an expired download
// link without re-emailing everyone), pass --recipient <subscriber id> or
// --email <address>. An email subscribed under several user_ids gets one
// report per user_id. The date is optional and defaults to yesterday:
//   node cron/send-daily-report.js 2026-08-14 --recipient 42
//   node cron/send-daily-report.js --email someone@example.com
//
// To send a report to ANY address (it doesn't have to be a subscriber),
// add --to <address> and say whose data to send with --user-id,
// --recipient or --email. Observers are not copied on these sends:
//   node cron/send-daily-report.js 2026-08-14 --user-id 7 --to anyone@example.com
//   node cron/send-daily-report.js --recipient 42 --to anyone@example.com
//
// Runs daily at 7:00 AM server time — add this to your crontab (crontab -e):
//   0 7 * * * cd /path/to/project && /usr/bin/node cron/send-daily-report.js >> /var/log/daily-report.log 2>&1

const {
  sendReportForDate,
  sendReportForOneRecipient,
  sendReportToAddress,
  getActiveRecipientsByEmail,
  getActiveRecipientById,
  yesterday,
  isValidDate,
  pool,
} = require('../lib/report-job');

const USAGE = [
  'Usage: node cron/send-daily-report.js [YYYY-MM-DD] [--recipient <id> | --email <address>]',
  '       node cron/send-daily-report.js [YYYY-MM-DD] (--user-id <n> | --recipient <id> | --email <address>) --to <address>',
].join('\n');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPTIONS = ['--recipient', '--email', '--user-id', '--to'];

function parsePositiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return n;
}

function parseEmail(value, flag) {
  const email = value.trim();
  if (!EMAIL_PATTERN.test(email)) {
    throw new Error(`Invalid email address for ${flag}: ${value}`);
  }
  return email;
}

function parseArgs(argv) {
  const args = { date: null, recipientId: null, email: null, userId: null, to: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (OPTIONS.includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === '--recipient') args.recipientId = parsePositiveInt(value, 'recipient id');
      else if (arg === '--user-id') args.userId = parsePositiveInt(value, 'user id');
      else if (arg === '--email') args.email = parseEmail(value, arg);
      else args.to = parseEmail(value, arg);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (args.date) {
      throw new Error(`Unexpected argument: ${arg}`);
    } else {
      if (!isValidDate(arg)) {
        throw new Error(`Invalid date argument: ${arg}. Expected format: YYYY-MM-DD`);
      }
      args.date = arg;
    }
  }

  const selectors = [args.recipientId, args.email, args.userId].filter((v) => v !== null);
  if (selectors.length > 1) {
    throw new Error('Use only one of --recipient, --email or --user-id');
  }
  if (args.userId !== null && !args.to) {
    throw new Error('--user-id needs --to <address> (there is no subscriber to send it to)');
  }
  if (args.to && selectors.length === 0) {
    throw new Error('--to needs --user-id, --recipient or --email to say whose report to send');
  }

  return args;
}

function addTotals(totals, result) {
  totals.sent += result.sent;
  totals.failed += result.failed;
  totals.total += result.total;
  totals.errors.push(...(result.errors || []));
  return totals;
}

// Which user_id(s) the --to send should cover.
async function resolveUserIds({ userId, recipientId, email }) {
  if (userId) return [userId];

  if (recipientId) {
    const recipient = await getActiveRecipientById(recipientId);
    if (!recipient) throw new Error('Recipient not found or is not active');
    return [recipient.user_id];
  }

  const recipients = await getActiveRecipientsByEmail(email);
  if (recipients.length === 0) {
    throw new Error(`No active recipient found with email ${email}`);
  }
  return recipients.map((r) => r.user_id);
}

async function run({ reportDate, recipientId, email, userId, to }) {
  const now = new Date().toISOString();

  if (to) {
    const userIds = await resolveUserIds({ userId, recipientId, email });
    console.log(
      `[${now}] Starting report send for ${reportDate} to ${to} (user_id ${userIds.join(', ')})...`
    );
    const totals = { sent: 0, failed: 0, total: 0, errors: [] };
    for (const id of userIds) {
      addTotals(totals, await sendReportToAddress(reportDate, id, to));
    }
    return totals;
  }

  if (recipientId) {
    console.log(`[${now}] Starting report send for ${reportDate} to recipient id ${recipientId}...`);
    return sendReportForOneRecipient(reportDate, recipientId);
  }

  if (email) {
    const recipients = await getActiveRecipientsByEmail(email);
    if (recipients.length === 0) {
      throw new Error(`No active recipient found with email ${email}`);
    }
    console.log(
      `[${now}] Starting report send for ${reportDate} to ${email} ` +
        `(${recipients.length} user_id${recipients.length === 1 ? '' : 's'})...`
    );

    const totals = { sent: 0, failed: 0, total: 0, errors: [] };
    for (const recipient of recipients) {
      addTotals(totals, await sendReportForOneRecipient(reportDate, recipient.id));
    }
    return totals;
  }

  console.log(`[${now}] Starting report send for ${reportDate}...`);
  return sendReportForDate(reportDate);
}

// mysql2 connection failures (e.g. ECONNREFUSED) arrive as an
// AggregateError with an empty message — the detail is in .code and
// .errors, so surface those instead of printing a blank line.
function describeError(err) {
  const parts = [];
  if (err.message) parts.push(err.message);
  if (err.code) parts.push(`(${err.code})`);
  for (const inner of err.errors || []) {
    parts.push(`\n  - ${inner.message || inner.code || inner}`);
  }
  return parts.length > 0 ? parts.join(' ') : String(err.stack || err);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    await pool.end();
    process.exit(1);
  }

  const reportDate = args.date || yesterday();

  try {
    const result = await run({ reportDate, ...args });
    const csvNote = result.csvDeleted !== undefined ? `, CSV deleted: ${result.csvDeleted}` : '';
    console.log(`Done. Sent: ${result.sent}, Failed: ${result.failed}, Total: ${result.total}${csvNote}`);
    for (const error of result.errors || []) {
      console.error(`  Error: ${error}`);
    }
    if (result.failed > 0) process.exitCode = 1;
  } catch (err) {
    console.error('Report job failed:', describeError(err));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
