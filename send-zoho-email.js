// send-zoho-email.js
//
// Standalone utility for testing your Zoho SMTP credentials in isolation —
// useful for confirming .env is set up correctly before relying on the
// cron job. This is NOT used by the report-sending pipeline itself; the
// real send logic lives in lib/report-job.js. Run it directly:
//
//   npm run test-zoho
//   (or: node send-zoho-email.js)
//
// Setup:
//   1. npm install (nodemailer is already in package.json)
//   2. In Zoho Mail: Settings > Security > App Passwords -> generate one
//      (do NOT use your normal account password here)
//   3. Fill in ZOHO_EMAIL / ZOHO_APP_PASSWORD in .env, or edit CONFIG below.
//   4. Edit the recipient/attachment in the USAGE EXAMPLE block before running.

require('dotenv').config();
const nodemailer = require('nodemailer');
const path = require('path');

// ---------- CONFIG ----------
// Same env var names used by lib/report-job.js and .env.example, so this
// picks up the same credentials the real cron job uses.
const CONFIG = {
  zohoUser: process.env.ZOHO_EMAIL || 'yourname@yourdomain.com',
  zohoAppPassword: process.env.ZOHO_APP_PASSWORD || 'your-app-specific-password',
  smtpHost: process.env.ZOHO_SMTP_HOST || 'smtp.zoho.com',
  smtpPort: Number(process.env.ZOHO_SMTP_PORT) || 465, // use 587 if you set secure: false below
  secure: true, // true for port 465, false for port 587
  fromName: process.env.ZOHO_FROM_NAME || 'Reports',
};

// ---------- EMAIL TEMPLATE ----------
// Simple placeholder-based HTML template. Pass a `data` object with values
// to fill in {{name}}, {{message}}, etc.
function buildEmailTemplate({ name, message }) {
  return `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background-color: #2b6cb0; padding: 20px; text-align: center;">
      <h1 style="color: #ffffff; margin: 0;">Your Company Name</h1>
    </div>
    <div style="padding: 24px; background-color: #f9f9f9;">
      <p>Hi ${name || 'there'},</p>
      <p>${message || 'This is a default message.'}</p>
      <p>Please find the attached file for your reference.</p>
      <p>Best regards,<br/>The Team</p>
    </div>
    <div style="padding: 12px; text-align: center; font-size: 12px; color: #888;">
      &copy; ${new Date().getFullYear()} Your Company Name. All rights reserved.
    </div>
  </div>
  `;
}

async function sendEmailWithAttachment({ to, subject, text, html, attachmentPath }) {
  const transporter = nodemailer.createTransport({
    host: CONFIG.smtpHost,
    port: CONFIG.smtpPort,
    secure: CONFIG.secure,
    auth: {
      user: CONFIG.zohoUser,
      pass: CONFIG.zohoAppPassword,
    },
  });

  const mailOptions = {
    from: `"${CONFIG.fromName}" <${CONFIG.zohoUser}>`,
    to,
    subject,
    text,
    html,
    attachments: attachmentPath
      ? [
          {
            filename: path.basename(attachmentPath),
            path: attachmentPath,
          },
        ]
      : [],
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent successfully:', info.messageId);
    return info;
  } catch (err) {
    console.error('Failed to send email:', err.message);
    throw err;
  }
}

// ---------- USAGE EXAMPLE ----------
// Run: node send-zoho-email.js
if (require.main === module) {
  const htmlContent = buildEmailTemplate({
    name: 'John',
    message: 'Thanks for reaching out! Here is the document you requested.',
  });

  sendEmailWithAttachment({
    to: 'recipient@example.com',
    subject: 'Test Email with Attachment',
    text: 'Please find the attached file.', // plain-text fallback
    html: htmlContent,
    attachmentPath: path.join(__dirname, 'example.pdf'), // change to your file
  }).catch(() => process.exit(1));
}

module.exports = { sendEmailWithAttachment };
