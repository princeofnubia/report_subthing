-- Migration: add request_id to refund_log
-- Only needed if you ran migration-refund-log.sql BEFORE request_id was added
-- to it (a fresh install already has the column, and this would then fail
-- with "Duplicate column name"; that error is harmless).
--   mysql -u your_db_user -p your_database < migration-refund-log-request-id.sql

ALTER TABLE refund_log
  ADD COLUMN request_id VARCHAR(255) NULL AFTER transaction_id,
  ADD KEY idx_request_id (request_id);
