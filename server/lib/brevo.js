'use strict';

/**
 * Envoi d'e-mails par l'API REST Brevo — même appel que la boutique Box Plus
 * (storefront/lib/brevo-send.js : POST https://api.brevo.com/v3/smtp/email).
 * Sans clé API (développement) : l'e-mail est écrit dans data/outbox pour être relu.
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

async function sendEmail({ to, subject, html, text, attachments = [], cc = [], outboxOnly = false }) {
  if (!to) throw new Error('destinataire manquant');

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
  return { sent: true, via: 'brevo-api', messageId: data.messageId };
}

module.exports = { sendEmail, isBrevoEnabled, outboxDir };
