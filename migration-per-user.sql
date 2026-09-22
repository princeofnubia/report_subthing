-- Migration: per-user_id reports + observer emails
-- Run this once against your existing database:
--   mysql -u your_db_user -p your_database < migration-per-user.sql

-- 1. Add user_id to subscribers.
--    A single email can now appear multiple times, each tied to a
--    different user_id (e.g. one manager overseeing several user_ids).
ALTER TABLE subscribers
  ADD COLUMN user_id INT NULL AFTER email;

-- If your existing subscribers table has a UNIQUE constraint on email
-- alone, drop it (name may differ — check first with: SHOW INDEX FROM subscribers;)
-- ALTER TABLE subscribers DROP INDEX email;

-- Prevent exact duplicate (email, user_id) pairs while still allowing
-- the same email to repeat with a different user_id.
ALTER TABLE subscribers
  ADD UNIQUE KEY unique_email_user (email, user_id);

-- IMPORTANT: existing rows will have user_id = NULL after this migration.
-- Since reports are now generated per user_id, any subscriber row without
-- a user_id will be skipped by the new report logic. Go into the
-- dashboard and set a user_id on each existing recipient (or delete and
-- re-add them via the updated form) before relying on the next cron run.

-- 2. New table: observer emails (BCC-style copies of every per-user_id email)
CREATE TABLE IF NOT EXISTS observer_emails (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Track which user_id / recipient each report_runs row belongs to,
--    since one cron run now produces multiple sends (one per subscriber).
ALTER TABLE report_runs
  ADD COLUMN user_id INT NULL AFTER report_date,
  ADD COLUMN recipient_email VARCHAR(255) NULL AFTER user_id;
