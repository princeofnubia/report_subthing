// lib/transaction-stats.js
// Backs the Transactions page:
//   - fetchAndStoreDay(date): aggregates one day's transactions per product
//     from the transactions DB (via the same mysql CLI + defaults file the
//     report job uses) and saves them into the local transaction_daily_stats
//     table, replacing whatever was stored for that date before.
//   - getDayStats(date, network): reads one stored day back.
//   - getRangeStats(from, to, network): stored rows for a date range, plus
//     totals and a list of dates in the range that haven't been fetched yet.
//   - buildRangeWorkbook(...): Excel export of a range, with a grand total.

const { spawn } = require('child_process');
const ExcelJS = require('exceljs');
const { pool, isValidDate, extractGbFromProductName } = require('./report-job');

const MYSQL_DEFAULTS_FILE = process.env.REPORT_MYSQL_DEFAULTS_FILE || '/root/.my.cnf.do';
const REPORT_TABLE = process.env.REPORT_DB_TABLE || 'database.transactions';

const NETWORKS = ['MTN', 'GLO', 'AIRTEL', '9MOBILE', 'OTHER'];
const MAX_RANGE_DAYS = 366;

// Work out the network from the product name, e.g. "MTN 1GB SME" -> MTN.
function networkOf(prodName) {
  const name = (prodName || '').toUpperCase();
  if (/\bMTN\b/.test(name)) return 'MTN';
  if (/\bGLO\b/.test(name)) return 'GLO';
  if (/\bAIRTEL\b/.test(name)) return 'AIRTEL';
  if (/\b(9MOBILE|ETISALAT)\b/.test(name)) return '9MOBILE';
  return 'OTHER';
}

function normalizeNetwork(network) {
  if (!network) return null;
  const n = String(network).toUpperCase();
  return NETWORKS.includes(n) ? n : undefined;
}

// Every YYYY-MM-DD from `from` to `to`, inclusive.
function datesBetween(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function validateRange(from, to) {
  if (!isValidDate(from) || !isValidDate(to)) {
    return 'Valid from and to dates (YYYY-MM-DD) are required';
  }
  if (from > to) return 'The from date must be on or before the to date';
  if (datesBetween(from, to).length > MAX_RANGE_DAYS) {
    return `Date range can be at most ${MAX_RANGE_DAYS} days`;
  }
  return null;
}

// ---------- Query the transactions DB through the mysql CLI ----------
// Aggregation happens inside MySQL, so only one row per product comes back
// regardless of how many transactions the day had.
// The success rule (app_response contains "successful") is the same one the
// emailed report uses in computeReportStats, so the numbers match.
function queryDayAggregates(dateStr) {
  return new Promise((resolve, reject) => {
    if (!isValidDate(dateStr)) {
      return reject(new Error(`Invalid date: ${dateStr}`));
    }

    const sql = `
      SELECT t.prod_name,
             COUNT(*) AS total_count,
             SUM(CASE WHEN LOWER(t.app_response) LIKE '%successful%' THEN 1 ELSE 0 END) AS successful_count,
             COALESCE(SUM(CASE WHEN LOWER(t.app_response) LIKE '%successful%' THEN t.cost ELSE 0 END), 0) AS successful_amount
      FROM ${REPORT_TABLE} t
      WHERE t.created_at BETWEEN '${dateStr} 00:00:00' AND '${dateStr} 23:59:59'
      GROUP BY t.prod_name;
    `;

    const child = spawn('mysql', [`--defaults-extra-file=${MYSQL_DEFAULTS_FILE}`, '-B', '-N', '-e', sql]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => reject(new Error(`Could not run mysql CLI: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Transactions query failed: ${stderr.trim() || `mysql exited with code ${code}`}`));
      }
      const rows = stdout
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => {
          const [prodName, total, successful, amount] = line.split('\t');
          const prod = !prodName || prodName === 'NULL' ? '(unknown product)' : prodName;
          const successfulCount = Number(successful) || 0;
          return {
            prodName: prod,
            network: networkOf(prod),
            totalCount: Number(total) || 0,
            successfulCount,
            successfulAmount: Number(amount) || 0,
            successfulGb: extractGbFromProductName(prod) * successfulCount,
          };
        });
      resolve(rows);
    });
  });
}

// ---------- Fetch a day from the transactions DB and save it locally ----------
async function fetchAndStoreDay(dateStr) {
  const rows = await queryDayAggregates(dateStr);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM transaction_daily_stats WHERE stat_date = ?', [dateStr]);
    for (const r of rows) {
      await conn.execute(
        `INSERT INTO transaction_daily_stats
           (stat_date, network, prod_name, total_count, successful_count, successful_amount, successful_gb)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [dateStr, r.network, r.prodName, r.totalCount, r.successfulCount, r.successfulAmount, r.successfulGb]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return rows.length;
}

function sumRows(rows) {
  return rows.reduce(
    (acc, r) => {
      acc.totalCount += Number(r.total_count);
      acc.successfulCount += Number(r.successful_count);
      acc.successfulAmount += Number(r.successful_amount);
      acc.successfulGb += Number(r.successful_gb);
      return acc;
    },
    { totalCount: 0, successfulCount: 0, successfulAmount: 0, successfulGb: 0 }
  );
}

async function selectStored(from, to, network) {
  const params = [from, to];
  let networkClause = '';
  if (network) {
    networkClause = 'AND network = ?';
    params.push(network);
  }
  const [rows] = await pool.execute(
    `SELECT DATE_FORMAT(stat_date, '%Y-%m-%d') AS stat_date, network, prod_name,
            total_count, successful_count, successful_amount, successful_gb,
            fetched_at
     FROM transaction_daily_stats
     WHERE stat_date BETWEEN ? AND ? ${networkClause}
     ORDER BY stat_date, network, prod_name`,
    params
  );
  return rows;
}

// Dates in [from, to] that have been fetched at least once (any network).
// A fetched day with zero transactions stores no rows, so it can't be told
// apart from an unfetched day here; those show up as "not fetched yet".
async function fetchedDates(from, to) {
  const [rows] = await pool.execute(
    `SELECT DISTINCT DATE_FORMAT(stat_date, '%Y-%m-%d') AS d
     FROM transaction_daily_stats WHERE stat_date BETWEEN ? AND ?`,
    [from, to]
  );
  return new Set(rows.map((r) => r.d));
}

async function getDayStats(dateStr, network) {
  const rows = await selectStored(dateStr, dateStr, network);
  const fetched = await fetchedDates(dateStr, dateStr);
  return {
    date: dateStr,
    network: network || 'ALL',
    fetched: fetched.has(dateStr),
    fetchedAt: rows.length ? rows[0].fetched_at : null,
    rows,
    totals: sumRows(rows),
  };
}

async function getRangeStats(from, to, network) {
  const rows = await selectStored(from, to, network);
  const fetched = await fetchedDates(from, to);
  const missingDates = datesBetween(from, to).filter((d) => !fetched.has(d));

  // Per-day subtotals, for the on-page preview.
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.stat_date)) byDay.set(r.stat_date, []);
    byDay.get(r.stat_date).push(r);
  }
  const days = Array.from(byDay, ([date, dayRows]) => ({ date, ...sumRows(dayRows) }));

  return { from, to, network: network || 'ALL', rows, days, totals: sumRows(rows), missingDates };
}

// ---------- Excel export of a stored range ----------
async function buildRangeWorkbook(range) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Transactions');

  sheet.addRow([`Transaction stats — ${range.network === 'ALL' ? 'All networks' : range.network}`]).font = { bold: true, size: 14 };
  sheet.addRow([`From ${range.from} to ${range.to}`]);
  if (range.missingDates.length) {
    sheet.addRow([`Not fetched yet (excluded): ${range.missingDates.join(', ')}`]).font = { italic: true, color: { argb: 'FFC0392B' } };
  }
  sheet.addRow([]);

  const header = sheet.addRow(['Date', 'Network', 'Product', 'Total Transactions', 'Successful', 'Successful Amount', 'Successful GB']);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFED7D31' } };
  });

  for (const r of range.rows) {
    sheet.addRow([
      r.stat_date,
      r.network,
      r.prod_name,
      Number(r.total_count),
      Number(r.successful_count),
      Number(r.successful_amount),
      Number(Number(r.successful_gb).toFixed(3)),
    ]);
  }

  const t = range.totals;
  const totalRow = sheet.addRow(['TOTAL', '', '', t.totalCount, t.successfulCount, t.successfulAmount, Number(t.successfulGb.toFixed(3))]);
  totalRow.font = { bold: true };
  totalRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBE4D5' } };
    cell.border = { top: { style: 'thin' } };
  });

  sheet.columns.forEach((col, i) => { col.width = [12, 10, 36, 18, 12, 20, 16][i]; });
  sheet.getColumn(6).numFmt = '#,##0.00';
  sheet.getColumn(7).numFmt = '#,##0.000';

  // Daily summary on a second sheet.
  const daySheet = workbook.addWorksheet('Daily totals');
  daySheet.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Total Transactions', key: 'totalCount', width: 18 },
    { header: 'Successful', key: 'successfulCount', width: 12 },
    { header: 'Successful Amount', key: 'successfulAmount', width: 20, style: { numFmt: '#,##0.00' } },
    { header: 'Successful GB', key: 'successfulGb', width: 16, style: { numFmt: '#,##0.000' } },
  ];
  daySheet.getRow(1).font = { bold: true };
  range.days.forEach((d) => daySheet.addRow(d));
  const dayTotal = daySheet.addRow({ date: 'TOTAL', ...t });
  dayTotal.font = { bold: true };

  return workbook.xlsx.writeBuffer();
}

module.exports = {
  NETWORKS,
  normalizeNetwork,
  validateRange,
  fetchAndStoreDay,
  getDayStats,
  getRangeStats,
  buildRangeWorkbook,
};
