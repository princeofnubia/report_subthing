// lib/refunds.js
// Refunds one pending transaction through subthingy's auto-refund endpoint
// (POST {SUBTHINGY_API_URL}/api/bulkrefund with a single order ID) and logs
// every attempt in the local refund_log table.
//
// Safety checks, in order, before subthingy is called:
//   1. the same transaction isn't already being refunded by this server
//   2. refund_log has no successful refund for it already
//   3. it still exists and its app_response still contains "pending"
//      (subthingy's endpoint refunds any purchase that isn't refunded yet,
//      so this check is what stops a successful transaction being refunded)
// Retrying after an error or timeout is safe: subthingy skips transactions
// it has already refunded, and step 3 catches them first anyway.

const { pool } = require('./report-job');
const { networkOf } = require('./transaction-stats');
const { getTransactionById, isPending } = require('./pending-transactions');

const API_URL = (process.env.SUBTHINGY_API_URL || '').replace(/\/+$/, '');
const API_TOKEN = process.env.SUBTHINGY_API_TOKEN || '';
const API_TIMEOUT_MS = Number(process.env.SUBTHINGY_API_TIMEOUT_MS) || 30000;

const inFlight = new Set();

function isConfigured() {
  return Boolean(API_URL && API_TOKEN);
}

async function logAttempt(txn, outcome, reason, reference, username) {
  await pool.execute(
    `INSERT INTO refund_log
       (transaction_id, request_id, txn_date, network, prod_name, user_id, user_name, recipient, amount,
        previous_status, outcome, reason, reference, refunded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      txn.id,
      txn.requestId || null,
      (txn.createdAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
      txn.network,
      txn.prodName,
      txn.userId ? Number(txn.userId) : null,
      txn.userName || null,
      txn.recipient,
      txn.cost,
      txn.appResponse,
      outcome,
      reason ? String(reason).slice(0, 500) : null,
      reference || null,
      username || null,
    ]
  );
}

// Call subthingy for one ID. Returns { outcome, reason, reference }.
async function callRefundApi(id) {
  let res;
  try {
    res = await fetch(`${API_URL}/api/bulkrefund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ order_IDs: [id] }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      outcome: 'error',
      reason: timedOut
        ? 'Refund API did not answer in time. It may still have gone through; load the list again before retrying.'
        : `Could not reach refund API: ${err.message}`,
    };
  }

  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    // non-JSON (e.g. an HTML error page or login redirect)
  }

  if (!res.ok || !body || body.successful !== true) {
    const msg = (body && body.message) || `HTTP ${res.status}`;
    const hint = res.status === 401 ? ' (check SUBTHINGY_API_TOKEN)' : res.status === 403 ? ' (token user must be an Admin)' : '';
    return { outcome: 'error', reason: `Refund API refused: ${msg}${hint}` };
  }

  const result = (body.results || []).find((r) => Number(r.id) === Number(id));
  if (!result) {
    return { outcome: 'error', reason: 'Refund API returned no result for this transaction' };
  }
  return {
    outcome: ['refunded', 'skipped', 'error'].includes(result.outcome) ? result.outcome : 'error',
    reason: result.reason || '',
    reference: result.reference || null,
  };
}

async function refundOne(id, username) {
  if (!isConfigured()) {
    return { id, outcome: 'error', reason: 'Refund API is not configured (set SUBTHINGY_API_URL and SUBTHINGY_API_TOKEN in .env)' };
  }
  if (inFlight.has(id)) {
    return { id, outcome: 'skipped', reason: 'A refund for this transaction is already in progress' };
  }
  inFlight.add(id);
  try {
    const [done] = await pool.execute(
      "SELECT reference FROM refund_log WHERE transaction_id = ? AND outcome = 'refunded' LIMIT 1",
      [id]
    );
    if (done.length) {
      return { id, outcome: 'skipped', reason: 'Already refunded from this page', reference: done[0].reference };
    }

    const txn = await getTransactionById(id);
    if (!txn) {
      return { id, outcome: 'skipped', reason: 'Transaction not found' };
    }
    if (!isPending(txn.appResponse)) {
      return { id, outcome: 'skipped', reason: `No longer pending (now "${txn.appResponse}")` };
    }

    const result = await callRefundApi(id);
    await logAttempt(txn, result.outcome, result.reason, result.reference, username);
    return { id, requestId: txn.requestId, amount: txn.cost, ...result };
  } finally {
    inFlight.delete(id);
  }
}

// Successful refunds for transactions made on a given date.
async function getRefundedForDate(dateStr, network) {
  const params = [dateStr];
  let networkClause = '';
  if (network) {
    networkClause = 'AND network = ?';
    params.push(network);
  }
  const [rows] = await pool.execute(
    `SELECT transaction_id, request_id, network, prod_name, user_id, user_name, recipient, amount,
            previous_status, reference, refunded_by, created_at
     FROM refund_log
     WHERE txn_date = ? AND outcome = 'refunded' ${networkClause}
     ORDER BY created_at DESC, id DESC`,
    params
  );
  return {
    rows,
    total: { count: rows.length, amount: rows.reduce((s, r) => s + Number(r.amount), 0) },
  };
}

module.exports = { refundOne, getRefundedForDate, isConfigured, networkOf };
