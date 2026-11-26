'use strict';

/**
 * Parcours d'inscription payé par PayPal, via le simulateur PayPal du Studio.
 * Aucun appel externe. Le simulateur reproduit OAuth, création, lecture et capture de commande (Orders v2).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'diner-paypal-'));
for (const k of ['CAWL_MERCHANT_ID', 'CAWL_API_KEY_ID', 'CAWL_API_SECRET', 'CAWL_TEST_MERCHANT_ID',
  'CAWL_TEST_API_KEY_ID', 'CAWL_TEST_API_SECRET', 'BREVO_API_KEY', 'DINER_SUPABASE_URL', 'DINER_SUPABASE_SERVICE_ROLE_KEY',
  'CRON_SECRET', 'ADMIN_TOKEN', 'STUDIO_PASSWORD', 'VERCEL', 'VERCEL_ENV', 'ORGANIZER_EMAIL', 'PAYMENT_PROVIDER',
  'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_TEST_CLIENT_ID', 'PAYPAL_TEST_CLIENT_SECRET', 'PAYPAL_MODE', 'PAYPAL_PORTET_CLIENT_ID', 'PAYPAL_PORTET_CLIENT_SECRET', 'PAYPAL_TEST_PORTET_CLIENT_ID', 'PAYPAL_TEST_PORTET_CLIENT_SECRET']) delete process.env[k];
Object.assign(process.env, { DATA_DIR: DATA, DISABLE_RATE_LIMIT: '1', MAX_PAID_SEATS: '50', NODE_ENV: 'test' });

const { createApp } = require('../server/app');
const paypal = require('../server/lib/paypal');

let server;
let BASE;
let studioCookie = '';

test.before(async () => {
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve); });
  BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_URL = BASE;
  const r = await fetch(`${BASE}/api/studio/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  studioCookie = (r.headers.get('set-cookie') || '').split(';')[0];
});

test.after(() => {
  server.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

let n = 0;
function person() {
  n += 1;
  return {
    firstName: 'Léa', lastName: `Martin${n}`, email: `lea${n}@example.com`, phone: '06 98 76 54 32',
    company: 'Martin & Co', role: 'Gérante', activity: 'Agence immobilière', sector: 'Immobilier',
    website: '', looking: 'Des apporteurs d’affaires', offer: 'Mon réseau local', consent: true,
  };
}

async function post(p, body, headers = {}) {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

function outbox() {
  const dir = path.join(DATA, 'outbox');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')) : [];
}

/** Inscription, page PayPal simulée (compte de test ou annulation), retour sur le site puis confirmation. */
async function registerAndPay(account, fields = person()) {
  const reg = await post('/api/register', fields);
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.provider, 'paypal');
  assert.equal(reg.body.mode, 'studio');
  assert.match(reg.body.redirectUrl, /\/studio\/paypal\/S[0-9A-F]{16}$/);

  const page = await fetch(reg.body.redirectUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /PayPal · Paiement[\s\S]*STUDIO — SIMULATION/);

  const form = account === 'cancel' ? new URLSearchParams({ action: 'cancel' }) : new URLSearchParams({ action: 'pay', email: account });
  const back = await fetch(reg.body.redirectUrl, { method: 'POST', body: form, redirect: 'manual' });
  assert.equal(back.status, 303);
  const loc = new URL(back.headers.get('location'));
  assert.equal(loc.pathname, '/inscription.html');
  assert.equal(loc.searchParams.get('id'), reg.body.id);
  assert.equal(loc.searchParams.get('pay_return'), '1');
  assert.ok(loc.searchParams.get('token'), 'PayPal ajoute le numéro de commande');
  const cancelled = loc.searchParams.get('cancelled') === '1';
  assert.equal(cancelled, account === 'cancel');

  const confirm = await post(`/api/registrations/${reg.body.id}/confirm`, { t: reg.body.token, cancelled });
  return { id: reg.body.id, token: reg.body.token, orderId: loc.searchParams.get('token'), confirm: confirm.body };
}

test('santé : PayPal est le prestataire par défaut quand CAWL n’est pas configuré', async () => {
  const h = await fetch(`${BASE}/api/health`).then((x) => x.json());
  assert.equal(h.provider, 'paypal');
  assert.equal(h.paypal.live, false);
  assert.equal(h.paypal.host, paypal.LIVE_HOST);
  const s = await fetch(`${BASE}/api/studio/state`, { headers: { Cookie: studioCookie } }).then((x) => x.json());
  assert.equal(s.target, 'paypal-simulator');
});

test('PayPal accepté : capture, place confirmée, un seul e-mail avec QR code', async () => {
  const before = outbox().length;
  const r = await registerAndPay('acheteur.accepte@studio.test');
  assert.equal(r.confirm.paid, true, JSON.stringify(r.confirm));
  assert.equal(r.confirm.registration.status, 'paid');
  const mails = outbox().slice(before);
  assert.equal(mails.length, 1);
  assert.match(mails[0], /Subject: Votre invitation/);
  assert.match(mails[0], new RegExp(r.id));

  const again = await post(`/api/registrations/${r.id}/confirm`, { t: r.token });
  assert.equal(again.body.paid, true);
  assert.equal(outbox().length, before + 1, 'pas de seconde capture ni de second e-mail');
  assert.equal((await fetch(`${BASE}/api/registrations/${r.id}/qr.png?t=${r.token}`)).status, 200);
});

test('PayPal refusé à la capture : échec, aucun e-mail, nouvel essai possible', async () => {
  const before = outbox().length;
  const fields = person();
  const r = await registerAndPay('acheteur.refuse@studio.test', fields);
  assert.equal(r.confirm.paid, false);
  assert.equal(r.confirm.refused, true);
  assert.equal(r.confirm.registration.status, 'failed');
  assert.equal(outbox().length, before);
  const retry = await registerAndPay('acheteur.accepte@studio.test', fields);
  assert.equal(retry.confirm.paid, true);
});

test('PayPal annulé par l’acheteur', async () => {
  const r = await registerAndPay('cancel');
  assert.equal(r.confirm.paid, false);
  assert.equal(r.confirm.cancelled, true);
  assert.equal(r.confirm.registration.status, 'cancelled');
});

test('PayPal en attente puis confirmé par le webhook PayPal', async () => {
  const before = outbox().length;
  const r = await registerAndPay('acheteur.attente@studio.test');
  assert.equal(r.confirm.paid, false);
  assert.equal(r.confirm.error, 'payment_not_completed');

  const wh = await post(`/api/studio/checkouts/${r.orderId}/webhook`, {}, { Cookie: studioCookie });
  assert.equal(wh.body.ok, true);
  assert.equal(wh.body.webhook.paid, true);
  const view = await fetch(`${BASE}/api/registrations/${r.id}?t=${r.token}`).then((x) => x.json());
  assert.equal(view.registration.status, 'paid');
  assert.equal(outbox().length, before + 1);
  await post(`/api/studio/checkouts/${r.orderId}/webhook`, {}, { Cookie: studioCookie });
  assert.equal(outbox().length, before + 1, 'webhook rejoué : un seul e-mail');
});

test('acheteur qui ferme l’onglet après avoir approuvé : le webhook capture et confirme', async () => {
  const reg = await post('/api/register', person());
  await fetch(reg.body.redirectUrl, { method: 'POST', body: new URLSearchParams({ action: 'pay', email: 'acheteur.accepte@studio.test' }), redirect: 'manual' });
  const orderId = reg.body.redirectUrl.split('/').pop();
  const wh = await post('/api/webhooks/paypal', { event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: orderId } });
  assert.equal(wh.body.paid, true);
});

test('PayPal montant falsifié : mis en vérification, aucune invitation', async () => {
  const before = outbox().length;
  const r = await registerAndPay('acheteur.fraude@studio.test');
  assert.equal(r.confirm.paid, false);
  assert.equal(r.confirm.error, 'amount_mismatch');
  assert.equal(r.confirm.registration.status, 'review');
  assert.equal(outbox().length, before);
});

test('retour sans approbation (pas de paiement) : rien n’est confirmé', async () => {
  const reg = await post('/api/register', person());
  const c = await post(`/api/registrations/${reg.body.id}/confirm`, { t: reg.body.token });
  assert.equal(c.body.paid, false);
  assert.equal(c.body.error, 'payment_not_completed');
  assert.equal(c.body.registration.status, 'pending');
});

test('API PayPal simulée : identifiants ou jeton invalides refusés', async () => {
  const badAuth = await fetch(`${BASE}/api/studio/paypal/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from('x:y').toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  assert.equal(badAuth.status, 401);
  const badToken = await fetch(`${BASE}/api/studio/paypal/v2/checkout/orders`, {
    method: 'POST', headers: { Authorization: 'Bearer faux', 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(badToken.status, 401);
});

test('compte PayPal inconnu sur la page simulée : erreur affichée', async () => {
  const reg = await post('/api/register', person());
  const bad = await fetch(reg.body.redirectUrl, { method: 'POST', body: new URLSearchParams({ action: 'pay', email: 'inconnu@example.com' }), redirect: 'manual' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Compte inconnu/);
});

test('webhook PayPal inconnu : ignoré sans erreur', async () => {
  const r = await post('/api/webhooks/paypal', { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { custom_id: 'DP-ZZZZZZZZ' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ignored, true);
});

test('variables PayPal à remplir oubliées : non configuré, inscriptions fermées en production', async () => {
  process.env.NODE_ENV = 'production';
  Object.assign(process.env, {
    PAYPAL_CLIENT_ID: 'COLLER_ICI', PAYPAL_CLIENT_SECRET: 'COLLER_ICI',
    DINER_SUPABASE_URL: 'COLLER_ICI', DINER_SUPABASE_SERVICE_ROLE_KEY: 'COLLER_ICI',
  });
  try {
    const h = await fetch(`${BASE}/api/health`).then((x) => x.json());
    assert.equal(h.paypal.live, false);
    assert.equal(h.storage, 'local-files');
    assert.equal(h.payment_mode, null);
    assert.equal((await post('/api/register', person())).status, 503);
  } finally {
    process.env.NODE_ENV = 'test';
    for (const k of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'DINER_SUPABASE_URL', 'DINER_SUPABASE_SERVICE_ROLE_KEY']) delete process.env[k];
  }
});

test('commande PayPal : montant, référence et retours corrects', () => {
  const body = paypal.buildOrder({
    registration: { id: 'DP-ABCDEFGH', email: 'a@b.fr' },
    amountCents: 1000,
    description: 'Dîner',
    ...paypal.returnUrls('https://dinerportet.vercel.app', 'DP-ABCDEFGH', 'tok'),
  });
  assert.equal(body.intent, 'CAPTURE');
  assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'EUR', value: '10.00' });
  assert.equal(body.purchase_units[0].custom_id, 'DP-ABCDEFGH');
  assert.equal(body.payment_source.paypal.experience_context.return_url,
    'https://dinerportet.vercel.app/inscription.html?id=DP-ABCDEFGH&t=tok&pay_return=1');
  assert.match(body.payment_source.paypal.experience_context.cancel_url, /&cancelled=1$/);
  assert.equal(body.application_context, undefined, 'jamais mélangé avec payment_source');
  assert.equal(paypal.orderState({ status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ status: 'COMPLETED' }] } }] }), 'paid');
  assert.equal(paypal.orderState({ status: 'APPROVED' }), 'approved');
  assert.equal(paypal.orderState({ status: 'PAYER_ACTION_REQUIRED' }), 'open');
});

test('variables copiées de Box Plus : compte PayPal de Portet, jamais la base ni la carte de la boutique', () => {
  const saved = { ...process.env };
  const id = (c) => c.repeat(80);
  Object.assign(process.env, {
    PAYPAL_CLIENT_ID: id('M'), PAYPAL_CLIENT_SECRET: 'minimes',
    PAYPAL_PORTET_CLIENT_ID: id('P'), PAYPAL_PORTET_CLIENT_SECRET: 'portet',
    PAYPAL_TEST_CLIENT_ID: id('m'), PAYPAL_TEST_CLIENT_SECRET: 'minimes-test',
    PAYPAL_TEST_PORTET_CLIENT_ID: id('p'), PAYPAL_TEST_PORTET_CLIENT_SECRET: 'portet-test',
    CAWL_MERCHANT_ID: 'm', CAWL_API_KEY_ID: 'k', CAWL_API_SECRET: 's',
    SUPABASE_URL: 'https://boutique.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(60),
  });
  try {
    const live = paypal.config('live');
    assert.equal(live.clientId, id('P'));
    assert.equal(live.secret, 'portet');
    assert.equal(paypal.liveAccount(), 'portet');
    assert.equal(paypal.config('test').clientId, id('p'));
    assert.equal(require('../server/lib/payments').provider(), 'paypal');
    assert.equal(require('../server/lib/store').supabaseConfigured(), false);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
});
