-- Migration: refund log (Pending page)
-- Run this once against your app database:
--   mysql -u your_db_user -p your_database < migration-refund-log.sql
--
-- One row per refund attempt made from the Pending page, whatever the
-- outcome. The Refunded tab lists the rows with outcome = 'refunded'.

CREATE TABLE IF NOT EXISTS refund_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  transaction_id INT NOT NULL,
  request_id VARCHAR(255) NULL,           -- request_id of the original transaction
  txn_date DATE NOT NULL,                 -- date of the original transaction
  network VARCHAR(20) NOT NULL,
  prod_name VARCHAR(255) NULL,
  user_id INT NULL,
  user_name VARCHAR(255) NULL,
  recipient VARCHAR(50) NULL,
  amount DECIMAL(16,2) NOT NULL DEFAULT 0,
  previous_status VARCHAR(255) NULL,      -- app_response before the refund
  outcome ENUM('refunded', 'skipped', 'error') NOT NULL,
  reason VARCHAR(500) NULL,
  reference VARCHAR(100) NULL,            -- refund reference returned by subthingy
  refunded_by VARCHAR(100) NULL,          -- dashboard username
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_txn (transaction_id),
  KEY idx_request_id (request_id),
  KEY idx_date_outcome (txn_date, outcome)
);
