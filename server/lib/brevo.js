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

/** Jeux d'identifiants SMTP possibles, dans l'ordre d'essai : DINER_SMTP_* (propres au dîner), BREVO_SMTP_*, SMTP_*. */
function smtpConfigs() {
  const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '');
  const list = [
    { source: 'DINER_SMTP_LOGIN/DINER_SMTP_KEY', user: process.env.DINER_SMTP_LOGIN, pass: process.env.DINER_SMTP_KEY },
    { source: 'BREVO_SMTP_LOGIN/BREVO_SMTP_KEY', user: process.env.BREVO_SMTP_LOGIN, pass: process.env.BREVO_SMTP_KEY, host: process.env.BREVO_SMTP_HOST, port: process.env.BREVO_SMTP_PORT },
    { source: 'SMTP_USER/SMTP_PASS', user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, host: process.env.SMTP_HOST, port: process.env.SMTP_PORT },
  ].map((c) => ({
    source: c.source, user: clean(c.user), pass: clean(c.pass),
    host: clean(c.host) || 'smtp-relay.brevo.com', port: Number(c.port || 587),
  })).filter((c) => c.user && c.pass && !/^coller/i.test(c.pass));
  return list.filter((c, i) => list.findIndex((o) => o.user === c.user && o.pass === c.pass && o.host === c.host) === i);
}

let workingIndex = 0;
function smtpConfig() {
  const list = smtpConfigs();
  return list[workingIndex] || list[0] || null;
}

function isSmtpEnabled() {
  return Boolean(smtpConfig());
}

/** Diagnostic sans secret : d'où viennent les réglages SMTP. */
function smtpInfo() {
  const cfg = smtpConfig();
  if (!cfg) return null;
  return { host: cfg.host, port: cfg.port, source: cfg.source, user_domain: String(cfg.user).split('@')[1] || '(sans @)' };
}

const transporters = new Map();
function smtpTransport(cfg = smtpConfig()) {
  const nodemailer = require('nodemailer');
  if (process.env.SMTP_STREAM_FOR_TESTS === '1') return nodemailer.createTransport({ streamTransport: true, buffer: true });
  if (!transporters.has(cfg.source)) {
    transporters.set(cfg.source, nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    }));
  }
  return transporters.get(cfg.source);
}

/** Envoi SMTP : essaie chaque jeu d'identifiants ; retient celui qui fonctionne. */
async function sendSmtp(message) {
  const list = smtpConfigs();
  let lastErr = null;
  for (let k = 0; k < list.length; k += 1) {
    const i = (workingIndex + k) % list.length;
    try {
      const info = await smtpTransport(list[i]).sendMail(message);
      workingIndex = i;
      return info;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EAUTH') break; // autre erreur : inutile d'essayer d'autres identifiants
    }
  }
  throw lastErr;
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
      const info = await sendSmtp(smtpMessage({ to, subject, html, text, attachments, inline, cc }));
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

/** Vérifie la connexion et l'identification SMTP, sans rien envoyer. */
async function verifySmtp() {
  const list = smtpConfigs();
  if (!list.length) return { ok: false, error: 'smtp_not_configured' };
  const tried = [];
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    try {
      await smtpTransport(c).verify();
      workingIndex = i;
      tried.push({ source: c.source, host: c.host, ok: true });
      return { ok: true, using: c.source, tried };
    } catch (err) {
      tried.push({ source: c.source, host: c.host, ok: false, error: `${err.code || ''} ${err.responseCode || ''}`.trim() });
    }
  }
  return { ok: false, tried };
}

module.exports = { sendEmail, isBrevoEnabled, isSmtpEnabled, smtpInfo, verifySmtp, outboxDir };
