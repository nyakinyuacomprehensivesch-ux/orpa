/*
 * ORPA email module — Nodemailer wrapper with graceful fallback.
 *
 * If SMTP is configured (EMAIL_SMTP_HOST / .env), real emails are sent.
 * If not, every email is logged to the console and written to data/emails/
 * so you can still read exactly what would have been sent during a pilot.
 */
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const EMAIL_DIR = path.join(DATA_DIR, 'emails');

function ensureEmailDir() {
  if (!fs.existsSync(EMAIL_DIR)) fs.mkdirSync(EMAIL_DIR, { recursive: true });
}

// ---------- SMTP setup ----------
let transporter = null;
let fromAddress = '';

function configureTransport() {
  const host = process.env.EMAIL_SMTP_HOST || '';
  const port = parseInt(process.env.EMAIL_SMTP_PORT || '587', 10);
  const user = process.env.EMAIL_SMTP_USER || '';
  const pass = process.env.EMAIL_SMTP_PASS || '';
  const from = process.env.EMAIL_FROM || '';

  if (!host || !user) {
    console.log('[email] No SMTP configured. Emails will be logged to console + data/emails/ instead.');
    transporter = null;
    fromAddress = from || 'ORPA <no-reply@orpa.local>';
    return;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  fromAddress = from || ('ORPA <' + user + '>');
  console.log(`[email] SMTP configured: ${host}:${port} (user=${user})`);
}

configureTransport();

// ---------- Template engine ----------
function wrapBody(innerHtml, preview) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef0f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f6;min-height:100vh">
<tr><td align="center" style="padding:28px 12px">
<table width="580" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(30,36,48,.08)">
<!-- Header -->
<tr><td style="background:linear-gradient(135deg,#169DFF,#0B4EA2);padding:26px 30px">
<table cellpadding="0" cellspacing="0"><tr>
<td style="width:40px;height:40px;background:rgba(255,255,255,.16);border-radius:10px;text-align:center;vertical-align:middle;font-size:20px">\uD83D\uDCC8</td>
<td style="padding-left:14px;color:#fff;font-size:22px;font-weight:800;letter-spacing:-.3px">ORPA</td>
</tr></table>
</td></tr>
<!-- Body -->
<tr><td style="padding:28px 30px;color:#1e2430;font-size:15px;line-height:1.65">
${innerHtml}
</td></tr>
<!-- Footer -->
<tr><td style="padding:18px 30px;background:#f6f7fb;border-top:1px solid #e7e9f0;font-size:12px;color:#6b7280;text-align:center">
ORPA &mdash; ORPA Executes &bull; Marks &rarr; Reports &bull; Downloads &nbsp;|&nbsp; CBE-aligned grading for Grades 1&ndash;9<br>
This is an automated message. Do not reply to this email.
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// ---------- Templates ----------
const TEMPLATES = {
  registrationPending(user, opts) {
    const t = opts.teacher || {};
    const inner = `
      <p style="margin:0 0 16px">Hello <strong>${escHtml(user.name)}</strong>,</p>
      <div style="background:#EAF6FF;border-left:4px solid #0B4EA2;padding:14px 18px;border-radius:0 8px 8px 0;margin:0 0 18px">
        <p style="margin:0;font-size:16px;font-weight:700;color:#0B4EA2">New ORPA account awaiting approval</p>
      </div>
      <p style="margin:0 0 8px"><strong>Teacher:</strong> ${escHtml(t.name)}</p>
      <p style="margin:0 0 8px"><strong>Email:</strong> ${escHtml(t.email)}</p>
      <p style="margin:0 0 8px"><strong>School:</strong> ${escHtml(t.school || '—')}</p>
      <p style="margin:18px 0 0;color:#6b7280">Open the ORPA Owner Admin dashboard to activate or reject this account. The teacher cannot sign in until you activate the account.</p>`;
    return { subject:'ORPA — New Teacher Account Awaiting Approval', html:wrapBody(inner,'New ORPA teacher account awaiting approval'), text:`New ORPA account awaiting approval\nTeacher: ${t.name}\nEmail: ${t.email}\nSchool: ${t.school || '—'}\nOpen the ORPA Owner Admin dashboard to activate or reject this account.` };
  },

  loginRequest(user, opts) {
    const r = opts.request || {};
    const inner = `
      <p style="margin:0 0 16px">Hello <strong>${escHtml(user.name)}</strong>,</p>
      <div style="background:#EAF6FF;border-left:4px solid #0B4EA2;padding:14px 18px;border-radius:0 8px 8px 0;margin:0 0 18px">
        <p style="margin:0;font-size:16px;font-weight:700;color:#0B4EA2">New ORPA login authorization request</p>
      </div>
      <p style="margin:0 0 8px"><strong>Teacher:</strong> ${escHtml(r.name)}</p>
      <p style="margin:0 0 8px"><strong>Email:</strong> ${escHtml(r.email)}</p>
      <p style="margin:0 0 8px"><strong>IP:</strong> ${escHtml(r.ip || 'unknown')}</p>
      <p style="margin:0 0 8px"><strong>Request ID:</strong> ${escHtml(r.id)}</p>
      <p style="margin:18px 0 0;color:#6b7280">Open the Owner Admin dashboard to approve or deny this request. The 6-character authorization code is shown only after approval.</p>`;
    return { subject:'ORPA — Login Authorization Request', html:wrapBody(inner,'New teacher login authorization request'), text:`New ORPA login authorization request\nTeacher: ${r.name}\nEmail: ${r.email}\nRequest ID: ${r.id}\nOpen the Owner Admin dashboard to approve or deny it.` };
  },

  suspended(user, opts) {
    const ownerName = opts.ownerName;
    const displayReason = opts.reason || 'Your account has been suspended by the system administrator.';
    const inner = `
      <p style="margin:0 0 16px">Hello <strong>${escHtml(user.name)}</strong>,</p>
      <div style="background:#fdecea;border-left:4px solid #C62828;padding:14px 18px;border-radius:0 8px 8px 0;margin:0 0 18px">
        <p style="margin:0;font-size:16px;font-weight:700;color:#C62828">Your ORPA account has been suspended</p>
      </div>
      <p style="margin:0 0 10px">${displayReason}</p>
      <p style="margin:0 0 10px">While suspended, you cannot sign in or access any grading features. If you believe this was done in error, please contact the administrator.</p>
      <p style="margin:0 0 0;color:#6b7280;font-size:14px">Suspended by: <strong>${escHtml(ownerName)}</strong> &nbsp;|&nbsp; ${new Date().toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })}</p>`;
    return { subject: 'ORPA — Account Suspended', html: wrapBody(inner, 'Your ORPA account has been suspended'), text: `Hello ${user.name},

Your ORPA account has been suspended.
${displayReason}
Suspended by: ${ownerName}

If you believe this was done in error, please contact the administrator.` };
  },

  activated(user, opts) {
    const ownerName = opts.ownerName;
    const inner = `
      <p style="margin:0 0 16px">Hello <strong>${escHtml(user.name)}</strong>,</p>
      <div style="background:#e6f7ed;border-left:4px solid #1B5E20;padding:14px 18px;border-radius:0 8px 8px 0;margin:0 0 18px">
        <p style="margin:0;font-size:16px;font-weight:700;color:#1B5E20">Your ORPA account has been reactivated</p>
      </div>
      <p style="margin:0 0 10px">You can now sign in and use the system as normal.</p>
      <p style="margin:0 0 0;color:#6b7280;font-size:14px">Reactivated by: <strong>${escHtml(ownerName)}</strong> &nbsp;|&nbsp; ${new Date().toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })}</p>`;
    return { subject: 'ORPA — Account Reactivated', html: wrapBody(inner, 'Your ORPA account has been reactivated'), text: `Hello ${user.name},

Your ORPA account has been reactivated. You can now sign in normally.
Reactivated by: ${ownerName}` };
  },

  deleted(user, opts) {
    const ownerName = opts.ownerName;
    const inner = `
      <p style="margin:0 0 16px">Hello <strong>${escHtml(user.name)}</strong>,</p>
      <div style="background:#fdecea;border-left:4px solid #C62828;padding:14px 18px;border-radius:0 8px 8px 0;margin:0 0 18px">
        <p style="margin:0;font-size:16px;font-weight:700;color:#C62828">Your ORPA account has been removed</p>
      </div>
      <p style="margin:0 0 10px">Your account and all associated data have been permanently deleted. You will no longer be able to sign in.</p>
      <p style="margin:0 0 10px">If you believe this was done in error, please contact the administrator.</p>
      <p style="margin:0 0 0;color:#6b7280;font-size:14px">Removed by: <strong>${escHtml(ownerName)}</strong> &nbsp;|&nbsp; ${new Date().toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })}</p>`;
    return { subject: 'ORPA — Account Removed', html: wrapBody(inner, 'Your ORPA account has been removed'), text: `Hello ${user.name},

Your ORPA account has been permanently removed.
Removed by: ${ownerName}

If you believe this was done in error, please contact the administrator.` };
  },

  forceLogout(user, opts) {
    const ownerName = opts.ownerName;
    const inner = `
      <p style="margin:0 0 16px">Hello <strong>${escHtml(user.name)}</strong>,</p>
      <div style="background:#fff8e1;border-left:4px solid #E65100;padding:14px 18px;border-radius:0 8px 8px 0;margin:0 0 18px">
        <p style="margin:0;font-size:16px;font-weight:700;color:#E65100">You were signed out of ORPA</p>
      </div>
      <p style="margin:0 0 10px">An administrator ended your active session. You can sign in again to continue using the system.</p>
      <p style="margin:0 0 0;color:#6b7280;font-size:14px">Signed out by: <strong>${escHtml(ownerName)}</strong> &nbsp;|&nbsp; ${new Date().toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })}</p>`;
    return { subject: 'ORPA — Session Ended', html: wrapBody(inner, 'Your ORPA session was ended by an administrator'), text: `Hello ${user.name},

Your ORPA session was ended by an administrator. You can sign in again to continue.
Signed out by: ${ownerName}` };
  },
};

function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ---------- Send ----------
async function sendMail(to, subject, html, text) {
  const mail = { from: fromAddress, to, subject, html, text };

  if (transporter) {
    try {
      const info = await transporter.sendMail(mail);
      console.log(`[email] Sent to ${to} — ${subject} (${info.messageId})`);
      return { sent: true, messageId: info.messageId };
    } catch (e) {
      console.error(`[email] SMTP send failed to ${to}:`, e.message);
      // Fall back to file logging
    }
  }

  // No SMTP or SMTP failed — log to file
  ensureEmailDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fileBase = `${ts}_${to.replace(/[^a-z0-9]/gi, '_')}_${subject.replace(/[^a-z0-9]/gi, '_').substring(0, 40)}`;
  fs.writeFileSync(path.join(EMAIL_DIR, fileBase + '.html'), html);
  fs.writeFileSync(path.join(EMAIL_DIR, fileBase + '.txt'), text || '');
  console.log(`[email] Logged (no SMTP) to data/emails/${fileBase}.* — ${to}: ${subject}`);
  return { sent: false, logged: true };
}

async function sendTemplate(templateName, user, extra) {
  const opts = { ownerName: (extra && extra.ownerName) || 'System Owner', reason: extra && extra.reason, request: extra && extra.request, teacher: extra && extra.teacher };
  const tpl = TEMPLATES[templateName];
  if (!tpl) { console.warn(`[email] Unknown template: ${templateName}`); return; }
  const { subject, html, text } = tpl(user, opts);
  if (!user.email) { console.warn(`[email] No email for user ${user.id}, skipping.`); return; }
  return sendMail(user.email, subject, html, text);
}

module.exports = { sendTemplate, sendMail, TEMPLATES };
