'use strict';

const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');

const { EVENT, publicUrl, maxPaidSeats, isProduction } = require('./lib/config');
const cawl = require('./lib/cawl');
const paypal = require('./lib/paypal');
const payments = require('./lib/payments');
const { sendEmail, isBrevoEnabled } = require('./lib/brevo');
const store = require('./lib/store');
const { confirmationEmail, reminderEmail, organizerEmail, invitationLinks } = require('./lib/emails');
const studio = require('./studio');

/* ---------- Utilitaires ---------- */

function newId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[bytes[i] % chars.length];
  return `DP-${out}`;
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function secret() {
  return process.env.CRON_SECRET || process.env.ADMIN_TOKEN || 'dev-secret-local';
}

/** Les inscriptions de test (studio / préproduction) ne comptent jamais comme de vraies places. */
function isLive(reg) {
  return !reg.pay_mode || reg.pay_mode === 'live';
}

/** Contenu du QR code : référence + signature, vérifiable à l'entrée. */
function qrPayload(reg) {
  const sig = crypto.createHmac('sha256', secret()).update(reg.id).digest('hex').slice(0, 12);
  return `BCDINER|${reg.id}|${sig}`;
}

function clean(v, max = 200) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const SECTORS = new Set([
  'Artisanat & BTP', 'Commerce & distribution', 'Restauration & hôtellerie',
  'Conseil & services aux entreprises', 'Finance, banque & assurance', 'Immobilier',
  'Numérique & tech', 'Communication & marketing', 'Santé, sport & bien-être',
  'Industrie & logistique', 'Juridique & comptabilité', 'Autre',
]);

function validate(body) {
  const f = {
    first_name: clean(body.firstName, 60),
    last_name: clean(body.lastName, 60),
    email: clean(body.email, 120).toLowerCase(),
    phone: clean(body.phone, 30),
    company: clean(body.company, 120),
    role: clean(body.role, 80),
    activity: clean(body.activity, 160),
    sector: clean(body.sector, 60),
    website: clean(body.website, 200),
    looking: String(body.looking ?? '').trim().slice(0, 600),
    offer: String(body.offer ?? '').trim().slice(0, 600),
    consent: body.consent === true || body.consent === 'on' || body.consent === 'true',
  };
  const errors = {};
  for (const k of ['first_name', 'last_name', 'company', 'role', 'activity', 'looking', 'offer']) {
    if (!f[k]) errors[k] = 'required';
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email)) errors.email = 'invalid';
  if (f.phone.replace(/\D/g, '').length < 9) errors.phone = 'invalid';
  if (!SECTORS.has(f.sector)) errors.sector = 'invalid';
  if (f.website) {
    const url = /^https?:\/\//i.test(f.website) ? f.website : `https://${f.website}`;
    try { new URL(url); f.website = url; } catch { errors.website = 'invalid'; }
  }
  if (!f.consent) errors.consent = 'required';
  return { fields: f, errors };
}

/** Limite simple : 8 tentatives d'inscription par adresse IP et par 10 minutes. */
const hits = new Map();
function rateLimited(ip) {
  if (process.env.DISABLE_RATE_LIMIT === '1') return false;
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 8;
}

function publicView(reg) {
  return {
    id: reg.id,
    status: reg.status,
    first_name: reg.first_name,
    last_name: reg.last_name,
    company: reg.company,
    role: reg.role,
    email: reg.email,
    amount_cents: reg.amount_cents,
    paid_at: reg.paid_at || null,
    test: !isLive(reg),
  };
}

async function qrBuffer(reg) {
  return QRCode.toBuffer(qrPayload(reg), {
    type: 'png', width: 360, margin: 1, errorCorrectionLevel: 'M',
    color: { dark: '#0b0b0a', light: '#eae5da' },
  });
}

/** Les e-mails des inscriptions de test restent dans la boîte d'envoi locale (sauf choix contraire). */
function outboxOnlyFor(reg) {
  return !isLive(reg) && process.env.STUDIO_SEND_REAL_EMAILS !== '1';
}

/** Source de l'image du QR dans l'e-mail : URL publique (Brevo) ou image intégrée (boîte d'envoi). */
async function qrSrcForEmail(reg) {
  if (isBrevoEnabled() && !outboxOnlyFor(reg)) return invitationLinks(reg).qr;
  return `data:image/png;base64,${(await qrBuffer(reg)).toString('base64')}`;
}

/** En production, les inscriptions doivent être enregistrées dans Supabase (le disque de Vercel est temporaire). */
function storageReady() {
  return !isProduction() || store.supabaseConfigured();
}

/** Mode de paiement d'une nouvelle inscription. */
function paymentModeFor(req) {
  const lib = payments.lib();
  if (studio.isStudio(req)) return lib.testConfigured() ? 'test' : 'studio';
  if (!storageReady()) return null;
  if (lib.liveConfigured()) return 'live';
  if (!isProduction()) return 'studio'; // poste local sans clés : simulateur
  return null;
}

/* ---------- Confirmation d'un paiement ---------- */

async function finalizePaid(reg, payment) {
  if (reg.status !== 'paid') {
    reg.status = 'paid';
    reg.paid_at = new Date().toISOString();
    reg.payment = payment;
    await store.save(reg);
  }
  const fresh = (await store.load(reg.id)) || reg;
  if (!fresh.confirmation_sent_at) {
    const outboxOnly = outboxOnlyFor(fresh);
    try {
      const mail = confirmationEmail(fresh, { qrSrc: await qrSrcForEmail(fresh) });
      const qr = await qrBuffer(fresh);
      const result = await sendEmail({
        to: fresh.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        attachments: [{ name: `invitation-${fresh.id}.png`, content: qr.toString('base64') }],
        outboxOnly,
      });
      fresh.confirmation_sent_at = new Date().toISOString();
      fresh.confirmation_via = result.via;
      fresh.confirmation_error = null;
    } catch (err) {
      fresh.confirmation_error = err.message;
    }
    if (process.env.ORGANIZER_EMAIL) {
      try {
        const o = organizerEmail(fresh);
        await sendEmail({ to: process.env.ORGANIZER_EMAIL, subject: o.subject, html: o.html, text: o.text, outboxOnly });
      } catch { /* la copie organisateur ne bloque jamais l'inscription */ }
    }
    await store.save(fresh);
  }
  return fresh;
}

/** Vérifie auprès de CAWL que le paiement est encaissé, au bon montant, pour la bonne inscription. */
async function confirmWithCawl(reg) {
  if (reg.status === 'paid') return { paid: true, reg };
  if (!reg.cawl_hosted_checkout_id) return { paid: false, error: 'no_checkout' };
  const cfg = cawl.config(reg.pay_mode || 'live', publicUrl());
  const session = await cawl.getHostedCheckout(cfg, reg.cawl_hosted_checkout_id);
  if (cawl.isCawlCancelled(session)) {
    reg.status = 'cancelled';
    await store.save(reg);
    return { paid: false, cancelled: true, reg };
  }
  if (cawl.isCawlRejected(session)) {
    reg.status = 'failed';
    await store.save(reg);
    return { paid: false, refused: true, reg };
  }
  if (!cawl.isCawlPaid(session)) return { paid: false, error: 'payment_not_completed', reg };
  const ref = cawl.cawlMerchantReference(session);
  const cents = cawl.cawlPaidCents(session);
  if (ref !== reg.id || cents !== reg.amount_cents) {
    reg.status = 'review';
    reg.review_reason = ref !== reg.id ? 'reference_mismatch' : 'amount_mismatch';
    reg.review_detail = { reference: ref, amount_cents: cents };
    await store.save(reg);
    return { paid: false, error: reg.review_reason, reg };
  }
  const done = await finalizePaid(reg, {
    method: 'cawl',
    mode: cfg.mode,
    hosted_checkout_id: reg.cawl_hosted_checkout_id,
    payment_id: cawl.cawlPaymentId(session) || null,
    amount_cents: cents,
  });
  return { paid: true, reg: done };
}

/** Refus côté PayPal au moment de la capture (moyen de paiement refusé). */
const PAYPAL_REFUSALS = new Set([
  'INSTRUMENT_DECLINED', 'TRANSACTION_REFUSED', 'PAYER_CANNOT_PAY', 'PAYEE_BLOCKED_TRANSACTION',
  'COMPLIANCE_VIOLATION', 'MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED',
]);

/**
 * Vérifie auprès de PayPal : capture la commande approuvée par l'acheteur, puis contrôle
 * statut, montant et référence avant de confirmer la place.
 */
async function confirmWithPaypal(reg, { cancelled = false } = {}) {
  if (reg.status === 'paid') return { paid: true, reg };
  if (!reg.paypal_order_id) return { paid: false, error: 'no_checkout' };
  const cfg = paypal.config(reg.pay_mode || 'live', publicUrl());
  let order = await paypal.getOrder(cfg, reg.paypal_order_id);
  let state = paypal.orderState(order);
  if (state === 'approved') {
    try {
      order = await paypal.captureOrder(cfg, reg.paypal_order_id);
    } catch (err) {
      if (err.issue === 'ORDER_ALREADY_CAPTURED') order = await paypal.getOrder(cfg, reg.paypal_order_id);
      else if (PAYPAL_REFUSALS.has(err.issue)) order = { status: 'APPROVED', purchase_units: [{ payments: { captures: [{ status: 'DECLINED' }] } }] };
      else throw err;
    }
    state = paypal.orderState(order);
  }
  if (state === 'refused') {
    reg.status = 'failed';
    await store.save(reg);
    return { paid: false, refused: true, reg };
  }
  if (state === 'cancelled' || (state === 'open' && cancelled)) {
    reg.status = 'cancelled';
    await store.save(reg);
    return { paid: false, cancelled: true, reg };
  }
  if (state !== 'paid') return { paid: false, error: 'payment_not_completed', reg };
  const ref = paypal.reference(order);
  const cents = paypal.paidCents(order);
  if (ref !== reg.id || cents !== reg.amount_cents) {
    reg.status = 'review';
    reg.review_reason = ref !== reg.id ? 'reference_mismatch' : 'amount_mismatch';
    reg.review_detail = { reference: ref, amount_cents: cents };
    await store.save(reg);
    return { paid: false, error: reg.review_reason, reg };
  }
  const done = await finalizePaid(reg, {
    method: 'paypal',
    mode: cfg.mode,
    order_id: reg.paypal_order_id,
    capture_id: paypal.captureId(order) || null,
    amount_cents: cents,
  });
  return { paid: true, reg: done };
}

function confirmPayment(reg, opts) {
  return reg.provider === 'paypal' ? confirmWithPaypal(reg, opts) : confirmWithCawl(reg);
}

/** Rappel de la veille. `scope` : 'live' (vrais inscrits) ou 'test' (studio). */
async function sendReminders(scope) {
  const sent = [];
  const failed = [];
  for (const reg of await store.listAll()) {
    if (reg.status !== 'paid' || reg.reminder_sent_at) continue;
    if ((scope === 'live') !== isLive(reg)) continue;
    try {
      const mail = reminderEmail(reg, { qrSrc: await qrSrcForEmail(reg) });
      await sendEmail({ to: reg.email, subject: mail.subject, html: mail.html, text: mail.text, outboxOnly: outboxOnlyFor(reg) });
      reg.reminder_sent_at = new Date().toISOString();
      await store.save(reg);
      sent.push(reg.id);
    } catch (err) {
      failed.push({ id: reg.id, error: err.message });
    }
  }
  return { sent, failed };
}

function eveOfEventISO() {
  const eve = new Date(`${EVENT.dateISO}T12:00:00Z`);
  eve.setUTCDate(eve.getUTCDate() - 1);
  return eve.toISOString().slice(0, 10);
}

/* ---------- Application ---------- */

function createApp() {
  const app = express();
  /* Express 4 ne rattrape pas les erreurs des routes async : sans ça, une erreur (base injoignable…)
     laisse la requête sans réponse jusqu'au délai maximal de Vercel. */
  for (const method of ['get', 'post']) {
    const original = app[method].bind(app);
    app[method] = (route, ...handlers) => (handlers.length === 0 ? original(route)
      : original(route, ...handlers.map((h) => (typeof h === 'function' && h.length < 4
        ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next) : h))));
  }
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '50kb' }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      payment_mode: paymentModeFor(req),
      provider: payments.provider(),
      paypal: { live: paypal.liveConfigured(), test: paypal.testConfigured(), account: paypal.liveAccount(), host: paypal.config('live').base },
      cawl: { live: cawl.liveConfigured(), test: cawl.testConfigured() },
      brevo: isBrevoEnabled(),
      storage: store.supabaseConfigured() ? 'supabase' : 'local-files',
      storage_ready: storageReady(),
      studio: studio.isStudio(req),
      seats: { max: maxPaidSeats() },
    });
  });

  /* Places restantes (affichage public) */
  app.get('/api/availability', async (_req, res) => {
    const taken = await store.seatsTaken(isLive);
    res.json({ ok: true, remaining: Math.max(0, maxPaidSeats() - taken), full: taken >= maxPaidSeats() });
  });

  /* 1. Inscription + création du paiement */
  app.post('/api/register', async (req, res) => {
    try {
      if (rateLimited(req.ip)) return res.status(429).json({ ok: false, error: 'too_many_attempts' });
      const { fields, errors } = validate(req.body || {});
      if (Object.keys(errors).length) return res.status(400).json({ ok: false, error: 'invalid_fields', fields: errors });

      const mode = paymentModeFor(req);
      if (!mode) return res.status(503).json({ ok: false, error: 'payment_not_configured' });
      const live = mode === 'live';
      const sameGroup = (r) => isLive(r) === live;

      if (await store.findPaidByEmail(fields.email, sameGroup)) {
        return res.status(409).json({ ok: false, error: 'already_registered' });
      }
      if ((await store.seatsTaken(sameGroup)) >= maxPaidSeats()) {
        return res.status(409).json({ ok: false, error: 'full' });
      }

      const reg = {
        id: newId(),
        token: newToken(),
        status: 'pending',
        created_at: new Date().toISOString(),
        amount_cents: EVENT.priceCents,
        pay_mode: mode,
        provider: payments.provider(),
        ...fields,
      };
      await store.save(reg);

      let redirectUrl;
      if (reg.provider === 'paypal') {
        const order = await paypal.createOrder(paypal.config(mode, publicUrl()), {
          registration: reg,
          amountCents: reg.amount_cents,
          description: 'Dîner Business Club · 4 décembre 2026 · Boxing Center Portet',
          ...paypal.returnUrls(publicUrl(), reg.id, reg.token),
        });
        reg.paypal_order_id = order.orderId;
        redirectUrl = order.redirectUrl;
      } else {
        const checkout = await cawl.createHostedCheckout(cawl.config(mode, publicUrl()), {
          registration: reg,
          amountCents: reg.amount_cents,
          description: 'Diner Business Club 04/12',
          returnUrl: cawl.buildReturnUrl(publicUrl(), reg.id, reg.token),
        });
        reg.cawl_hosted_checkout_id = checkout.hostedCheckoutId;
        redirectUrl = checkout.redirectUrl;
      }
      await store.save(reg);
      res.json({ ok: true, id: reg.id, token: reg.token, mode, provider: reg.provider, redirectUrl });
    } catch (err) {
      console.error('register', err.message);
      res.status(502).json({ ok: false, error: 'payment_unavailable' });
    }
  });

  /* 2. Retour du paiement : confirmation côté serveur */
  app.post('/api/registrations/:id/confirm', async (req, res) => {
    try {
      const reg = await store.load(req.params.id);
      if (!reg || !sameToken(reg.token, req.body?.t)) return res.status(404).json({ ok: false, error: 'not_found' });
      const result = await confirmPayment(reg, { cancelled: req.body?.cancelled === true });
      res.json({
        ok: true,
        paid: result.paid,
        cancelled: Boolean(result.cancelled),
        refused: Boolean(result.refused),
        error: result.error || null,
        registration: publicView(result.reg || reg),
      });
    } catch (err) {
      console.error('confirm', err.message);
      res.status(502).json({ ok: false, error: 'confirmation_failed' });
    }
  });

  /* Consultation de l'invitation (lien de l'e-mail) */
  app.get('/api/registrations/:id', async (req, res) => {
    const reg = await store.load(req.params.id);
    if (!reg || !sameToken(reg.token, req.query.t)) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, registration: publicView(reg) });
  });

  app.get('/api/registrations/:id/qr.png', async (req, res) => {
    const reg = await store.load(req.params.id);
    if (!reg || reg.status !== 'paid' || !sameToken(reg.token, req.query.t)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400').type('png').send(await qrBuffer(reg));
  });

  app.get('/api/registrations/:id/calendar.ics', async (req, res) => {
    const reg = await store.load(req.params.id);
    if (!reg || !sameToken(reg.token, req.query.t)) return res.status(404).end();
    const d = EVENT.dateISO.replace(/-/g, '');
    const t = (s) => s.replace(':', '') + '00';
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Boxing Center//Business Club//FR', 'BEGIN:VEVENT',
      `UID:${reg.id}@businessclub`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
      `DTSTART;TZID=Europe/Paris:${d}T${t(EVENT.startTime)}`,
      `DTEND;TZID=Europe/Paris:${d}T${t(EVENT.endTime)}`,
      `SUMMARY:${EVENT.name}`,
      `LOCATION:${EVENT.venue}\\, ${EVENT.address}`,
      `DESCRIPTION:Initiation boxe\\, dîner et networking. Invitation ${reg.id}`,
      'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', 'DESCRIPTION:Business Club demain', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    res.set('Content-Disposition', 'attachment; filename="business-club-4-decembre.ics"')
      .type('text/calendar; charset=utf-8').send(ics);
  });

  /* Webhook CAWL : même principe que la boutique — on revérifie toujours auprès de CAWL */
  app.get('/api/webhooks/cawl', (_req, res) => {
    res.json({ ok: true, endpoint: 'cawl', method: 'POST', configured: cawl.liveConfigured() });
  });
  app.post('/api/webhooks/cawl', async (req, res) => {
    try {
      const body = req.body || {};
      const payment = body.payment || body;
      const ref = String(payment?.paymentOutput?.references?.merchantReference || body.merchantReference || '').trim();
      const hostedId = String(body.hostedCheckoutId || payment?.hostedCheckoutSpecificOutput?.hostedCheckoutId || '').trim();
      let reg = ref.startsWith('DP-') ? await store.load(ref) : null;
      if (!reg && hostedId) {
        reg = (await store.listAll()).find((r) => r.cawl_hosted_checkout_id === hostedId) || null;
      }
      if (!reg || reg.provider === 'paypal') return res.json({ ok: true, ignored: true });
      const result = await confirmWithCawl(reg);
      res.json({ ok: true, id: reg.id, paid: result.paid });
    } catch (err) {
      console.error('webhook cawl', err.message);
      res.status(500).json({ ok: false });
    }
  });

  /* Webhook PayPal : l'événement sert seulement de signal, tout est revérifié auprès de PayPal */
  app.get('/api/webhooks/paypal', (_req, res) => {
    res.json({ ok: true, endpoint: 'paypal', method: 'POST', configured: paypal.liveConfigured() });
  });
  app.post('/api/webhooks/paypal', async (req, res) => {
    try {
      const body = req.body || {};
      const r = body.resource || {};
      const ref = String(r.custom_id || r.invoice_id || r.purchase_units?.[0]?.custom_id || '').trim();
      const orderId = String(r.supplementary_data?.related_ids?.order_id
        || (String(body.event_type || '').startsWith('CHECKOUT.ORDER') ? r.id : '') || '').trim();
      let reg = ref.startsWith('DP-') ? await store.load(ref) : null;
      if (!reg && orderId) reg = (await store.listAll()).find((x) => x.paypal_order_id === orderId) || null;
      if (!reg || reg.provider !== 'paypal') return res.json({ ok: true, ignored: true });
      const result = await confirmWithPaypal(reg);
      res.json({ ok: true, id: reg.id, paid: result.paid });
    } catch (err) {
      console.error('webhook paypal', err.message);
      res.status(500).json({ ok: false });
    }
  });

  /* Rappel de la veille — appelé chaque jour par le cron Vercel, n'envoie que le 3 décembre */
  app.get('/api/cron/reminder', async (req, res) => {
    const auth = String(req.headers.authorization || '');
    const ok = Boolean(process.env.CRON_SECRET) && auth === `Bearer ${process.env.CRON_SECRET}`;
    const devOk = !isProduction() && !process.env.CRON_SECRET;
    if (!ok && !devOk) return res.status(401).json({ ok: false });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: EVENT.timezone }).format(new Date());
    const sendsOn = eveOfEventISO();
    if (today !== sendsOn && req.query.force !== '1') return res.json({ ok: true, skipped: true, today, sends_on: sendsOn });
    const result = await sendReminders('live');
    res.json({ ok: true, sent: result.sent.length, failed: result.failed });
  });

  /* Liste des inscrits pour l'organisateur (JSON ou CSV) — vraies inscriptions uniquement */
  app.get('/api/admin/registrations', async (req, res) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.query.token || '');
    const devOk = !isProduction() && !process.env.ADMIN_TOKEN;
    if (!devOk && !sameToken(process.env.ADMIN_TOKEN, token)) return res.status(401).json({ ok: false });
    const all = (await store.listAll()).filter(isLive);
    const paid = all.filter((r) => r.status === 'paid');
    if (req.query.format === 'csv') {
      const cols = ['id', 'paid_at', 'first_name', 'last_name', 'email', 'phone', 'company', 'role', 'activity', 'sector', 'website', 'looking', 'offer'];
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [cols.join(';'), ...paid.map((r) => cols.map((c) => q(r[c])).join(';'))].join('\r\n');
      return res.set('Content-Disposition', 'attachment; filename="inscrits-business-club.csv"')
        .type('text/csv; charset=utf-8').send('﻿' + csv);
    }
    res.json({
      ok: true,
      paid: paid.length,
      max: maxPaidSeats(),
      pending: all.filter((r) => r.status === 'pending').length,
      review: all.filter((r) => r.status === 'review').map(({ token, ...r }) => r),
      registrations: paid.map(({ token, ...r }) => r),
    });
  });

  studio.mount(app, { store, sendReminders, isLive, publicView });

  app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));
  app.use('/api', (err, _req, res, _next) => {
    console.error('api', err.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'server_error' });
  });

  return app;
}

module.exports = { createApp, qrPayload, validate };
