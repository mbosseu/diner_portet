'use strict';

/**
 * PayPal — Orders API v2 (commande + capture), sur le modèle du module de la boutique Box Plus
 * (storefront/lib/paypal.js, compte PayPal de Portet).
 *
 * Trois modes, choisis pour chaque inscription (comme pour CAWL) :
 *  - live   : compte PayPal réel (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET), hôte selon PAYPAL_MODE
 *  - test   : sandbox PayPal avec les clés PAYPAL_TEST_* (Studio uniquement)
 *  - studio : simulateur PayPal intégré (server/studio) — aucun compte PayPal contacté
 */

const crypto = require('crypto');

const LIVE_HOST = 'https://api-m.paypal.com';
const SANDBOX_HOST = 'https://api-m.sandbox.paypal.com';
const STUDIO_CLIENT_ID = 'studio-paypal-client';

/** Valeur d'une variable, vide si elle contient encore un texte à remplacer (« COLLER_ICI »…). */
function envValue(name) {
  const v = String(process.env[name] || '').trim().replace(/^["']|["']$/g, '');
  return /^(coller|a_remplir|xxx|todo)/i.test(v) ? '' : v;
}

function studioSecret() {
  return crypto.createHash('sha256').update(`studio-paypal:${process.env.CRON_SECRET || process.env.ADMIN_TOKEN || 'local'}`).digest('hex');
}

/** Un vrai Client ID PayPal fait environ 80 caractères (contrôle repris de la boutique). */
function looksLikeClientId(id) {
  return String(id || '').length >= 60;
}

function liveConfigured() {
  return looksLikeClientId(envValue('PAYPAL_CLIENT_ID')) && Boolean(envValue('PAYPAL_CLIENT_SECRET'));
}

function testConfigured() {
  return looksLikeClientId(envValue('PAYPAL_TEST_CLIENT_ID')) && Boolean(envValue('PAYPAL_TEST_CLIENT_SECRET'));
}

function config(mode, origin) {
  if (mode === 'studio') {
    return {
      mode,
      base: `${String(origin).replace(/\/+$/, '')}/api/studio/paypal`,
      clientId: STUDIO_CLIENT_ID,
      secret: studioSecret(),
    };
  }
  if (mode === 'test') {
    return { mode, base: SANDBOX_HOST, clientId: envValue('PAYPAL_TEST_CLIENT_ID'), secret: envValue('PAYPAL_TEST_CLIENT_SECRET') };
  }
  const liveMode = envValue('PAYPAL_MODE').toLowerCase();
  return {
    mode: 'live',
    base: ['sandbox', 'test'].includes(liveMode) ? SANDBOX_HOST : LIVE_HOST,
    clientId: envValue('PAYPAL_CLIENT_ID'),
    secret: envValue('PAYPAL_CLIENT_SECRET'),
  };
}

const tokens = new Map();

async function accessToken(cfg) {
  if (!cfg.clientId || !cfg.secret) throw new Error('paypal_not_configured');
  const key = `${cfg.base}|${cfg.clientId}`;
  const cached = tokens.get(key);
  if (cached && Date.now() < cached.exp - 30_000) return cached.value;
  const res = await fetch(`${cfg.base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(body.error_description || body.error || `PayPal OAuth ${res.status}`);
  tokens.set(key, { value: body.access_token, exp: Date.now() + Number(body.expires_in || 300) * 1000 });
  return body.access_token;
}

async function paypalRequest(cfg, method, resourcePath, body = null, extraHeaders = {}) {
  const token = await accessToken(cfg);
  const res = await fetch(`${cfg.base}${resourcePath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok) {
    const err = new Error(data.details?.[0]?.description || data.message || `PayPal HTTP ${res.status}`);
    err.status = res.status;
    err.issue = data.details?.[0]?.issue || data.name || null;
    err.body = data;
    throw err;
  }
  return data;
}

function eurosFromCents(cents) {
  return (Number(cents) / 100).toFixed(2);
}

function centsFromValue(value) {
  const n = Math.round(Number(value) * 100);
  return value == null || !Number.isFinite(n) ? null : n;
}

/** Adresses de retour : succès et annulation reviennent sur la page d'inscription. */
function returnUrls(baseUrl, id, token) {
  const base = `${String(baseUrl).replace(/\/+$/, '')}/inscription.html?id=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}&pay_return=1`;
  return { returnUrl: base, cancelUrl: `${base}&cancelled=1` };
}

function buildOrder({ registration, amountCents, description, returnUrl, cancelUrl }) {
  const paypal = {
    experience_context: {
      brand_name: 'Boxing Center Portet',
      locale: 'fr-FR',
      landing_page: 'NO_PREFERENCE',
      user_action: 'PAY_NOW',
      shipping_preference: 'NO_SHIPPING',
      return_url: returnUrl,
      cancel_url: cancelUrl,
    },
  };
  if (registration.email) paypal.email_address = String(registration.email).slice(0, 254);
  // Comme la boutique : payment_source seul, jamais mélangé avec application_context.
  return {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: registration.id,
      custom_id: registration.id,
      invoice_id: registration.id,
      description: String(description).slice(0, 127),
      amount: { currency_code: 'EUR', value: eurosFromCents(amountCents) },
    }],
    payment_source: { paypal },
  };
}

function approveUrl(order) {
  const link = (order.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return link?.href || null;
}

async function createOrder(cfg, args) {
  const created = await paypalRequest(cfg, 'POST', '/v2/checkout/orders', buildOrder(args), {
    'PayPal-Request-Id': `create-${args.registration.id}`,
  });
  const redirectUrl = approveUrl(created);
  if (!created.id || !redirectUrl) throw new Error('paypal_no_approve_link');
  return { orderId: created.id, redirectUrl };
}

function getOrder(cfg, orderId) {
  return paypalRequest(cfg, 'GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

/** Capture idempotente : un second appel (double clic, webhook) renvoie la même capture. */
function captureOrder(cfg, orderId) {
  return paypalRequest(cfg, 'POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, {
    'PayPal-Request-Id': `capture-${orderId}`,
  });
}

function firstUnit(order) {
  return (order?.purchase_units || [])[0] || {};
}

function capture(order) {
  return (firstUnit(order).payments?.captures || [])[0] || null;
}

/** Lecture d'une commande : 'paid' | 'pending' | 'refused' | 'approved' | 'open' | 'cancelled'. */
function orderState(order) {
  const status = String(order?.status || '').toUpperCase();
  const c = capture(order);
  const cs = String(c?.status || '').toUpperCase();
  if (cs === 'COMPLETED') return 'paid';
  if (cs === 'PENDING') return 'pending';
  if (['DECLINED', 'FAILED'].includes(cs)) return 'refused';
  if (status === 'VOIDED') return 'cancelled';
  if (status === 'APPROVED') return 'approved';
  if (status === 'COMPLETED') return 'pending';
  return 'open';
}

function paidCents(order) {
  const c = capture(order);
  if (!c || String(c.amount?.currency_code || '').toUpperCase() !== 'EUR') return null;
  return centsFromValue(c.amount?.value);
}

function reference(order) {
  const unit = firstUnit(order);
  return String(capture(order)?.custom_id || unit.custom_id || unit.reference_id || '').trim();
}

function captureId(order) {
  return String(capture(order)?.id || '').trim();
}

module.exports = {
  config,
  liveConfigured,
  testConfigured,
  looksLikeClientId,
  studioSecret,
  STUDIO_CLIENT_ID,
  returnUrls,
  buildOrder,
  createOrder,
  getOrder,
  captureOrder,
  orderState,
  paidCents,
  reference,
  captureId,
  eurosFromCents,
  LIVE_HOST,
  SANDBOX_HOST,
};
