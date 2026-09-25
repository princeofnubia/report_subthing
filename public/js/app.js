const tableBody = document.getElementById('tableBody');
const emptyState = document.getElementById('emptyState');
const countLabel = document.getElementById('countLabel');
const addForm = document.getElementById('addForm');
const newEmailInput = document.getElementById('newEmail');
const newUserIdInput = document.getElementById('newUserId');
const toast = document.getElementById('toast');
const logoutBtn = document.getElementById('logoutBtn');

const templateForm = document.getElementById('templateForm');
const templateSubjectInput = document.getElementById('templateSubject');
const templateBodyInput = document.getElementById('templateBody');
const templateSavedLabel = document.getElementById('templateSavedLabel');

const reportSendForm = document.getElementById('reportSendForm');
const reportDateInput = document.getElementById('reportDate');
const reportRecipientSelect = document.getElementById('reportRecipient');
const reportSendBtn = document.getElementById('reportSendBtn');
const reportRunsBody = document.getElementById('reportRunsBody');
const reportRunsEmpty = document.getElementById('reportRunsEmpty');
const reportRunsPrevBtn = document.getElementById('reportRunsPrevBtn');
const reportRunsNextBtn = document.getElementById('reportRunsNextBtn');
const reportRunsRangeLabel = document.getElementById('reportRunsRangeLabel');

const REPORT_RUNS_PAGE_SIZE = 10;
let reportRunsOffset = 0;
let reportRunsTotal = 0;

const observerTableBody = document.getElementById('observerTableBody');
const observerEmptyState = document.getElementById('observerEmptyState');
const observerCountLabel = document.getElementById('observerCountLabel');
const addObserverForm = document.getElementById('addObserverForm');
const newObserverEmailInput = document.getElementById('newObserverEmail');

let recipients = [];
let editingId = null;

let observers = [];
let editingObserverId = null;

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.className = 'toast show' + (isError ? ' danger' : '');
  setTimeout(() => {
    toast.className = 'toast';
  }, 2600);
}

function formatDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ======================================================================
// RECIPIENTS
// ======================================================================

async function loadRecipients() {
  try {
    const res = await fetch('/api/recipients');
    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    recipients = await res.json();
    renderRecipients();
  } catch (err) {
    showToast('Failed to load recipients', true);
  }
}

function renderReportRecipientOptions() {
  const previousValue = reportRecipientSelect.value;
  const activeRecipients = recipients.filter((r) => r.active);

  reportRecipientSelect.innerHTML =
    '<option value="">All active recipients</option>' +
    activeRecipients
      .map((r) => `<option value="${r.id}">${escapeHtml(r.email)} (user_id ${r.user_id})</option>`)
      .join('');

  if (activeRecipients.some((r) => String(r.id) === previousValue)) {
    reportRecipientSelect.value = previousValue;
  }
}

function renderRecipients() {
  countLabel.textContent = `${recipients.length} total`;
  renderReportRecipientOptions();

  if (recipients.length === 0) {
    tableBody.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';

  tableBody.innerHTML = recipients
    .map((r) => {
      const isEditing = editingId === r.id;
      return `
        <tr data-id="${r.id}">
          <td class="email-cell">
            ${isEditing ? `<input type="email" value="${r.email}" id="editEmail-${r.id}" />` : escapeHtml(r.email)}
          </td>
          <td class="email-cell">
            ${isEditing ? `<input type="number" min="1" step="1" value="${r.user_id}" id="editUserId-${r.id}" style="max-width:100px;" />` : escapeHtml(String(r.user_id))}
          </td>
          <td>
            <span class="status-toggle" data-action="toggle-active" data-id="${r.id}" data-active="${r.active}">
              <span class="dot ${r.active ? 'active' : ''}"></span>
              ${r.active ? 'Active' : 'Paused'}
            </span>
          </td>
          <td>${formatDate(r.created_at)}</td>
          <td>
            <div class="row-actions">
              ${
                isEditing
                  ? `<button class="icon-btn" data-action="save-edit" data-id="${r.id}">Save</button>
                     <button class="icon-btn" data-action="cancel-edit" data-id="${r.id}">Cancel</button>`
                  : `<button class="icon-btn" data-action="edit" data-id="${r.id}">Edit</button>
                     <button class="icon-btn danger" data-action="delete" data-id="${r.id}">Delete</button>`
              }
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = newEmailInput.value.trim();
  const userId = Number(newUserIdInput.value);
  if (!email || !userId) return;

  try {
    const res = await fetch('/api/recipients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, user_id: userId }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Failed to add recipient', true);
      return;
    }
    newEmailInput.value = '';
    newUserIdInput.value = '';
    showToast('Recipient added');
    loadRecipients();
  } catch (err) {
    showToast('Failed to add recipient', true);
  }
});

tableBody.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  const id = target.dataset.id;

  if (action === 'edit') {
    editingId = Number(id);
    renderRecipients();
  } else if (action === 'cancel-edit') {
    editingId = null;
    renderRecipients();
  } else if (action === 'save-edit') {
    const emailInput = document.getElementById(`editEmail-${id}`);
    const userIdInput = document.getElementById(`editUserId-${id}`);
    const newEmail = emailInput.value.trim();
    const newUserId = Number(userIdInput.value);
    if (!newEmail || !newUserId) return;

    try {
      const res = await fetch(`/api/recipients/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, user_id: newUserId }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to update recipient', true);
        return;
      }
      editingId = null;
      showToast('Recipient updated');
      loadRecipients();
    } catch (err) {
      showToast('Failed to update recipient', true);
    }
  } else if (action === 'delete') {
    if (!confirm('Remove this recipient?')) return;
    try {
      const res = await fetch(`/api/recipients/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to delete recipient', true);
        return;
      }
      showToast('Recipient removed');
      loadRecipients();
    } catch (err) {
      showToast('Failed to delete recipient', true);
    }
  } else if (action === 'toggle-active') {
    const currentlyActive = target.dataset.active === '1';
    try {
      const res = await fetch(`/api/recipients/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !currentlyActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to update status', true);
        return;
      }
      loadRecipients();
    } catch (err) {
      showToast('Failed to update status', true);
    }
  }
});

// ======================================================================
// OBSERVER EMAILS
// ======================================================================

async function loadObservers() {
  try {
    const res = await fetch('/api/observers');
    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    observers = await res.json();
    renderObservers();
  } catch (err) {
    showToast('Failed to load observer emails', true);
  }
}

function renderObservers() {
  observerCountLabel.textContent = `${observers.length} total`;

  if (observers.length === 0) {
    observerTableBody.innerHTML = '';
    observerEmptyState.style.display = 'block';
    return;
  }
  observerEmptyState.style.display = 'none';

  observerTableBody.innerHTML = observers
    .map((o) => {
      const isEditing = editingObserverId === o.id;
      return `
        <tr data-id="${o.id}">
          <td class="email-cell">
            ${isEditing ? `<input type="email" value="${o.email}" id="editObserverEmail-${o.id}" />` : escapeHtml(o.email)}
          </td>
          <td>
            <span class="status-toggle" data-obs-action="toggle-active" data-id="${o.id}" data-active="${o.active}">
              <span class="dot ${o.active ? 'active' : ''}"></span>
              ${o.active ? 'Active' : 'Paused'}
            </span>
          </td>
          <td>${formatDate(o.created_at)}</td>
          <td>
            <div class="row-actions">
              ${
                isEditing
                  ? `<button class="icon-btn" data-obs-action="save-edit" data-id="${o.id}">Save</button>
                     <button class="icon-btn" data-obs-action="cancel-edit" data-id="${o.id}">Cancel</button>`
                  : `<button class="icon-btn" data-obs-action="edit" data-id="${o.id}">Edit</button>
                     <button class="icon-btn danger" data-obs-action="delete" data-id="${o.id}">Delete</button>`
              }
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

addObserverForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = newObserverEmailInput.value.trim();
  if (!email) return;

  try {
    const res = await fetch('/api/observers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Failed to add observer email', true);
      return;
    }
    newObserverEmailInput.value = '';
    showToast('Observer email added');
    loadObservers();
  } catch (err) {
    showToast('Failed to add observer email', true);
  }
});

observerTableBody.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-obs-action]');
  if (!target) return;

  const action = target.dataset.obsAction;
  const id = target.dataset.id;

  if (action === 'edit') {
    editingObserverId = Number(id);
    renderObservers();
  } else if (action === 'cancel-edit') {
    editingObserverId = null;
    renderObservers();
  } else if (action === 'save-edit') {
    const input = document.getElementById(`editObserverEmail-${id}`);
    const newEmail = input.value.trim();
    if (!newEmail) return;

    try {
      const res = await fetch(`/api/observers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to update observer email', true);
        return;
      }
      editingObserverId = null;
      showToast('Observer email updated');
      loadObservers();
    } catch (err) {
      showToast('Failed to update observer email', true);
    }
  } else if (action === 'delete') {
    if (!confirm('Remove this observer email?')) return;
    try {
      const res = await fetch(`/api/observers/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to delete observer email', true);
        return;
      }
      showToast('Observer email removed');
      loadObservers();
    } catch (err) {
      showToast('Failed to delete observer email', true);
    }
  } else if (action === 'toggle-active') {
    const currentlyActive = target.dataset.active === '1';
    try {
      const res = await fetch(`/api/observers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !currentlyActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to update status', true);
        return;
      }
      loadObservers();
    } catch (err) {
      showToast('Failed to update status', true);
    }
  }
});

// ======================================================================
// MESSAGE TEMPLATE
// ======================================================================

async function loadTemplate() {
  try {
    const res = await fetch('/api/message-template');
    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    const data = await res.json();
    templateSubjectInput.value = data.subject || '';
    templateBodyInput.value = data.body || '';
    if (data.updated_at) {
      templateSavedLabel.textContent = `Saved ${formatDate(data.updated_at)}`;
    }
  } catch (err) {
    showToast('Failed to load message', true);
  }
}

templateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const subject = templateSubjectInput.value.trim();
  const body = templateBodyInput.value;

  if (!subject || !body.trim()) return;

  try {
    const res = await fetch('/api/message-template', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, body }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Failed to save message', true);
      return;
    }
    showToast('Message saved');
    templateSavedLabel.textContent = 'Saved just now';
  } catch (err) {
    showToast('Failed to save message', true);
  }
});

// ======================================================================
// REPORT RUNS
// ======================================================================

async function loadReportRuns() {
  try {
    const res = await fetch(`/api/reports?limit=${REPORT_RUNS_PAGE_SIZE}&offset=${reportRunsOffset}`);
    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    const data = await res.json();
    reportRunsTotal = data.total || 0;
    renderReportRuns(data.rows || []);
    renderPagination();
  } catch (err) {
    showToast('Failed to load report history', true);
  }
}

function renderPagination() {
  if (reportRunsTotal === 0) {
    reportRunsRangeLabel.textContent = '';
    reportRunsPrevBtn.disabled = true;
    reportRunsNextBtn.disabled = true;
    return;
  }
  const start = reportRunsOffset + 1;
  const end = Math.min(reportRunsOffset + REPORT_RUNS_PAGE_SIZE, reportRunsTotal);
  reportRunsRangeLabel.textContent = `${start}\u2013${end} of ${reportRunsTotal}`;
  reportRunsPrevBtn.disabled = reportRunsOffset === 0;
  reportRunsNextBtn.disabled = end >= reportRunsTotal;
}

reportRunsPrevBtn.addEventListener('click', () => {
  reportRunsOffset = Math.max(0, reportRunsOffset - REPORT_RUNS_PAGE_SIZE);
  loadReportRuns();
});

reportRunsNextBtn.addEventListener('click', () => {
  if (reportRunsOffset + REPORT_RUNS_PAGE_SIZE < reportRunsTotal) {
    reportRunsOffset += REPORT_RUNS_PAGE_SIZE;
    loadReportRuns();
  }
});

function renderReportRuns(runs) {
  if (!runs || runs.length === 0) {
    reportRunsBody.innerHTML = '';
    reportRunsEmpty.style.display = 'block';
    return;
  }
  reportRunsEmpty.style.display = 'none';

  reportRunsBody.innerHTML = runs
    .map((r) => {
      const dateStr = new Date(r.report_date).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      const runAtStr = formatDate(r.run_at);
      const title = r.error_message ? ` title="${escapeHtml(r.error_message)}"` : '';
      return `
        <tr${title}>
          <td>${dateStr}</td>
          <td>${r.user_id != null ? escapeHtml(String(r.user_id)) : '—'}</td>
          <td>${r.recipient_email ? escapeHtml(r.recipient_email) : '—'}</td>
          <td><span class="status-badge ${r.status}">${r.status}</span></td>
          <td>${r.recipients_sent}</td>
          <td>${r.recipients_failed}</td>
          <td>${runAtStr}</td>
        </tr>
      `;
    })
    .join('');
}

reportSendForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = reportDateInput.value;
  if (!date) return;

  const recipientId = reportRecipientSelect.value;

  reportSendBtn.disabled = true;
  reportSendBtn.textContent = 'Starting...';

  try {
    const res = await fetch('/api/reports/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recipientId ? { date, recipientId } : { date }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Failed to start report', true);
      return;
    }
    const target = recipientId
      ? reportRecipientSelect.options[reportRecipientSelect.selectedIndex].textContent
      : 'all active recipients';
    showToast(`Report for ${date} started for ${target} \u2014 check the table below as it completes`);
    reportRunsOffset = 0;
    loadReportRuns();
    pollReportRunsForAWhile();
  } catch (err) {
    showToast('Failed to start report', true);
  } finally {
    reportSendBtn.disabled = false;
    reportSendBtn.textContent = 'Send report';
  }
});

// Large reports can take minutes to fully process (one send per
// recipient). Since the send is now fire-and-forget, poll the run history
// periodically for a while after starting one, so new rows show up
// without the user needing to manually refresh.
function pollReportRunsForAWhile() {
  let attempts = 0;
  const maxAttempts = 20; // ~5 minutes at 15s intervals
  const interval = setInterval(() => {
    attempts += 1;
    if (reportRunsOffset === 0) {
      loadReportRuns();
    }
    if (attempts >= maxAttempts) {
      clearInterval(interval);
    }
  }, 15000);
}

// ---------- Logout ----------
logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// ---------- Init ----------
loadRecipients();
loadObservers();
loadTemplate();
loadReportRuns();
