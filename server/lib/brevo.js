'use strict';

/**
 * Envoi d'e-mails par l'API REST Brevo — même appel que la boutique Box Plus
 * (storefront/lib/brevo-send.js : POST https://api.brevo.com/v3/smtp/email).
 * Sans clé API (développement) : l'e-mail est écrit dans data/outbox pour être relu.
 *
 * E-mails avec QR code : envoyés en priorité par le relais SMTP Brevo (mêmes variables que la boutique :
 * SMTP_USER/SMTP_PASS ou BREVO_SMTP_LOGIN/BREVO_SMTP_KEY), l'image du QR étant intégrée au message
 * (Content-ID) : elle s'affiche même si l'appli mail bloque les images externes. Si le SMTP n'est pas
 * configuré ou échoue, envoi par l'API avec `htmlFallback` (image hébergée sur le site).
 */

const fs = require('fs');
const path = require('path');

function apiKey() {
  return String(process.env.BREVO_API_KEY || '').trim().replace(/^["']|["']$/g, '');
}

function isBrevoEnabled() {
  return apiKey().startsWith('xkeysib-');
}

function sender() {
  return {
    email: process.env.BREVO_SENDER_EMAIL || 'suzinabot@gmail.com',
    name: process.env.DINER_SENDER_NAME || 'Business Club · Boxing Center',
  };
}

function outboxDir() {
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, 'outbox');
  return process.env.VERCEL ? '/tmp/diner-outbox' : path.join(__dirname, '../../data/outbox');
}

function smtpConfig() {
  const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '');
  const user = clean(process.env.SMTP_USER || process.env.BREVO_SMTP_LOGIN);
  const pass = clean(process.env.SMTP_PASS || process.env.BREVO_SMTP_KEY);
  if (!user || !pass || /^coller/i.test(pass)) return null;
  return {
    host: clean(process.env.SMTP_HOST || process.env.BREVO_SMTP_HOST) || 'smtp-relay.brevo.com',
    port: Number(process.env.SMTP_PORT || process.env.BREVO_SMTP_PORT || 587),
    user,
    pass,
  };
}

function isSmtpEnabled() {
  return Boolean(smtpConfig());
}

/** Diagnostic sans secret : d'où viennent les réglages SMTP. */
function smtpInfo() {
  const cfg = smtpConfig();
  if (!cfg) return null;
  return {
    host: cfg.host, port: cfg.port,
    source: process.env.SMTP_USER ? 'SMTP_USER/SMTP_PASS' : 'BREVO_SMTP_LOGIN/BREVO_SMTP_KEY',
    user_domain: String(cfg.user).split('@')[1] || '(sans @)',
  };
}

let transporter = null;
function smtpTransport() {
  if (transporter) return transporter;
  const nodemailer = require('nodemailer');
  if (process.env.SMTP_STREAM_FOR_TESTS === '1') {
    transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
    return transporter;
  }
  const cfg = smtpConfig();
  transporter = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
  return transporter;
}

/** Message SMTP : pièces jointes classiques + images intégrées (cid). */
function smtpMessage({ to, subject, html, text, attachments = [], inline = [], cc = [] }) {
  const s = sender();
  return {
    from: { name: s.name, address: s.email },
    to,
    cc: cc.filter(Boolean),
    replyTo: { name: s.name, address: process.env.DINER_REPLY_TO || 'boxingcenter31@gmail.com' },
    subject,
    html,
    text: text || undefined,
    attachments: [
      ...inline.map((a) => ({ filename: a.name, content: Buffer.from(a.content, 'base64'), cid: a.cid, contentDisposition: 'inline', contentType: 'image/png' })),
      ...attachments.map((a) => ({ filename: a.name, content: Buffer.from(a.content, 'base64') })),
    ],
  };
}

async function sendEmail({ to, subject, html, text, attachments = [], cc = [], outboxOnly = false, inline = [], htmlFallback = null }) {
  if (!to) throw new Error('destinataire manquant');

  let smtpError = null;
  if (inline.length && !outboxOnly && isBrevoEnabled() && isSmtpEnabled()) {
    try {
      const info = await smtpTransport().sendMail(smtpMessage({ to, subject, html, text, attachments, inline, cc }));
      return { sent: true, via: 'brevo-smtp', messageId: info.messageId, raw: info.message };
    } catch (err) {
      console.error('smtp', err.message);
      smtpError = `${err.code || ''} ${err.responseCode || ''} ${String(err.message || '').slice(0, 160)}`.trim();
      if (!htmlFallback) throw err;
    }
  }
  if (inline.length) html = htmlFallback || html;

  if (outboxOnly || !isBrevoEnabled()) {
    const dir = outboxDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(dir, `${stamp}-${String(to).replace(/[^a-z0-9@._-]/gi, '_')}`);
    fs.writeFileSync(`${base}.html`, `<!-- To: ${to} | Subject: ${subject} -->\n${html}`);
    return { sent: false, via: 'outbox', file: `${base}.html` };
  }

  const body = {
    sender: sender(),
    to: [{ email: to }],
    replyTo: { email: process.env.DINER_REPLY_TO || 'boxingcenter31@gmail.com', name: sender().name },
    subject,
    htmlContent: html,
    textContent: text || undefined,
  };
  const ccList = cc.filter(Boolean);
  if (ccList.length) body.cc = ccList.map((email) => ({ email }));
  if (attachments.length) {
    body.attachment = attachments.map((a) => ({ name: a.name, content: a.content }));
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey(), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw.slice(0, 200) }; }
  if (!res.ok) throw new Error(data.message || `Brevo API HTTP ${res.status}`);
  return { sent: true, via: 'brevo-api', messageId: data.messageId, smtpError };
}

module.exports = { sendEmail, isBrevoEnabled, isSmtpEnabled, smtpInfo, outboxDir };
