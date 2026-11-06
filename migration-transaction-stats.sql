-- Migration: local cache of daily transaction stats (Transactions page)
-- Run this once against your app database:
--   mysql -u your_db_user -p your_database < migration-transaction-stats.sql
--
-- One row per (date, product). Filled when a date is queried on the
-- Transactions page; re-querying a date replaces that date's rows.
-- Range reports are built from this table only, so a date must have been
-- queried at least once before it shows up in a downloaded report.

CREATE TABLE IF NOT EXISTS transaction_daily_stats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  stat_date DATE NOT NULL,
  network VARCHAR(20) NOT NULL,          -- MTN, GLO, AIRTEL, 9MOBILE, OTHER
  prod_name VARCHAR(255) NOT NULL,
  total_count INT NOT NULL DEFAULT 0,      -- all transactions for this product/day
  successful_count INT NOT NULL DEFAULT 0, -- app_response contains 'successful'
  successful_amount DECIMAL(16,2) NOT NULL DEFAULT 0, -- SUM(cost) of successful ones
  successful_gb DECIMAL(14,3) NOT NULL DEFAULT 0,     -- parsed from prod_name x successful_count
  fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_date_product (stat_date, prod_name),
  KEY idx_date_network (stat_date, network)
);
