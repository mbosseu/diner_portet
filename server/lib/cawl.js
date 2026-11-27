'use strict';

/**
 * CAWL ecommerce (Worldline Direct) — Hosted Checkout, carte en une fois.
 * Repris du module de la boutique Box Plus (storefront/lib/cawl.js), simplifié :
 * même authentification GCS v1HMAC, mêmes endpoints, mêmes contrôles de paiement.
 *
 * Trois modes, choisis pour chaque inscription :
 *  - live   : compte CAWL réel (CAWL_MERCHANT_ID…), hôte selon CAWL_MODE (live | test)
 *  - test   : préproduction CAWL avec les clés CAWL_TEST_* (comme le studio Box Plus)
 *  - studio : simulateur CAWL intégré (server/studio) — aucune banque contactée
 */

const crypto = require('crypto');

const RETURN_URL_MAX_LEN = 200; // limite observée par la boutique sur returnUrl
const LIVE_HOST = 'https://payment.cawl-solutions.fr';
const PREPROD_HOST = 'https://payment.preprod.cawl-solutions.fr';

const STUDIO_MERCHANT = 'STUDIO-PORTET';
const STUDIO_KEY_ID = 'studio-key';
function studioSecret() {
  return crypto.createHash('sha256').update(`studio:${process.env.CRON_SECRET || process.env.ADMIN_TOKEN || 'local'}`).digest('hex');
}

function liveConfigured() {
  return Boolean(process.env.CAWL_MERCHANT_ID && process.env.CAWL_API_KEY_ID && process.env.CAWL_API_SECRET);
}

function testConfigured() {
  return Boolean(process.env.CAWL_TEST_MERCHANT_ID && process.env.CAWL_TEST_API_KEY_ID && process.env.CAWL_TEST_API_SECRET);
}

/** Configuration d'appel pour un mode donné. `origin` sert au simulateur studio. */
function config(mode, origin) {
  if (mode === 'studio') {
    return {
      mode,
      base: `${String(origin).replace(/\/+$/, '')}/api/studio/cawl`,
      merchantId: STUDIO_MERCHANT,
      apiKeyId: STUDIO_KEY_ID,
      apiSecret: studioSecret(),
    };
  }
  if (mode === 'test') {
    return {
      mode,
      base: PREPROD_HOST,
      merchantId: String(process.env.CAWL_TEST_MERCHANT_ID || '').trim(),
      apiKeyId: String(process.env.CAWL_TEST_API_KEY_ID || '').trim(),
      apiSecret: String(process.env.CAWL_TEST_API_SECRET || '').trim(),
    };
  }
  const liveMode = String(process.env.CAWL_MODE || 'live').toLowerCase();
  return {
    mode: 'live',
    base: ['test', 'preprod', 'sandbox'].includes(liveMode) ? PREPROD_HOST : LIVE_HOST,
    merchantId: String(process.env.CAWL_MERCHANT_ID || '').trim(),
    apiKeyId: String(process.env.CAWL_API_KEY_ID || '').trim(),
    apiSecret: String(process.env.CAWL_API_SECRET || '').trim(),
  };
}

function authorizationHeader(method, contentType, date, resourcePath, apiKeyId, apiSecret) {
  const subject = `${method}\n${contentType}\n${date}\n${resourcePath}\n`;
  const signature = crypto.createHmac('sha256', apiSecret).update(subject, 'utf8').digest('base64');
  return `GCS v1HMAC:${apiKeyId}:${signature}`;
}

async function cawlRequest(cfg, method, resourcePath, body = null) {
  if (!cfg.merchantId || !cfg.apiKeyId || !cfg.apiSecret) throw new Error('cawl_not_configured');
  const date = new Date().toUTCString();
  const hasBody = body != null && method !== 'GET';
  const contentType = hasBody ? 'application/json' : '';
  const headers = {
    Date: date,
    Accept: 'application/json',
    Authorization: authorizationHeader(method, contentType, date, resourcePath, cfg.apiKeyId, cfg.apiSecret),
  };
  if (hasBody) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${cfg.base}${resourcePath}`, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok) {
    const err = new Error(data.errors?.[0]?.message || data.message || `CAWL HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function phoneE164(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^0\d{9}$/.test(digits)) return `+33${digits.slice(1)}`;
  if (/^33\d{9}$/.test(digits)) return `+${digits}`;
  return undefined;
}

/** URL de retour courte (≤ 200 caractères). */
function buildReturnUrl(baseUrl, id, token) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const full = `${base}/inscription?id=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}&cawl_return=1`;
  if (full.length <= RETURN_URL_MAX_LEN) return full;
  return `${base}/inscription?id=${encodeURIComponent(id)}&cawl_return=1`;
}

function buildPayload({ registration, amountCents, description, returnUrl }) {
  const phone = phoneE164(registration.phone);
  const contactDetails = { emailAddress: String(registration.email).slice(0, 70) };
  if (phone) contactDetails.phoneNumber = phone;
  return {
    order: {
      amountOfMoney: { currencyCode: 'EUR', amount: amountCents },
      customer: {
        personalInformation: {
          name: {
            firstName: String(registration.first_name).slice(0, 50),
            surname: String(registration.last_name).slice(0, 50),
          },
        },
        billingAddress: { countryCode: 'FR' },
        contactDetails,
        locale: 'fr_FR',
      },
      references: { merchantReference: registration.id.slice(0, 30) },
      shoppingCart: {
        items: [{
          amountOfMoney: { currencyCode: 'EUR', amount: amountCents },
          invoiceData: { description: description.slice(0, 50) },
          orderLineDetails: {
            productName: description.slice(0, 50),
            productCode: 'DINER-BC',
            productPrice: amountCents,
            quantity: 1,
            lineAmountTotal: amountCents,
          },
        }],
      },
    },
    hostedCheckoutSpecificInput: {
      returnUrl,
      locale: 'fr_FR',
      showResultPage: false,
      cardPaymentMethodSpecificInput: { groupCards: true, authorizationMode: 'SALE' },
    },
  };
}

async function createHostedCheckout(cfg, args) {
  const created = await cawlRequest(cfg, 'POST', `/v2/${cfg.merchantId}/hostedcheckouts`, buildPayload(args));
  const redirectUrl = created.redirectUrl
    || (created.partialRedirectUrl ? `https://${created.partialRedirectUrl.replace(/^https?:\/\//, '')}` : null);
  return { hostedCheckoutId: created.hostedCheckoutId, redirectUrl };
}

async function getHostedCheckout(cfg, hostedCheckoutId) {
  return cawlRequest(cfg, 'GET', `/v2/${cfg.merchantId}/hostedcheckouts/${encodeURIComponent(hostedCheckoutId)}`);
}

function hostedPayment(session) {
  return session?.createdPaymentOutput?.payment || null;
}

function isCawlPaid(session) {
  const category = String(session?.createdPaymentOutput?.paymentStatusCategory || '').toUpperCase();
  if (category === 'SUCCESSFUL') return true;
  const status = String(hostedPayment(session)?.status || '').toUpperCase();
  if (['CAPTURED', 'PAID'].includes(status)) return true;
  const code = Number(hostedPayment(session)?.statusOutput?.statusCode || 0);
  return code === 9 || code === 5;
}

function isCawlCancelled(session) {
  const status = String(session?.status || '').toUpperCase();
  return status === 'CANCELLED_BY_CONSUMER' || status === 'CANCELLED';
}

function isCawlRejected(session) {
  const category = String(session?.createdPaymentOutput?.paymentStatusCategory || '').toUpperCase();
  const status = String(hostedPayment(session)?.status || '').toUpperCase();
  return category === 'REJECTED' || status === 'REJECTED';
}

function cawlPaidCents(session) {
  const raw = hostedPayment(session)?.paymentOutput?.amountOfMoney?.amount;
  const n = Number(raw);
  return raw == null || !Number.isFinite(n) ? null : n;
}

function cawlMerchantReference(session) {
  return String(hostedPayment(session)?.paymentOutput?.references?.merchantReference || '').trim();
}

function cawlPaymentId(session) {
  return String(hostedPayment(session)?.id || '').trim();
}

module.exports = {
  config,
  liveConfigured,
  testConfigured,
  studioSecret,
  STUDIO_MERCHANT,
  STUDIO_KEY_ID,
  authorizationHeader,
  buildReturnUrl,
  buildPayload,
  createHostedCheckout,
  getHostedCheckout,
  isCawlPaid,
  isCawlCancelled,
  isCawlRejected,
  cawlPaidCents,
  cawlMerchantReference,
  cawlPaymentId,
  phoneE164,
  LIVE_HOST,
  PREPROD_HOST,
};
