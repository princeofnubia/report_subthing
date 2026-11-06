const $ = (id) => document.getElementById(id);
const toast = $('toast');

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.className = 'toast show' + (isError ? ' danger' : '');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => {
    toast.className = 'toast';
  }, 3200);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

const intFmt = new Intl.NumberFormat();
const moneyFmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const naira = (n) => `₦${moneyFmt.format(n)}`;
const NETWORK_LABELS = { MTN: 'MTN', GLO: 'GLO', AIRTEL: 'Airtel', '9MOBILE': '9mobile', OTHER: 'Other' };

const state = {
  pending: null, // last /api/pending response
  refunded: null, // last /api/refunds response
  configured: true,
  rowStatus: new Map(), // id -> { kind: 'working'|'refunded'|'skipped'|'error', reason }
  running: false,
  stopRequested: false,
  tab: 'pending',
};

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA');
}

const timeOf = (createdAt) => (createdAt ? createdAt.slice(11) : '');

async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Not authenticated');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.outcome) throw new Error(data.error || 'Request failed');
  return data;
}

// Pending rows still on the list (refunded ones are removed client-side).
function visiblePending() {
  if (!state.pending) return [];
  return state.pending.rows.filter((r) => state.rowStatus.get(r.id)?.kind !== 'gone');
}

// ======================================================================
// RENDER
// ======================================================================

function renderChips() {
  const data = state.pending;
  if (!data) return;
  const allCount = data.byNetwork.reduce((s, n) => s + n.count, 0);
  const allAmount = data.byNetwork.reduce((s, n) => s + n.amount, 0);
  const chips = [{ network: '', label: 'All', count: allCount, amount: allAmount }].concat(
    data.byNetwork
      .filter((n) => n.count > 0)
      .map((n) => ({ network: n.network, label: NETWORK_LABELS[n.network], count: n.count, amount: n.amount }))
  );
  const current = data.network === 'ALL' ? '' : data.network;
  $('networkChips').innerHTML = chips
    .map(
      (c) => `
      <button type="button" class="chip${c.network === current ? ' active' : ''}" data-network="${c.network}" ${state.running ? 'disabled' : ''}>
        <span class="chip-label">${escapeHtml(c.label)}</span>
        <span class="chip-count">${intFmt.format(c.count)}</span>
        <span class="chip-amount">${naira(c.amount)}</span>
      </button>`
    )
    .join('');
  $('networkChips').style.display = allCount ? '' : 'none';
}

function statusCell(r) {
  const st = state.rowStatus.get(r.id);
  if (!st) return `<span class="status-badge partial">${escapeHtml(r.appResponse)}</span>`;
  if (st.kind === 'working') return `<span class="status-badge working"><span class="spinner"></span>Refunding</span>`;
  if (st.kind === 'refunded') return `<span class="status-badge success">✓ Refunded</span>`;
  if (st.kind === 'skipped')
    return `<span class="status-badge muted">Skipped</span><div class="row-reason">${escapeHtml(st.reason)}</div>`;
  return `<span class="status-badge failed">Failed</span><div class="row-reason">${escapeHtml(st.reason)}</div>`;
}

function actionCell(r) {
  const st = state.rowStatus.get(r.id);
  if (st && (st.kind === 'working' || st.kind === 'refunded' || st.kind === 'skipped')) return '';
  const label = st && st.kind === 'error' ? 'Retry' : 'Refund';
  const disabled = state.running || !state.configured ? 'disabled' : '';
  return `<button type="button" class="btn-row-refund" data-id="${r.id}" ${disabled}>${label}</button>`;
}

function renderPending() {
  const data = state.pending;
  if (!data) return;
  renderChips();

  const rows = visiblePending();
  const outstanding = rows.filter((r) => {
    const k = state.rowStatus.get(r.id)?.kind;
    return k !== 'refunded' && k !== 'skipped';
  });
  const amount = outstanding.reduce((s, r) => s + r.cost, 0);
  const netLabel = data.network === 'ALL' ? 'all networks' : NETWORK_LABELS[data.network];

  $('pendingTabCount').textContent = intFmt.format(outstanding.length);
  $('pendingTotal').textContent = `${intFmt.format(outstanding.length)} pending · ${naira(amount)}`;
  $('pendingSub').textContent = `${netLabel}, ${data.date}`;

  const refundAll = $('refundAllBtn');
  refundAll.textContent = outstanding.length ? `Refund all ${intFmt.format(outstanding.length)}` : 'Refund all';
  refundAll.disabled = state.running || !state.configured || outstanding.length === 0;

  if (data.truncated) {
    $('truncatedBox').textContent = `More than ${intFmt.format(data.maxRows)} pending transactions on this day. Only the first ${intFmt.format(data.maxRows)} are shown.`;
    $('truncatedBox').style.display = 'block';
  } else {
    $('truncatedBox').style.display = 'none';
  }

  if (rows.length === 0) {
    $('pendingTable').style.display = 'none';
    $('pendingEmpty').textContent = `No pending ${netLabel} transactions on ${data.date}.`;
    $('pendingEmpty').style.display = 'block';
    return;
  }

  $('pendingBody').innerHTML = rows
    .map((r) => {
      const kind = state.rowStatus.get(r.id)?.kind || '';
      return `
      <tr data-row="${r.id}" class="${kind ? `row-${kind}` : ''}">
        <td class="mono">
          <div>${r.id}</div>
          <div class="sub">${escapeHtml(r.requestId || '')}</div>
        </td>
        <td class="mono">${escapeHtml(timeOf(r.createdAt))}</td>
        <td>
          <div>${escapeHtml(r.userName || `User ${r.userId ?? '?'}`)}</div>
          <div class="sub">${escapeHtml(r.userEmail)}${r.userId ? ` · #${escapeHtml(r.userId)}` : ''}</div>
        </td>
        <td>${escapeHtml(r.prodName)}</td>
        <td class="mono">${escapeHtml(r.recipient)}</td>
        <td class="num">${moneyFmt.format(r.cost)}</td>
        <td>${statusCell(r)}</td>
        <td class="action">${actionCell(r)}</td>
      </tr>`;
    })
    .join('');
  $('pendingTable').style.display = '';
  $('pendingEmpty').style.display = 'none';
}

function renderRefunded() {
  const data = state.refunded;
  if (!data) return;
  $('refundedTabCount').textContent = intFmt.format(data.total.count);
  $('refundedTotal').textContent = `${intFmt.format(data.total.count)} refunded · ${naira(data.total.amount)}`;

  if (data.rows.length === 0) {
    $('refundedTable').style.display = 'none';
    $('refundedEmpty').textContent = 'Nothing refunded for this date yet.';
    $('refundedEmpty').style.display = 'block';
    return;
  }
  $('refundedBody').innerHTML = data.rows
    .map(
      (r) => `
      <tr>
        <td class="mono">
          <div>${r.transaction_id}</div>
          <div class="sub">${escapeHtml(r.request_id || '')}</div>
        </td>
        <td>
          <div>${escapeHtml(r.user_name || `User ${r.user_id ?? '?'}`)}</div>
          <div class="sub">${r.user_id ? `#${escapeHtml(r.user_id)}` : ''}</div>
        </td>
        <td>${escapeHtml(r.prod_name)}</td>
        <td class="mono">${escapeHtml(r.recipient)}</td>
        <td class="num">${moneyFmt.format(r.amount)}</td>
        <td><span class="status-badge muted">${escapeHtml(r.previous_status)}</span></td>
        <td class="mono sub">${escapeHtml(r.reference)}</td>
        <td>
          <div>${escapeHtml(new Date(r.created_at).toLocaleString())}</div>
          <div class="sub">${escapeHtml(r.refunded_by || '')}</div>
        </td>
      </tr>`
    )
    .join('');
  $('refundedTable').style.display = '';
  $('refundedEmpty').style.display = 'none';
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('panel-pending').style.display = tab === 'pending' ? '' : 'none';
  $('panel-refunded').style.display = tab === 'refunded' ? '' : 'none';
}

// ======================================================================
// LOAD
// ======================================================================

function currentParams() {
  return new URLSearchParams({ date: $('pendingDate').value, network: $('pendingNetwork').value });
}

async function loadRefunded() {
  try {
    state.refunded = await api(`/api/refunds?${currentParams()}`);
    state.configured = state.refunded.configured;
    $('notConfiguredBox').style.display = state.configured ? 'none' : 'block';
    renderRefunded();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function load() {
  if (state.running) return;
  const btn = $('loadBtn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const [pending] = await Promise.all([api(`/api/pending?${currentParams()}`), loadRefunded()]);
    state.pending = pending;
    state.rowStatus.clear();
    renderPending();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load';
  }
}

// ======================================================================
// REFUND
// ======================================================================

// Refund one transaction; updates its row as it goes. Returns the result.
async function refundRow(row) {
  state.rowStatus.set(row.id, { kind: 'working' });
  renderPending();

  let result;
  try {
    result = await api('/api/pending/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: row.id }),
    });
  } catch (err) {
    result = { id: row.id, outcome: 'error', reason: err.message };
  }

  if (result.outcome === 'refunded') {
    state.rowStatus.set(row.id, { kind: 'refunded' });
    renderPending();
    // Let the green tick show briefly, then drop the row from the list.
    setTimeout(() => {
      if (state.rowStatus.get(row.id)?.kind !== 'refunded') return;
      const tr = document.querySelector(`tr[data-row="${row.id}"]`);
      if (tr) tr.classList.add('row-leaving');
      setTimeout(() => {
        if (state.rowStatus.get(row.id)?.kind === 'refunded') {
          state.rowStatus.set(row.id, { kind: 'gone' });
          renderPending();
        }
      }, 350);
    }, 900);
  } else if (result.outcome === 'skipped') {
    state.rowStatus.set(row.id, { kind: 'skipped', reason: result.reason });
    renderPending();
  } else {
    state.rowStatus.set(row.id, { kind: 'error', reason: result.reason || 'Refund failed' });
    renderPending();
  }
  return { ...result, amount: result.amount ?? row.cost };
}

async function refundSingle(id) {
  const row = visiblePending().find((r) => r.id === id);
  if (!row || state.running) return;
  const result = await refundRow(row);
  if (result.outcome === 'refunded') {
    showToast(`Refunded #${id} · ${naira(row.cost)}`);
    loadRefunded();
  } else if (result.outcome === 'skipped') {
    showToast(`#${id} skipped: ${result.reason}`, true);
  } else {
    showToast(`#${id} failed: ${result.reason}`, true);
  }
}

// ---------- Refund all, one at a time, with progress ----------

function updateProgress(p) {
  const done = p.refunded + p.skipped + p.failed;
  const pct = p.total ? Math.round((done / p.total) * 100) : 0;
  $('progressFill').style.width = `${pct}%`;
  $('statRefunded').textContent = intFmt.format(p.refunded);
  $('statAmount').textContent = moneyFmt.format(p.amount);
  $('statSkipped').textContent = intFmt.format(p.skipped);
  $('statFailed').textContent = intFmt.format(p.failed);
  $('progressTitle').textContent = state.running
    ? `Refunding ${intFmt.format(Math.min(done + 1, p.total))} of ${intFmt.format(p.total)}…`
    : p.stopped
    ? `Stopped after ${intFmt.format(done)} of ${intFmt.format(p.total)}`
    : `Done: ${intFmt.format(p.refunded)} of ${intFmt.format(p.total)} refunded`;
  $('progressCard').classList.toggle('finished', !state.running);
  $('progressCard').classList.toggle('has-failures', !state.running && p.failed > 0);
}

function setRunning(running) {
  state.running = running;
  ['loadBtn', 'pendingDate', 'pendingNetwork'].forEach((id) => ($(id).disabled = running));
  $('stopBtn').textContent = running ? 'Stop' : 'Close';
  $('stopBtn').disabled = false;
  renderPending();
}

async function refundAll(targets) {
  const p = { total: targets.length, refunded: 0, skipped: 0, failed: 0, amount: 0, stopped: false };
  state.stopRequested = false;
  $('progressCard').style.display = '';
  setRunning(true);
  updateProgress(p);

  for (const row of targets) {
    if (state.stopRequested) {
      p.stopped = true;
      break;
    }
    $('progressNow').textContent = `#${row.id}${row.requestId ? ` (${row.requestId})` : ''} · ${row.prodName} · ${row.recipient || ''} · ${naira(row.cost)}`;
    const result = await refundRow(row);
    if (result.outcome === 'refunded') {
      p.refunded += 1;
      p.amount += Number(result.amount) || 0;
    } else if (result.outcome === 'skipped') {
      p.skipped += 1;
    } else {
      p.failed += 1;
    }
    updateProgress(p);
  }

  setRunning(false);
  $('progressNow').textContent =
    p.failed > 0 ? 'Failed rows stay in the list with the reason. Use Retry on each, or run Refund all again.' : '';
  updateProgress(p);
  loadRefunded();
  showToast(`${p.refunded} refunded (${naira(p.amount)}), ${p.skipped} skipped, ${p.failed} failed`, p.failed > 0);
}

// ---------- Confirm dialog ----------

function confirmRefund(count, amount, netLabel) {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = `Refund ${intFmt.format(count)} transaction${count === 1 ? '' : 's'}?`;
    $('confirmText').textContent = `All pending ${netLabel} transactions on ${state.pending.date} that are listed below.`;
    $('confirmAmount').textContent = naira(amount);
    $('confirmModal').style.display = 'flex';
    $('confirmOk').focus();
    const close = (answer) => {
      $('confirmModal').style.display = 'none';
      $('confirmOk').onclick = null;
      $('confirmCancel').onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
    };
    $('confirmOk').onclick = () => close(true);
    $('confirmCancel').onclick = () => close(false);
    document.addEventListener('keydown', onKey);
  });
}

// ======================================================================
// EVENTS
// ======================================================================

$('pendingForm').addEventListener('submit', (e) => {
  e.preventDefault();
  load();
});
$('pendingNetwork').addEventListener('change', load);

$('networkChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip || state.running) return;
  $('pendingNetwork').value = chip.dataset.network;
  load();
});

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

$('pendingBody').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-row-refund');
  if (btn) refundSingle(Number(btn.dataset.id));
});

$('refundAllBtn').addEventListener('click', async () => {
  const targets = visiblePending().filter((r) => {
    const k = state.rowStatus.get(r.id)?.kind;
    return !k || k === 'error';
  });
  if (!targets.length) return;
  const amount = targets.reduce((s, r) => s + r.cost, 0);
  const netLabel = state.pending.network === 'ALL' ? '' : NETWORK_LABELS[state.pending.network];
  if (await confirmRefund(targets.length, amount, netLabel)) {
    refundAll(targets);
  }
});

$('stopBtn').addEventListener('click', () => {
  if (state.running) {
    state.stopRequested = true;
    $('stopBtn').disabled = true;
    $('stopBtn').textContent = 'Stopping…';
  } else {
    $('progressCard').style.display = 'none';
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.running) {
    e.preventDefault();
    e.returnValue = '';
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

(function init() {
  $('pendingDate').value = yesterdayStr();
  $('pendingDate').max = new Date().toLocaleDateString('en-CA');
  load();
})();
