-- Run this once against your database to create the recipients table
-- (matches the table already used by send-daily-report.js)

CREATE TABLE IF NOT EXISTS subscribers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Holds the single editable subject/body template used when the cron job
-- sends the daily report. Always exactly one row (id = 1).
-- The body can include a {{report}} placeholder, which send-daily-report.js
-- replaces with the generated report content before sending.
CREATE TABLE IF NOT EXISTS message_templates (
  id INT PRIMARY KEY DEFAULT 1,
  subject VARCHAR(255) NOT NULL DEFAULT 'Your Daily Report',
  body TEXT NOT NULL DEFAULT 'Hi,\n\nHere is today''s report:\n\n{{report}}\n\nThanks.',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO message_templates (id, subject, body)
VALUES (1, 'Your Daily Report', 'Hi,\n\nHere is today''s report:\n\n{{report}}\n\nThanks.')
ON DUPLICATE KEY UPDATE id = id;

-- Logs every generate+send attempt (scheduled or manually re-run from the
-- dashboard) so failures for a given date are visible and that date can be
-- re-sent as many times as needed.
CREATE TABLE IF NOT EXISTS report_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  report_date DATE NOT NULL,
  status ENUM('success', 'partial', 'failed') NOT NULL,
  recipients_sent INT NOT NULL DEFAULT 0,
  recipients_failed INT NOT NULL DEFAULT 0,
  error_message TEXT,
  run_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_report_date (report_date)
);
