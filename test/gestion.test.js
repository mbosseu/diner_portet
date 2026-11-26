'use strict';

/**
 * Back-office /gestion : connexion, liste des inscrits, contrôle d'entrée par QR code.
 * Vérifie qu'un QR ne peut être ni inventé, ni modifié, ni réutilisé, ni pris d'une inscription de test ou non payée.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'diner-gestion-'));
Object.assign(process.env, {
  DATA_DIR: DATA, DISABLE_RATE_LIMIT: '1', NODE_ENV: 'test', PAYMENT_PROVIDER: 'cawl',
  ADMIN_TOKEN: 'mot-de-passe-gestion-test', CRON_SECRET: 'secret-de-signature-test',
});
for (const k of ['CAWL_MERCHANT_ID', 'CAWL_API_KEY_ID', 'CAWL_API_SECRET', 'CAWL_TEST_MERCHANT_ID', 'CAWL_TEST_API_KEY_ID',
  'CAWL_TEST_API_SECRET', 'BREVO_API_KEY', 'DINER_SUPABASE_URL', 'DINER_SUPABASE_SERVICE_ROLE_KEY', 'STUDIO_PASSWORD',
  'VERCEL', 'VERCEL_ENV', 'ORGANIZER_EMAIL']) delete process.env[k];

const { createApp, qrPayload, sendReminders } = require('../server/app');
const store = require('../server/lib/store');

let server; let BASE; let cookie = '';

test.before(async () => {
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve); });
  BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_URL = BASE;
});
test.after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

async function call(method, p, body, withCookie = true) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(withCookie && cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* CSV */ }
  return { status: r.status, body: json, text, headers: r.headers };
}

let n = 0;
async function seed(over = {}) {
  n += 1;
  const reg = {
    id: `DP-TEST${String(n).padStart(4, '0')}`, token: `tok${n}`, status: 'paid', pay_mode: 'live', provider: 'cawl',
    first_name: 'Camille', last_name: `Durand${n}`, email: `camille${n}@example.com`, phone: '06 12 34 56 78',
    company: 'Durand Conseil', role: 'Fondatrice', activity: 'Conseil', sector: 'Immobilier', looking: 'Clients', offer: 'Réseau',
    amount_cents: 1000, created_at: new Date().toISOString(), paid_at: new Date().toISOString(), ...over,
  };
  await store.save(reg);
  return reg;
}

test('accès protégé : sans connexion, rien n’est lisible', async () => {
  assert.equal((await call('GET', '/api/gestion/overview', null, false)).status, 401);
  assert.equal((await call('POST', '/api/gestion/checkin', { id: 'DP-XXXXXX' }, false)).status, 401);
  assert.equal((await call('GET', '/api/gestion/export.csv', null, false)).status, 401);
  assert.equal((await call('POST', '/api/gestion/login', { password: 'faux' }, false)).status, 401);
  const forged = await fetch(`${BASE}/api/gestion/overview`, { headers: { cookie: `bc_gestion=${Date.now() + 1e7}.abc` } });
  assert.equal(forged.status, 401, 'cookie fabriqué à la main');
});

test('connexion avec le mot de passe, cookie HttpOnly', async () => {
  const r = await call('POST', '/api/gestion/login', { password: 'mot-de-passe-gestion-test' }, false);
  assert.equal(r.status, 200);
  const set = r.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(';')[0];
  assert.equal((await call('GET', '/api/gestion/state')).body.authed, true);
});

test('liste : noms, e-mails, téléphones, statut ; jamais le jeton de l’invitation', async () => {
  const reg = await seed();
  const r = await call('GET', '/api/gestion/overview');
  assert.equal(r.status, 200);
  const row = r.body.registrations.find((x) => x.id === reg.id);
  assert.equal(row.email, reg.email);
  assert.equal(row.phone, reg.phone);
  assert.equal(row.status, 'paid');
  assert.equal(row.token, undefined);
  assert.ok(r.body.stats.paid >= 1);
});

test('QR valide : entrée validée une fois, puis « déjà entré » (pas de réutilisation)', async () => {
  const reg = await seed();
  const first = await call('POST', '/api/gestion/checkin', { qr: qrPayload(reg) });
  assert.equal(first.body.result, 'ok', JSON.stringify(first.body));
  assert.match(first.body.message, /Bienvenue Camille/);
  const second = await call('POST', '/api/gestion/checkin', { qr: qrPayload(reg) });
  assert.equal(second.body.result, 'already');
  assert.ok(second.body.message.includes(`${reg.last_name} : déjà entré(e) à`), second.body.message);
  const third = await call('POST', '/api/gestion/checkin', { id: reg.id });
  assert.equal(third.body.result, 'already', 'même refus en saisie manuelle');
});

test('QR falsifié : signature inventée, référence modifiée, autre format', async () => {
  const reg = await seed();
  const good = qrPayload(reg);
  const sig = good.split('|')[2];
  const other = sig.endsWith('a') ? 'b' : 'a';
  const cases = [
    `BCDINER|${reg.id}|000000000000`,
    `BCDINER|${reg.id}|${sig.slice(0, -1)}${other}`,
    `BCDINER|DP-TEST9999|${sig}`,
    `BCDINER|${reg.id}`,
    'https://exemple.fr/billet',
    'nimporte quoi',
  ];
  for (const qr of cases) {
    const r = await call('POST', '/api/gestion/checkin', { qr });
    assert.equal(r.body.result, 'refused', qr);
  }
  assert.ok(!(await store.load(reg.id)).checked_in_at, 'aucune entrée enregistrée');
});

test('QR d’une inscription de test ou non payée : refusé', async () => {
  const testReg = await seed({ pay_mode: 'test' });
  const r1 = await call('POST', '/api/gestion/checkin', { qr: qrPayload(testReg) });
  assert.equal(r1.body.result, 'refused');
  assert.equal(r1.body.reason, 'test');
  const ok = await call('POST', '/api/gestion/checkin', { qr: qrPayload(testReg), allowTest: true });
  assert.equal(ok.body.result, 'ok', 'accepté seulement en mode répétition');

  for (const status of ['pending', 'cancelled', 'failed']) {
    const reg = await seed({ status, paid_at: null });
    const r = await call('POST', '/api/gestion/checkin', { qr: qrPayload(reg) });
    assert.equal(r.body.result, 'refused', status);
    assert.equal(r.body.reason, 'unpaid', status);
  }
});

test('invitations partenaires : 10 codes, une seule entrée chacun', async () => {
  const a = await call('POST', '/api/gestion/checkin', { code: 'BC-PART-03' });
  assert.equal(a.body.result, 'ok');
  const b = await call('POST', '/api/gestion/checkin', { code: 'bc part 3' });
  assert.equal(b.body.result, 'already');
  assert.equal((await call('POST', '/api/gestion/checkin', { code: 'BC-PART-11' })).body.result, 'refused');
  const stats = (await call('GET', '/api/gestion/overview')).body.stats;
  assert.equal(stats.partners_present, 1);
  assert.equal(stats.partners_total, 10);
});

test('annuler une arrivée, export CSV avec e-mails et téléphones', async () => {
  const reg = await seed();
  await call('POST', '/api/gestion/checkin', { id: reg.id });
  const undo = await call('POST', '/api/gestion/checkin/undo', { id: reg.id });
  assert.equal(undo.body.registration.checked_in_at, null);
  assert.equal((await call('POST', '/api/gestion/checkin', { id: reg.id })).body.result, 'ok');
  const csv = await call('GET', '/api/gestion/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Téléphone/);
  assert.ok(csv.text.includes(reg.email));
  assert.ok(!/tok\d/.test(csv.text), 'pas de jeton dans l’export');
});

test('renvoi de l’invitation', async () => {
  const reg = await seed({ pay_mode: 'test' });
  const r = await call('POST', '/api/gestion/resend', { id: reg.id });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.via, 'outbox');
});

test('trop d’essais de mot de passe : blocage temporaire', async () => {
  let last;
  for (let i = 0; i < 10; i += 1) last = await call('POST', '/api/gestion/login', { password: `faux${i}` }, false);
  assert.equal(last.status, 429);
});

test('rappels : envoi limité dans le temps, le reste est repris au passage suivant', async () => {
  for (let i = 0; i < 6; i += 1) await seed();
  const none = await sendReminders('live', { budgetMs: 0 });
  assert.equal(none.sent.length, 0);
  assert.ok(none.remaining >= 6, 'temps écoulé : rien envoyé, tout reste à faire');
  const all = await sendReminders('live');
  assert.equal(all.remaining, 0);
  assert.ok(all.sent.length >= 6);
  assert.equal((await sendReminders('live')).sent.length, 0, 'jamais deux fois');
});

test('cron du rappel : protégé, trois passages, pas de doublon', async () => {
  for (const p of ['/api/cron/reminder', '/api/cron/reminder-retry', '/api/cron/reminder-last']) {
    assert.equal((await fetch(`${BASE}${p}`)).status, 401, p);
  }
  const auth = { authorization: 'Bearer secret-de-signature-test' };
  const day = await fetch(`${BASE}/api/cron/reminder-retry`, { headers: auth }).then((r) => r.json());
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  if (today !== '2026-12-03') assert.equal(day.skipped, true);
  const reg = await seed();
  const forced = await fetch(`${BASE}/api/cron/reminder-last?force=1`, { headers: auth }).then((r) => r.json());
  assert.ok(forced.sent >= 1, JSON.stringify(forced));
  assert.ok((await store.load(reg.id)).reminder_sent_at);
  const again = await fetch(`${BASE}/api/cron/reminder?force=1`, { headers: auth }).then((r) => r.json());
  assert.equal(again.sent, 0);
});

test('back-office : suivi des rappels, bouton de secours refusé avant la veille', async () => {
  const ov = (await call('GET', '/api/gestion/overview')).body;
  assert.equal(typeof ov.stats.reminders_sent, 'number');
  assert.equal(ov.reminders.sends_on, '2026-12-03');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  if (today < '2026-12-03') {
    const r = await call('POST', '/api/gestion/reminders', {});
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'too_early');
  }
  assert.equal((await call('POST', '/api/gestion/reminders', {}, false)).status, 401);
});
