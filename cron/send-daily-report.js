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
// Runs daily at 7:00 AM server time — add this to your crontab (crontab -e):
//   0 7 * * * cd /path/to/project && /usr/bin/node cron/send-daily-report.js >> /var/log/daily-report.log 2>&1

const {
  sendReportForDate,
  sendReportForOneRecipient,
  getActiveRecipientsByEmail,
  yesterday,
  isValidDate,
  pool,
} = require('../lib/report-job');

const USAGE =
  'Usage: node cron/send-daily-report.js [YYYY-MM-DD] [--recipient <id> | --email <address>]';

function parseArgs(argv) {
  const args = { date: null, recipientId: null, email: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--recipient' || arg === '--email') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === '--recipient') {
        const id = Number(value);
        if (!Number.isInteger(id) || id <= 0) {
          throw new Error(`Invalid recipient id: ${value}`);
        }
        args.recipientId = id;
      } else {
        args.email = value.trim();
      }
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

  if (args.recipientId && args.email) {
    throw new Error('Use either --recipient or --email, not both');
  }

  return args;
}

async function run({ reportDate, recipientId, email }) {
  if (recipientId) {
    console.log(`[${new Date().toISOString()}] Starting report send for ${reportDate} to recipient id ${recipientId}...`);
    return sendReportForOneRecipient(reportDate, recipientId);
  }

  if (email) {
    const recipients = await getActiveRecipientsByEmail(email);
    if (recipients.length === 0) {
      throw new Error(`No active recipient found with email ${email}`);
    }
    console.log(
      `[${new Date().toISOString()}] Starting report send for ${reportDate} to ${email} ` +
        `(${recipients.length} user_id${recipients.length === 1 ? '' : 's'})...`
    );

    const totals = { sent: 0, failed: 0, total: 0 };
    for (const recipient of recipients) {
      const result = await sendReportForOneRecipient(reportDate, recipient.id);
      totals.sent += result.sent;
      totals.failed += result.failed;
      totals.total += result.total;
    }
    return totals;
  }

  console.log(`[${new Date().toISOString()}] Starting report send for ${reportDate}...`);
  return sendReportForDate(reportDate);
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
    const result = await run({ reportDate, recipientId: args.recipientId, email: args.email });
    const csvNote = result.csvDeleted !== undefined ? `, CSV deleted: ${result.csvDeleted}` : '';
    console.log(`Done. Sent: ${result.sent}, Failed: ${result.failed}, Total: ${result.total}${csvNote}`);
  } catch (err) {
    console.error('Report job failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
