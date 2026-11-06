// lib/pending-transactions.js
// Backs the Pending page: lists one day's transactions whose app_response
// contains "pending" (any case), read live from the transactions DB through
// the mysql CLI. Nothing is stored locally; refunds will build on this list.

const mysql = require('mysql2/promise');
const { isValidDate } = require('./report-job');
const { NETWORKS, REPORT_TABLE, networkOf, runTransactionsQuery } = require('./transaction-stats');

// Same derivation as lib/report-job.js: users table sits next to transactions.
const USERS_TABLE =
  process.env.REPORT_USERS_TABLE || REPORT_TABLE.replace(/\.[^.]+$/, '.users');

// Safety cap so a bad day can't return an unbounded list to the browser.
const MAX_ROWS = 5000;

const nullable = (v) => (v === undefined || v === 'NULL' ? null : v);

const SELECT_COLUMNS = `
    SELECT t.id, t.user_id, COALESCE(u.name, ''), COALESCE(u.email, ''),
           t.prod_name, t.recipient, t.cost, t.created_at, t.app_response,
           t.reference, t.request_id
    FROM ${REPORT_TABLE} t
    LEFT JOIN ${USERS_TABLE} u ON t.user_id = u.id`;

function isPending(appResponse) {
  return (appResponse || '').toLowerCase().includes('pending');
}

// Look up one transaction live (used to re-check it's still pending right
// before refunding). Returns null if it doesn't exist.
async function getTransactionById(id) {
  const raw = await runTransactionsQuery(`${SELECT_COLUMNS} WHERE t.id = ${mysql.escape(Number(id))} LIMIT 1;`);
  return raw.length ? mapRow(raw[0]) : null;
}

function mapRow(c) {
  return {
    id: Number(c[0]),
    userId: nullable(c[1]),
    userName: c[2] || '',
    userEmail: c[3] || '',
    prodName: nullable(c[4]) || '(unknown product)',
    network: networkOf(nullable(c[4])),
    recipient: nullable(c[5]),
    cost: Number(c[6]) || 0,
    createdAt: nullable(c[7]),
    appResponse: nullable(c[8]),
    reference: nullable(c[9]),
    requestId: nullable(c[10]),
  };
}

async function getPendingForDate(dateStr, network) {
  if (!isValidDate(dateStr)) {
    throw new Error(`Invalid date: ${dateStr}`);
  }

  // Pending lists are small, so fetch the whole day and split by network in
  // JS with the same product-name rule the Transactions page uses. That keeps
  // the per-network counts and the filtered list consistent.
  const sql = `${SELECT_COLUMNS}
    WHERE t.created_at BETWEEN ${mysql.escape(`${dateStr} 00:00:00`)} AND ${mysql.escape(`${dateStr} 23:59:59`)}
      AND LOWER(t.app_response) LIKE '%pending%'
    ORDER BY t.id
    LIMIT ${MAX_ROWS + 1};
  `;

  const raw = await runTransactionsQuery(sql);
  const truncated = raw.length > MAX_ROWS;

  const all = raw.slice(0, MAX_ROWS).map(mapRow);

  // Count + amount per network for the whole day (ignores the filter).
  const byNetwork = NETWORKS.map((n) => {
    const rows = all.filter((r) => r.network === n);
    return { network: n, count: rows.length, amount: rows.reduce((s, r) => s + r.cost, 0) };
  });

  const rows = network ? all.filter((r) => r.network === network) : all;

  return {
    date: dateStr,
    network: network || 'ALL',
    rows,
    total: { count: rows.length, amount: rows.reduce((s, r) => s + r.cost, 0) },
    byNetwork,
    truncated,
    maxRows: MAX_ROWS,
  };
}

module.exports = { getPendingForDate, getTransactionById, isPending };
