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
// Runs daily at 7:00 AM server time — add this to your crontab (crontab -e):
//   0 7 * * * cd /path/to/project && /usr/bin/node cron/send-daily-report.js >> /var/log/daily-report.log 2>&1

const { sendReportForDate, yesterday, isValidDate, pool } = require('../lib/report-job');

async function main() {
  const dateArg = process.argv[2];
  const reportDate = dateArg || yesterday();

  if (dateArg && !isValidDate(dateArg)) {
    console.error(`Invalid date argument: ${dateArg}. Expected format: YYYY-MM-DD`);
    process.exit(1);
  }

  console.log(`[${new Date().toISOString()}] Starting report send for ${reportDate}...`);

  try {
    const result = await sendReportForDate(reportDate);
    console.log(
      `Done. Sent: ${result.sent}, Failed: ${result.failed}, Total active: ${result.total}, CSV deleted: ${result.csvDeleted}`
    );
  } catch (err) {
    console.error('Daily report job failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
