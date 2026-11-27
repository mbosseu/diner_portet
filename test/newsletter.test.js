'use strict';

/**
 * Newsletter du back-office : listes Brevo, ajout de contacts, essai, envoi d'une campagne.
 * Brevo est simulé (aucun appel réel) ; les appels vers l'application passent normalement.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'diner-newsletter-'));
Object.assign(process.env, {
  DATA_DIR: DATA, DISABLE_RATE_LIMIT: '1', NODE_ENV: 'test', PAYMENT_PROVIDER: 'cawl',
  ADMIN_TOKEN: 'mot-de-passe-newsletter', CRON_SECRET: 'secret-newsletter',
  BREVO_API_KEY: 'xkeysib-test-newsletter', BREVO_SENDER_EMAIL: 'contact@example.com',
  BREVO_API_BASE: 'https://brevo.simule/v3',
});
for (const k of ['DINER_SUPABASE_URL', 'DINER_SUPABASE_SERVICE_ROLE_KEY', 'STUDIO_PASSWORD', 'VERCEL', 'VERCEL_ENV',
  'BREVO_SMTP_LOGIN', 'BREVO_SMTP_KEY', 'SMTP_USER', 'SMTP_PASS', 'DINER_SMTP_LOGIN', 'DINER_SMTP_KEY']) delete process.env[k];

/* ---------- Brevo simulé ---------- */
const calls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://brevo.simule/') && !u.startsWith('https://api.brevo.com/')) return realFetch(url, opts);
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, url: u, body });
  const json = (status, data) => new Response(data === null ? null : JSON.stringify(data), { status });
  const p = u.replace(/^https:\/\/[^/]+\/v3/, '');
  if (p.startsWith('/smtp/email')) return json(201, { messageId: '<essai@brevo>' });
  if (method === 'GET' && p.startsWith('/contacts/lists')) {
    return json(200, { lists: [{ id: 3, name: 'Adhérents', uniqueSubscribers: 120 }, { id: 7, name: 'Business Club', uniqueSubscribers: 4 }] });
  }
  if (method === 'GET' && p.startsWith('/contacts/folders')) return json(200, { folders: [{ id: 1, name: 'Mes contacts' }] });
  if (method === 'POST' && p === '/contacts/lists') return json(201, { id: 12 });
  if (method === 'POST' && p === '/contacts') {
    if (body.attributes && 'PRENOM' in body.attributes) return json(400, { code: 'invalid_parameter', message: 'Attribute PRENOM does not exist' });
    if (body.email === 'refuse@example.com') return json(400, { code: 'invalid_parameter', message: 'Contact refused' });
    return body.email === 'deja@example.com' ? json(204, null) : json(201, { id: 99 });
  }
  if (method === 'GET' && p.startsWith('/emailCampaigns')) {
    return json(200, { campaigns: [
      { id: 50, name: 'Business Club · Newsletter · 26/11/2026', subject: 'Annonce', status: 'sent', sentDate: '2026-11-26T09:00:00Z', statistics: { globalStats: { sent: 120, uniqueViews: 61, uniqueClicks: 18 } } },
      { id: 40, name: 'Box Plus · Soldes', subject: 'Soldes', status: 'sent' },
    ] });
  }
  if (method === 'POST' && p === '/emailCampaigns') return json(201, { id: 55 });
  if (method === 'POST' && p === '/emailCampaigns/55/sendNow') return json(204, null);
  return json(404, { message: `non simulé : ${method} ${p}` });
};

const { createApp } = require('../server/app');

let server; let BASE; let cookie = '';
test.before(async () => {
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve); });
  BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_URL = BASE;
  const r = await realFetch(`${BASE}/api/gestion/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'mot-de-passe-newsletter' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(() => { server.close(); global.fetch = realFetch; fs.rmSync(DATA, { recursive: true, force: true }); });

async function call(method, p, body, withCookie = true) {
  const r = await realFetch(`${BASE}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(withCookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

test('protégé : rien sans connexion', async () => {
  assert.equal((await call('GET', '/api/gestion/newsletter', null, false)).status, 401);
  assert.equal((await call('POST', '/api/gestion/newsletter/send', { listIds: [3], subject: 'x' }, false)).status, 401);
  assert.equal((await call('POST', '/api/gestion/newsletter/contacts', { listId: 3, lines: 'a@b.fr' }, false)).status, 401);
});

test('listes Brevo et campagnes du Business Club seulement', async () => {
  const r = await call('GET', '/api/gestion/newsletter');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.lists.map((l) => [l.id, l.name, l.count]), [[3, 'Adhérents', 120], [7, 'Business Club', 4]]);
  assert.equal(r.body.campaigns.length, 1, 'les campagnes de la boutique ne sont pas montrées');
  assert.equal(r.body.campaigns[0].opens, 61);
  assert.match(r.body.subject, /Business Club/);
});

test('créer une liste', async () => {
  const r = await call('POST', '/api/gestion/newsletter/lists', { name: 'Business Club 2026' });
  assert.equal(r.body.list.id, 12);
  const created = calls.find((c) => c.method === 'POST' && c.url.endsWith('/contacts/lists'));
  assert.deepEqual(created.body, { name: 'Business Club 2026', folderId: 1 });
});

test('ajouter des contacts : formats acceptés, lignes invalides signalées, désinscription respectée', async () => {
  const lines = [
    'marie.dupont@example.com, marie, DUPONT',
    'Paul Martin <paul@example.com>',
    'deja@example.com',
    'pas une adresse',
    'refuse@example.com',
  ].join('\n');
  const r = await call('POST', '/api/gestion/newsletter/contacts', { listId: 7, lines });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, 2);
  assert.equal(r.body.updated, 1);
  assert.deepEqual(r.body.invalid, ['pas une adresse']);
  assert.equal(r.body.failed.length, 1);
  const marie = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/contacts') && c.body.email === 'marie.dupont@example.com').pop();
  assert.deepEqual(marie.body.attributes, { FIRSTNAME: 'Marie', LASTNAME: 'Dupont' }, 'repli sur FIRSTNAME / LASTNAME');
  assert.deepEqual(marie.body.listIds, [7]);
  assert.equal(marie.body.updateEnabled, true);
  assert.ok(!('emailBlacklisted' in marie.body), 'jamais de réinscription forcée');
  const paul = calls.filter((c) => c.body && c.body.email === 'paul@example.com').pop();
  assert.deepEqual(paul.body.attributes, { FIRSTNAME: 'Paul', LASTNAME: 'Martin' });
});

test('aperçu et essai : sans lien de désinscription factice', async () => {
  const p = await call('GET', '/api/gestion/newsletter/preview');
  assert.ok(!p.body.html.includes('{{ unsubscribe }}'));
  const t = await call('POST', '/api/gestion/newsletter/test', { to: 'moi@example.com', subject: 'Annonce' });
  assert.equal(t.body.ok, true, JSON.stringify(t.body));
  const sent = calls.filter((c) => c.url.includes('/smtp/email')).pop();
  assert.equal(sent.body.subject, '[Essai] Annonce');
  assert.equal((await call('POST', '/api/gestion/newsletter/test', { to: 'faux' })).status, 400);
});

test('envoi : campagne Brevo avec lien de désinscription, envoyée aux listes choisies', async () => {
  assert.equal((await call('POST', '/api/gestion/newsletter/send', { listIds: [], subject: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/gestion/newsletter/send', { listIds: [3], subject: '' })).status, 400);
  const r = await call('POST', '/api/gestion/newsletter/send', { listIds: [3, 7], subject: 'Le ring des affaires' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const camp = calls.find((c) => c.method === 'POST' && c.url.endsWith('/emailCampaigns'));
  assert.deepEqual(camp.body.recipients, { listIds: [3, 7] });
  assert.equal(camp.body.subject, 'Le ring des affaires');
  assert.match(camp.body.name, /^Business Club · Newsletter/);
  assert.equal(camp.body.sender.email, 'contact@example.com');
  assert.match(camp.body.htmlContent, /\{\{ unsubscribe \}\}/, 'Brevo insère le vrai lien de désinscription');
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/emailCampaigns/55/sendNow')));
});
