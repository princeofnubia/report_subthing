const $ = (id) => document.getElementById(id);
const toast = $('toast');

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.className = 'toast show' + (isError ? ' danger' : '');
  setTimeout(() => {
    toast.className = 'toast';
  }, 2600);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const intFmt = new Intl.NumberFormat();
const moneyFmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const gbFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
}

async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Not authenticated');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ======================================================================
// ONE DAY
// ======================================================================

function renderDay(data) {
  const { rows, totals } = data;
  const netLabel = data.network === 'ALL' ? 'all networks' : data.network;

  if (!data.fetched) {
    $('dayStatusLabel').textContent = 'Not queried yet';
  } else {
    const when = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : '';
    $('dayStatusLabel').textContent = when ? `Saved ${when}` : 'Saved';
  }

  if (rows.length === 0) {
    $('dayTiles').style.display = 'none';
    $('dayTable').style.display = 'none';
    $('dayEmpty').style.display = 'block';
    $('dayEmpty').textContent = data.fetched
      ? `No ${netLabel} transactions on ${data.date}.`
      : `${data.date} hasn't been queried yet. Click Query to pull it from the transactions database.`;
    return;
  }

  $('tileTotal').textContent = intFmt.format(totals.totalCount);
  $('tileSuccess').textContent = intFmt.format(totals.successfulCount);
  $('tileAmount').textContent = moneyFmt.format(totals.successfulAmount);
  $('tileGb').textContent = gbFmt.format(totals.successfulGb);
  $('dayTiles').style.display = '';

  $('dayBody').innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(r.prod_name)}</td>
        <td>${escapeHtml(r.network)}</td>
        <td class="num">${intFmt.format(r.total_count)}</td>
        <td class="num">${intFmt.format(r.successful_count)}</td>
        <td class="num">${moneyFmt.format(r.successful_amount)}</td>
        <td class="num">${gbFmt.format(r.successful_gb)}</td>
      </tr>`
    )
    .join('');
  $('dayTable').style.display = '';
  $('dayEmpty').style.display = 'none';
}

// Show what's already saved for the chosen day/network (no DB query).
async function loadStoredDay() {
  const date = $('dayDate').value;
  if (!date) return;
  const params = new URLSearchParams({ date, network: $('dayNetwork').value });
  try {
    renderDay(await api(`/api/transactions/day?${params}`));
  } catch (err) {
    showToast(err.message, true);
  }
}

$('dayForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('dayFetchBtn');
  btn.disabled = true;
  btn.textContent = 'Querying…';
  try {
    const data = await api('/api/transactions/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: $('dayDate').value, network: $('dayNetwork').value }),
    });
    renderDay(data);
    showToast(`Saved stats for ${data.date}`);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Query';
  }
});

$('dayDate').addEventListener('change', loadStoredDay);
$('dayNetwork').addEventListener('change', loadStoredDay);

// ======================================================================
// RANGE
// ======================================================================

function rangeParams() {
  return new URLSearchParams({
    from: $('rangeFrom').value,
    to: $('rangeTo').value,
    network: $('rangeNetwork').value,
  });
}

function renderRange(data) {
  const missing = data.missingDates;
  if (missing.length) {
    const shown = missing.slice(0, 15).join(', ');
    const more = missing.length > 15 ? ` and ${missing.length - 15} more` : '';
    $('rangeMissing').textContent = `${missing.length} day(s) not queried yet, so not included: ${shown}${more}.`;
    $('rangeMissing').style.display = 'block';
  } else {
    $('rangeMissing').style.display = 'none';
  }

  $('rangeStatusLabel').textContent = `${data.days.length} day(s) with data`;

  if (data.days.length === 0) {
    $('rangeTable').style.display = 'none';
    $('rangeEmpty').style.display = 'block';
    return;
  }

  $('rangeBody').innerHTML = data.days
    .map(
      (d) => `
      <tr>
        <td>${escapeHtml(d.date)}</td>
        <td class="num">${intFmt.format(d.totalCount)}</td>
        <td class="num">${intFmt.format(d.successfulCount)}</td>
        <td class="num">${moneyFmt.format(d.successfulAmount)}</td>
        <td class="num">${gbFmt.format(d.successfulGb)}</td>
      </tr>`
    )
    .join('');
  const t = data.totals;
  $('rangeFoot').innerHTML = `
    <tr>
      <td>Total</td>
      <td class="num">${intFmt.format(t.totalCount)}</td>
      <td class="num">${intFmt.format(t.successfulCount)}</td>
      <td class="num">${moneyFmt.format(t.successfulAmount)}</td>
      <td class="num">${gbFmt.format(t.successfulGb)}</td>
    </tr>`;
  $('rangeTable').style.display = '';
  $('rangeEmpty').style.display = 'none';
}

$('rangeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    renderRange(await api(`/api/transactions/range?${rangeParams()}`));
  } catch (err) {
    showToast(err.message, true);
  }
});

$('rangeDownloadBtn').addEventListener('click', async () => {
  if (!$('rangeForm').reportValidity()) return;
  const btn = $('rangeDownloadBtn');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/transactions/range/download?${rangeParams()}`);
    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Download failed');
    }
    const blob = await res.blob();
    const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = match ? match[1] : 'transactions.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ======================================================================
// INIT
// ======================================================================

$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

(function init() {
  const y = yesterdayStr();
  $('dayDate').value = y;
  $('dayDate').max = y;
  $('rangeTo').value = y;
  const start = new Date();
  start.setDate(1);
  $('rangeFrom').value = start.toLocaleDateString('en-CA');
  if ($('rangeFrom').value > y) $('rangeFrom').value = y;
  loadStoredDay();
})();
