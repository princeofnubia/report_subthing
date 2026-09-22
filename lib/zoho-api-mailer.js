// lib/zoho-api-mailer.js
//
// Sends email via Zoho Mail's HTTPS API instead of SMTP. Use this in place
// of the nodemailer/SMTP transporter when outbound SMTP ports (465/587)
// are blocked (e.g. DigitalOcean's default anti-spam port block) — this
// goes over port 443 instead.
//
// Requires (in .env):
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_FROM_EMAIL
//
// Requires Node.js 18+ (uses the built-in fetch API).

const ZOHO_ACCOUNTS_BASE = 'https://accounts.zoho.com';
const ZOHO_MAIL_BASE = 'https://mail.zoho.com/api';

let cachedAccessToken = null;
let cachedTokenExpiry = 0; // epoch ms
let cachedAccountId = null;

// ---------- Step 1: exchange refresh token for a short-lived access token ----------
async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < cachedTokenExpiry) {
    return cachedAccessToken;
  }

  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const res = await fetch(`${ZOHO_ACCOUNTS_BASE}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Failed to refresh Zoho access token: ${JSON.stringify(data)}`);
  }

  cachedAccessToken = data.access_token;
  // Refresh a little early (50 min instead of the full 60) to be safe.
  cachedTokenExpiry = now + (data.expires_in ? data.expires_in - 600 : 3000) * 1000;
  return cachedAccessToken;
}

// ---------- Step 2: look up the Zoho Mail account ID (once, then cached) ----------
async function getAccountId() {
  if (cachedAccountId) return cachedAccountId;

  const accessToken = await getAccessToken();
  const res = await fetch(`${ZOHO_MAIL_BASE}/accounts`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const data = await res.json();

  if (!res.ok || !data.data || data.data.length === 0) {
    throw new Error(`Failed to fetch Zoho account ID: ${JSON.stringify(data)}`);
  }

  // Match the account whose email matches ZOHO_FROM_EMAIL, or fall back to the first one.
  const match =
    data.data.find((acc) =>
      (acc.mailboxAddress || acc.primaryEmailAddress || '').toLowerCase() ===
      (process.env.ZOHO_FROM_EMAIL || '').toLowerCase()
    ) || data.data[0];

  cachedAccountId = match.accountId;
  return cachedAccountId;
}

// ---------- Step 3: upload an attachment, get back a reference to include in the send ----------
async function uploadAttachment({ filename, content }) {
  const accessToken = await getAccessToken();
  const accountId = await getAccountId();

  const res = await fetch(
    `${ZOHO_MAIL_BASE}/accounts/${accountId}/messages/attachments?fileName=${encodeURIComponent(
      filename
    )}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: content, // Buffer
    }
  );

  const data = await res.json();
  if (!res.ok || !data.data) {
    throw new Error(`Failed to upload attachment to Zoho: ${JSON.stringify(data)}`);
  }

  // data.data is an object like { storeName, attachmentPath, attachmentName }
  return data.data;
}

// ---------- Step 4: send the message ----------
// attachments: optional array of { filename, content: Buffer }
async function sendMail({ to, subject, html, attachments = [] }) {
  const accessToken = await getAccessToken();
  const accountId = await getAccountId();

  const uploadedAttachments = [];
  for (const att of attachments) {
    const uploaded = await uploadAttachment(att);
    uploadedAttachments.push(uploaded);
  }

  const body = {
    fromAddress: process.env.ZOHO_FROM_EMAIL,
    toAddress: to,
    subject,
    content: html,
    mailFormat: 'html',
  };

  if (uploadedAttachments.length > 0) {
    body.attachments = uploadedAttachments;
  }

  const res = await fetch(`${ZOHO_MAIL_BASE}/accounts/${accountId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok || data.status?.code !== 200) {
    throw new Error(`Failed to send email via Zoho API: ${JSON.stringify(data)}`);
  }

  return data;
}

module.exports = { sendMail };
