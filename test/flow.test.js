'use strict';

/**
 * Tests de bout en bout du parcours d'inscription, via le simulateur CAWL du Studio.
 * Aucun appel externe : ni banque, ni Brevo, ni Supabase. Données dans un dossier temporaire.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'diner-test-'));
Object.assign(process.env, {
  DATA_DIR: DATA,
  DISABLE_RATE_LIMIT: '1',
  MAX_PAID_SEATS: '50',
  NODE_ENV: 'test',
  PAYMENT_PROVIDER: 'cawl',
});
for (const k of ['CAWL_MERCHANT_ID', 'CAWL_API_KEY_ID', 'CAWL_API_SECRET', 'CAWL_TEST_MERCHANT_ID',
  'CAWL_TEST_API_KEY_ID', 'CAWL_TEST_API_SECRET', 'BREVO_API_KEY', 'DINER_SUPABASE_URL', 'DINER_SUPABASE_SERVICE_ROLE_KEY',
  'CRON_SECRET', 'ADMIN_TOKEN', 'STUDIO_PASSWORD', 'VERCEL', 'VERCEL_ENV', 'ORGANIZER_EMAIL',
  'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_TEST_CLIENT_ID', 'PAYPAL_TEST_CLIENT_SECRET', 'PAYPAL_MODE', 'PAYPAL_PORTET_CLIENT_ID', 'PAYPAL_PORTET_CLIENT_SECRET', 'PAYPAL_TEST_PORTET_CLIENT_ID', 'PAYPAL_TEST_PORTET_CLIENT_SECRET']) delete process.env[k];

const { createApp } = require('../server/app');
const cawl = require('../server/lib/cawl');

let server;
let BASE;
let studioCookie = '';

test.before(async () => {
  await new Promise((resolve) => {
    server = createApp().listen(0, '127.0.0.1', resolve);
  });
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
function person(overrides = {}) {
  n += 1;
  return {
    firstName: 'Camille', lastName: `Durand${n}`, email: `camille${n}@example.com`, phone: '06 12 34 56 78',
    company: 'Durand Conseil', role: 'Fondatrice', activity: 'Conseil en stratégie', sector: 'Immobilier',
    website: 'linkedin.com/in/test', looking: 'Des partenaires', offer: 'Du conseil', consent: true, ...overrides,
  };
}

async function post(p, body, headers = {}) {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Inscription + passage sur la page banque simulée avec une carte (ou annulation). */
async function registerAndPay(card, fields = person()) {
  const reg = await post('/api/register', fields);
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.mode, 'studio');
  assert.match(reg.body.redirectUrl, /\/studio\/pay\/HC-[a-f0-9]{16}$/);

  const page = await fetch(reg.body.redirectUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /STUDIO — SIMULATION/);

  const form = card === 'cancel'
    ? new URLSearchParams({ action: 'cancel' })
    : new URLSearchParams({ action: 'pay', card, exp: '12/29', cvc: '123' });
  const back = await fetch(reg.body.redirectUrl, { method: 'POST', body: form, redirect: 'manual' });
  assert.equal(back.status, 303);
  const loc = new URL(back.headers.get('location'));
  assert.equal(loc.pathname, '/inscription.html');
  assert.equal(loc.searchParams.get('id'), reg.body.id);
  assert.equal(loc.searchParams.get('cawl_return'), '1');
  assert.ok(loc.searchParams.get('hostedCheckoutId'));

  const confirm = await post(`/api/registrations/${reg.body.id}/confirm`, { t: reg.body.token });
  return { id: reg.body.id, token: reg.body.token, redirectUrl: reg.body.redirectUrl, confirm: confirm.body, fields };
}

function outbox() {
  const dir = path.join(DATA, 'outbox');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')) : [];
}

/* ---------- Validation ---------- */

test('formulaire incomplet : refusé avec la liste des champs', async () => {
  const r = await post('/api/register', { firstName: 'A', email: 'pas-un-email', phone: '12', sector: 'Inconnu' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_fields');
  for (const k of ['last_name', 'company', 'role', 'activity', 'looking', 'offer', 'email', 'phone', 'sector', 'consent']) {
    assert.ok(r.body.fields[k], `champ ${k} signalé`);
  }
});

test('consentement obligatoire', async () => {
  const r = await post('/api/register', person({ consent: false }));
  assert.equal(r.status, 400);
  assert.equal(r.body.fields.consent, 'required');
});

/* ---------- Scénarios de paiement ---------- */

test('carte acceptée : place confirmée, e-mail avec QR code, invitation consultable', async () => {
  const before = outbox().length;
  const r = await registerAndPay('4111111111111111');
  assert.equal(r.confirm.paid, true);
  assert.equal(r.confirm.registration.status, 'paid');
  assert.equal(r.confirm.registration.test, true);

  const mails = outbox().slice(before);
  assert.equal(mails.length, 1, 'un seul e-mail de confirmation');
  assert.match(mails[0], /Subject: Votre invitation/);
  assert.match(mails[0], new RegExp(r.id));
  assert.match(mails[0], /data:image\/png;base64,/);
  assert.match(mails[0], new RegExp(`Durand${n}`));

  const qr = await fetch(`${BASE}/api/registrations/${r.id}/qr.png?t=${r.token}`);
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${BASE}/api/registrations/${r.id}/qr.png?t=faux`)).status, 404);

  const ics = await fetch(`${BASE}/api/registrations/${r.id}/calendar.ics?t=${r.token}`);
  const icsText = await ics.text();
  assert.match(icsText, /DTSTART;TZID=Europe\/Paris:20261204T1130/);
  assert.ok(icsText.includes("LOCATION:Boxing Center\\, 61 route d'Espagne\\, 31120 Portet-sur-Garonne"), 'virgules de l’adresse échappées');
  assert.match(icsText, /TRIGGER:-P1D/);

  const view = await fetch(`${BASE}/api/registrations/${r.id}?t=${r.token}`).then((x) => x.json());
  assert.equal(view.registration.status, 'paid');
  assert.equal(view.registration.token, undefined, 'le jeton n’est jamais renvoyé');

  const again = await post(`/api/registrations/${r.id}/confirm`, { t: r.token });
  assert.equal(again.body.paid, true);
  assert.equal(outbox().length, before + 1, 'pas de second e-mail si on reconfirme');
});

test('carte refusée : inscription en échec, aucun e-mail, nouvel essai possible', async () => {
  const before = outbox().length;
  const fields = person();
  const r = await registerAndPay('4000000000000002', fields);
  assert.equal(r.confirm.paid, false);
  assert.equal(r.confirm.refused, true);
  assert.equal(r.confirm.registration.status, 'failed');
  assert.equal(outbox().length, before);

  const retry = await registerAndPay('4111111111111111', fields);
  assert.equal(retry.confirm.paid, true, 'même e-mail, nouvelle tentative réussie');
});

test('paiement annulé par le client', async () => {
  const r = await registerAndPay('cancel');
  assert.equal(r.confirm.paid, false);
  assert.equal(r.confirm.cancelled, true);
  assert.equal(r.confirm.registration.status, 'cancelled');
});

test('paiement en attente puis confirmé par le webhook de la banque', async () => {
  const before = outbox().length;
  const r = await registerAndPay('4000000000000259');
  assert.equal(r.confirm.paid, false);
  assert.equal(r.confirm.error, 'payment_not_completed');

  const checkoutId = r.redirectUrl.split('/').pop();
  const noCookie = await post(`/api/studio/checkouts/${checkoutId}/webhook`, {});
  assert.equal(noCookie.status, 404, 'outil Studio protégé');

  const wh = await post(`/api/studio/checkouts/${checkoutId}/webhook`, {}, { Cookie: studioCookie });
  assert.equal(wh.body.ok, true);
  assert.equal(wh.body.webhook.paid, true);

  const view = await fetch(`${BASE}/api/registrations/${r.id}?t=${r.token}`).then((x) => x.json());
  assert.equal(view.registration.status, 'paid');
  assert.equal(outbox().length, before + 1, 'e-mail envoyé une seule fois');

  await post(`/api/studio/checkouts/${checkoutId}/webhook`, {}, { Cookie: studioCookie });
  assert.equal(outbox().length, before + 1, 'webhook rejoué : toujours un seul e-mail');
});

test('montant falsifié : paiement bloqué et mis en vérification, aucune invitation', async () => {
  const before = outbox().length;
  const r = await registerAndPay('4000000000009995');
  assert.equal(r.confirm.paid, false);
  assert.equal(r.confirm.error, 'amount_mismatch');
  assert.equal(r.confirm.registration.status, 'review');
  assert.equal(outbox().length, before);
  assert.equal((await fetch(`${BASE}/api/registrations/${r.id}/qr.png?t=${r.token}`)).status, 404);
});

test('carte inconnue ou cryptogramme invalide : la banque simulée affiche une erreur', async () => {
  const reg = await post('/api/register', person());
  const bad = await fetch(reg.body.redirectUrl, { method: 'POST', body: new URLSearchParams({ action: 'pay', card: '1234123412341234', exp: '12/29', cvc: '123' }), redirect: 'manual' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Carte inconnue/);
  const badCvc = await fetch(reg.body.redirectUrl, { method: 'POST', body: new URLSearchParams({ action: 'pay', card: '4111111111111111', exp: '12/29', cvc: '1' }), redirect: 'manual' });
  assert.equal(badCvc.status, 400);
});

/* ---------- Règles métier ---------- */

test('une adresse déjà inscrite et payée ne peut pas payer deux fois', async () => {
  const fields = person();
  const r = await registerAndPay('4111111111111111', fields);
  assert.equal(r.confirm.paid, true);
  const dup = await post('/api/register', fields);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'already_registered');
});

test('jauge atteinte : plus d’inscription possible (et les tests n’occupent pas les vraies places)', async () => {
  await post('/api/studio/reset', {}, { Cookie: studioCookie });
  process.env.MAX_PAID_SEATS = '2';
  try {
    assert.equal((await post('/api/register', person())).status, 200);
    assert.equal((await post('/api/register', person())).status, 200);
    const full = await post('/api/register', person());
    assert.equal(full.status, 409);
    assert.equal(full.body.error, 'full');
    const publicSeats = await fetch(`${BASE}/api/availability`).then((x) => x.json());
    assert.equal(publicSeats.full, false, 'les inscriptions de test ne réduisent pas les places réelles');
    assert.equal(publicSeats.remaining, 2);
  } finally {
    process.env.MAX_PAID_SEATS = '50';
  }
});

/* ---------- Sécurité ---------- */

test('API CAWL simulée : signature HMAC invalide refusée', async () => {
  const bad = await fetch(`${BASE}/api/studio/cawl/v2/${cawl.STUDIO_MERCHANT}/hostedcheckouts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString(), Authorization: 'GCS v1HMAC:studio-key:faux' },
    body: '{}',
  });
  assert.equal(bad.status, 401);
  const get = await fetch(`${BASE}/api/studio/cawl/v2/${cawl.STUDIO_MERCHANT}/hostedcheckouts/HC-0000000000000000`, {
    headers: { Date: new Date().toUTCString(), Authorization: 'GCS v1HMAC:studio-key:faux' },
  });
  assert.equal(get.status, 401);
});

test('mauvais jeton : confirmation et consultation refusées', async () => {
  const reg = await post('/api/register', person());
  assert.equal((await post(`/api/registrations/${reg.body.id}/confirm`, { t: 'x'.repeat(48) })).status, 404);
  assert.equal((await fetch(`${BASE}/api/registrations/${reg.body.id}?t=nope`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/registrations/DP-INEXIST?t=nope`)).status, 404);
});

test('faux cookie Studio refusé', async () => {
  const r = await fetch(`${BASE}/api/studio/overview`, { headers: { Cookie: 'bc_studio=9999999999999.abcdef' } });
  assert.equal(r.status, 404);
});

test('webhook avec une référence inconnue : ignoré sans erreur', async () => {
  const r = await post('/api/webhooks/cawl', { payment: { paymentOutput: { references: { merchantReference: 'DP-ZZZZZZZZ' } } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ignored, true);
});

/* ---------- Rappel et organisateur ---------- */

test('rappel de la veille : ne part que le 3 décembre (cron), une seule fois par inscrit (Studio)', async () => {
  const cron = await fetch(`${BASE}/api/cron/reminder`).then((x) => x.json());
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  if (today !== '2026-12-03') {
    assert.equal(cron.skipped, true);
    assert.equal(cron.sends_on, '2026-12-03');
  }
  const paid = await registerAndPay('4111111111111111');
  assert.equal(paid.confirm.paid, true);
  const first = await post('/api/studio/reminders', {}, { Cookie: studioCookie });
  assert.ok(first.body.sent >= 1, 'au moins un rappel envoyé');
  assert.match(outbox().join('\n'), /Subject: Rappel/);
  const second = await post('/api/studio/reminders', {}, { Cookie: studioCookie });
  assert.equal(second.body.sent, 0, 'pas de doublon');
});

test('liste organisateur : les inscriptions de test n’y figurent jamais', async () => {
  const json = await fetch(`${BASE}/api/admin/registrations`).then((x) => x.json());
  assert.equal(json.paid, 0);
  const csv = await fetch(`${BASE}/api/admin/registrations?format=csv`).then((x) => x.text());
  assert.match(csv, /id;paid_at;first_name/);
});

test('Studio : tableau de bord, aperçu des e-mails, remise à zéro', async () => {
  await registerAndPay('4111111111111111');
  const ov = await fetch(`${BASE}/api/studio/overview`, { headers: { Cookie: studioCookie } }).then((x) => x.json());
  assert.ok(ov.registrations.length > 0);
  assert.ok(ov.checkouts.length > 0);
  assert.ok(ov.outbox.length > 0);
  const mail = await fetch(`${BASE}/api/studio/outbox/${encodeURIComponent(ov.outbox[0].file)}`, { headers: { Cookie: studioCookie } });
  assert.equal(mail.status, 200);
  const traversal = await fetch(`${BASE}/api/studio/outbox/..%2F..%2Fpackage.json`, { headers: { Cookie: studioCookie } });
  assert.equal(traversal.status, 404);
  const reset = await post('/api/studio/reset', {}, { Cookie: studioCookie });
  assert.ok(reset.body.removed > 0);
  const after = await fetch(`${BASE}/api/studio/overview`, { headers: { Cookie: studioCookie } }).then((x) => x.json());
  assert.equal(after.registrations.length, 0);
});

/* ---------- Production ---------- */

test('production sans clés : aucun paiement simulé, Studio fermé, cron protégé', async () => {
  process.env.NODE_ENV = 'production';
  try {
    const reg = await post('/api/register', person());
    assert.equal(reg.status, 503);
    assert.equal(reg.body.error, 'payment_not_configured');
    const state = await fetch(`${BASE}/api/studio/state`).then((x) => x.json());
    assert.equal(state.available, false);
    assert.equal((await post('/api/studio/unlock', {})).status, 404);
    assert.equal((await fetch(`${BASE}/api/cron/reminder`)).status, 401);
    assert.equal((await fetch(`${BASE}/api/admin/registrations`)).status, 401);
  } finally {
    process.env.NODE_ENV = 'test';
  }
});

test('production avec clés CAWL mais sans Supabase : inscriptions fermées (aucune perte de données)', async () => {
  process.env.NODE_ENV = 'production';
  Object.assign(process.env, { CAWL_MERCHANT_ID: 'M', CAWL_API_KEY_ID: 'K', CAWL_API_SECRET: 'S' });
  try {
    const reg = await post('/api/register', person());
    assert.equal(reg.status, 503);
    assert.equal(reg.body.error, 'payment_not_configured');
    const health = await fetch(`${BASE}/api/health`).then((x) => x.json());
    assert.equal(health.storage_ready, false);
  } finally {
    process.env.NODE_ENV = 'test';
    for (const k of ['CAWL_MERCHANT_ID', 'CAWL_API_KEY_ID', 'CAWL_API_SECRET']) delete process.env[k];
  }
});

test('production avec mot de passe Studio : accès seulement avec le bon mot de passe', async () => {
  process.env.NODE_ENV = 'production';
  process.env.STUDIO_PASSWORD = 'secret-studio-123';
  try {
    assert.equal((await post('/api/studio/unlock', { password: 'faux' })).status, 401);
    const ok = await fetch(`${BASE}/api/studio/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'secret-studio-123' }) });
    assert.equal(ok.status, 200);
    const cookie = (ok.headers.get('set-cookie') || '').split(';')[0];
    const reg = await post('/api/register', person(), { Cookie: cookie });
    assert.equal(reg.status, 200, 'en Studio, le paiement simulé reste possible');
    assert.equal(reg.body.mode, 'studio');
  } finally {
    process.env.NODE_ENV = 'test';
    delete process.env.STUDIO_PASSWORD;
  }
});

/* ---------- Rattrapage : payé puis page fermée avant le retour sur le site ---------- */

async function payWithoutReturn(card) {
  const reg = await post('/api/register', person());
  const form = card === 'cancel'
    ? new URLSearchParams({ action: 'cancel' })
    : new URLSearchParams({ action: 'pay', card, exp: '12/29', cvc: '123' });
  const back = await fetch(reg.body.redirectUrl, { method: 'POST', body: form, redirect: 'manual' });
  assert.equal(back.status, 303);
  return reg.body; // la page de retour n'est jamais ouverte : aucun /confirm
}

test('page fermée après paiement : la place est rattrapée et l’invitation envoyée', async () => {
  const { TEST_CARDS } = require('../server/studio');
  const card = Object.keys(TEST_CARDS).find((k) => TEST_CARDS[k].outcome === 'captured');
  process.env.RECONCILE_EVERY_MS = '600000';
  process.env.RECONCILE_MIN_AGE_MS = '0';
  try {
    const paid = await payWithoutReturn(card);
    const cancelled = await payWithoutReturn('cancel');
    const mailsBefore = outbox().length;

    // Prochain chargement de la page d'inscription par n'importe quel visiteur : rattrapage
    process.env.RECONCILE_EVERY_MS = '0';
    await fetch(`${BASE}/api/studio/state`);

    const r1 = await fetch(`${BASE}/api/registrations/${paid.id}?t=${encodeURIComponent(paid.token)}`).then((x) => x.json());
    const r2 = await fetch(`${BASE}/api/registrations/${cancelled.id}?t=${encodeURIComponent(cancelled.token)}`).then((x) => x.json());
    const s1 = r1.registration?.status ?? r1.status;
    const s2 = r2.registration?.status ?? r2.status;
    assert.equal(s1, 'paid', JSON.stringify(r1));
    assert.equal(s2, 'cancelled', JSON.stringify(r2));
    assert.ok(outbox().length > mailsBefore, 'invitation envoyée sans retour sur le site');
    assert.ok(outbox().some((m) => m.includes(paid.id)), 'e-mail de la bonne inscription');
  } finally {
    delete process.env.RECONCILE_EVERY_MS;
    delete process.env.RECONCILE_MIN_AGE_MS;
  }
});

test('rattrapage : rien à faire tant que l’acheteur est encore sur la page de paiement', async () => {
  process.env.RECONCILE_EVERY_MS = '0';
  process.env.RECONCILE_MIN_AGE_MS = '0';
  try {
    const reg = await post('/api/register', person()); // page banque ouverte, rien payé
    await fetch(`${BASE}/api/studio/state`);
    const r = await fetch(`${BASE}/api/registrations/${reg.body.id}?t=${encodeURIComponent(reg.body.token)}`).then((x) => x.json());
    assert.equal(r.registration?.status ?? r.status, 'pending');
  } finally {
    delete process.env.RECONCILE_EVERY_MS;
    delete process.env.RECONCILE_MIN_AGE_MS;
  }
});
