# Report Recipients & Daily Report — Setup

A login-protected web app to manage the email addresses that receive your
daily transaction report, edit the message that goes out with it, and
trigger (or re-trigger) a send for any specific date. A cron job sends it
automatically every morning.

## How it fits together

- **`subscribers` table** — the list of who gets the report. Managed from
  the dashboard (add / edit / pause / delete).
- **`message_templates` table** — one editable subject + body, saved from
  the dashboard's "Email Message" card. Use `{{report}}` anywhere in the
  body; it's replaced with a line about the attached CSV before sending.
- **`report_runs` table** — a log of every generate-and-send attempt
  (scheduled or manual), so you can see what succeeded, partially failed,
  or failed outright, and re-run any date.
- **`lib/report-job.js`** — the shared core: generates the CSV for a given
  date (via the same `mysql --defaults-extra-file=... | sed ...` pipeline
  you're already using), emails it to every active subscriber, logs the
  run, and deletes the CSV once sending has completed. Both the cron job
  and the dashboard's "Send report" button call this exact same code.
- **`cron/send-daily-report.js`** — thin scheduled entry point around
  `lib/report-job.js`. Defaults to **yesterday's** date; also runnable by
  hand for a specific date (see below).
- **`server.js`** — the web app: login, recipients CRUD, message template,
  and the manual report-send/history API.
- **`send-zoho-email.js`** — a standalone script for testing your Zoho SMTP
  credentials in isolation, separate from the real send pipeline.

## 1. Install dependencies

```bash
cd recipient-admin
npm install
```

## 2. Create the database tables

```bash
mysql -u your_db_user -p your_database < schema.sql
```

This creates `subscribers`, `message_templates`, and `report_runs` in your
app's database (the one the dashboard reads/writes — separate from the
transactions database the report query reads from).

## 3. Configure environment variables

```bash
cp .env.example .env
chmod 600 .env
```

Generate a password hash for your admin login:
```bash
npm run hash-password -- "your-chosen-password"
```
Copy the printed `ADMIN_PASSWORD_HASH=...` line into `.env`.

Then fill in the rest of `.env`:

**App database & login**
```
DB_HOST=localhost
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=your_database
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=<paste generated hash here>
SESSION_SECRET=<any long random string>
PORT=3000
```

**Zoho SMTP** (used to send the report)
```
ZOHO_EMAIL=you@yourdomain.com
ZOHO_APP_PASSWORD=<app-specific password, not your login password>
ZOHO_SMTP_HOST=smtp.zoho.com
ZOHO_SMTP_PORT=465
ZOHO_FROM_NAME=Reports
```
Generate the app password in Zoho Mail under Settings > Security > App
Passwords — regular SMTP auth with your normal password won't work if 2FA
is on.

**CSV report generation**
```
REPORT_MYSQL_DEFAULTS_FILE=/root/.my.cnf.do
REPORT_DB_TABLE=database.transactions
REPORT_OUTPUT_DIR=/var/reports
```
`REPORT_MYSQL_DEFAULTS_FILE` is the `.my.cnf`-style credentials file the
`mysql` CLI uses to reach the transactions database. Whatever user runs
the app / cron job needs read access to this file — if it's root-owned at
`/root/.my.cnf.do`, either run the process as root or adjust its
permissions.

## 4. Test your Zoho credentials before relying on the cron job

```bash
npm run test-zoho
```
Edit the recipient and (optional) attachment path in the `USAGE EXAMPLE`
block at the bottom of `send-zoho-email.js` first. This confirms SMTP auth
works in isolation, independent of the database and CSV pipeline.

## 5. Run the web app

```bash
npm start
```

Visit `http://your-droplet-ip:3000` (or `http://localhost:3000` if testing
locally). You'll be redirected to `/login.html` — sign in with the
username and password you set above. From the dashboard you can:

- Add, pause, edit, or remove recipients
- Edit the subject/body of the daily email
- Manually send (or re-send) the report for any date, and see the run
  history below it

## 6. Test the report send manually

```bash
npm run send-report -- 2026-08-14
```
Runs the exact same generate-CSV → email → log → cleanup flow as the cron
job, for the date you pass. Useful for confirming the whole pipeline works
end-to-end before scheduling it. Run with no date to send for yesterday
(what the scheduled job does).

## 7. Set up the daily cron job

```bash
crontab -e
```
Add (runs daily at 7:00 AM server time):
```
0 7 * * * cd /path/to/recipient-admin && /usr/bin/node cron/send-daily-report.js >> /var/log/daily-report.log 2>&1
```

## 8. Deploying the web app alongside the cron job

The dashboard runs as a persistent web server (unlike the cron job, which
is a one-off script), so keep it running with a process manager like
`pm2`:

```bash
npm install -g pm2
pm2 start server.js --name recipient-admin
pm2 save
pm2 startup   # follow the printed instructions to auto-start on reboot
```

## 9. Exposing it securely

Right now the app runs in plain HTTP on port 3000. Two recommended options
before you rely on this in production:

**Put it behind Nginx with HTTPS (recommended):**
- Install Nginx and Certbot on the droplet
- Reverse-proxy `yourdomain.com` → `localhost:3000`
- Certbot issues a free TLS certificate automatically
- Once HTTPS is active, uncomment `secure: true` on the session cookie in `server.js`

**Or, at minimum, restrict access by firewall:**
```bash
sudo ufw allow from YOUR_IP_ADDRESS to any port 3000
```
This limits who can even reach the login page.

## Troubleshooting a failed date

If the run history shows a date as `failed` or `partial`:
1. Check the error shown for that row (hover it in the dashboard, or query
   `report_runs.error_message` directly).
2. Common causes: the CSV pipeline couldn't reach the transactions DB
   (check `REPORT_MYSQL_DEFAULTS_FILE` permissions), or individual sends
   failed (check Zoho's rate limits / your app password hasn't expired).
3. Fix the underlying issue, then either click "Send report" for that date
   again in the dashboard, or run `npm run send-report -- YYYY-MM-DD`. Both
   are safe to re-run — a date can be sent as many times as needed.
