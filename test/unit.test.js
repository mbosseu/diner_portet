'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const cawl = require('../server/lib/cawl');
const { cawlView } = require('../server/studio');
const { confirmationEmail, reminderEmail, organizerEmail } = require('../server/lib/emails');
const { validate } = require('../server/app');

test('signature CAWL : identique à celle de la boutique Box Plus (GCS v1HMAC)', () => {
  const date = 'Wed, 26 Nov 2026 10:00:00 GMT';
  const header = cawl.authorizationHeader('POST', 'application/json', date, '/v2/M/hostedcheckouts', 'KEY', 'SECRET');
  const expected = crypto.createHmac('sha256', 'SECRET')
    .update(`POST\napplication/json\n${date}\n/v2/M/hostedcheckouts\n`, 'utf8').digest('base64');
  assert.equal(header, `GCS v1HMAC:KEY:${expected}`);
});

test('hôte CAWL selon le mode', () => {
  process.env.CAWL_MODE = 'live';
  assert.equal(cawl.config('live').base, cawl.LIVE_HOST);
  process.env.CAWL_MODE = 'test';
  assert.equal(cawl.config('live').base, cawl.PREPROD_HOST);
  assert.equal(cawl.config('test').base, cawl.PREPROD_HOST);
  assert.equal(cawl.config('studio', 'http://x').base, 'http://x/api/studio/cawl');
  delete process.env.CAWL_MODE;
});

test('lecture des statuts CAWL', () => {
  const base = { merchantReference: 'DP-AAAA1111', amount: 1000, payment_id: 'P1' };
  assert.equal(cawl.isCawlPaid(cawlView({ ...base, outcome: 'captured' })), true);
  assert.equal(cawl.cawlPaidCents(cawlView({ ...base, outcome: 'captured' })), 1000);
  assert.equal(cawl.cawlPaidCents(cawlView({ ...base, outcome: 'tampered' })), 100);
  assert.equal(cawl.isCawlRejected(cawlView({ ...base, outcome: 'rejected' })), true);
  assert.equal(cawl.isCawlPaid(cawlView({ ...base, outcome: 'pending' })), false);
  assert.equal(cawl.isCawlRejected(cawlView({ ...base, outcome: 'pending' })), false);
  assert.equal(cawl.isCawlCancelled(cawlView({ ...base, outcome: 'cancelled' })), true);
  assert.equal(cawl.isCawlPaid(cawlView({ ...base, outcome: null })), false);
  assert.equal(cawl.cawlMerchantReference(cawlView({ ...base, outcome: 'captured' })), 'DP-AAAA1111');
});

test('URL de retour ≤ 200 caractères (limite CAWL)', () => {
  const url = cawl.buildReturnUrl('https://diner.boxingcenter.fr', 'DP-ABCDEFGH', 'a'.repeat(48));
  assert.ok(url.length <= 200);
  const long = cawl.buildReturnUrl(`https://${'x'.repeat(150)}.fr`, 'DP-ABCDEFGH', 'a'.repeat(48));
  assert.ok(long.length <= 200 || !long.includes('&t='));
});

test('téléphone au format international', () => {
  assert.equal(cawl.phoneE164('06 12 34 56 78'), '+33612345678');
  assert.equal(cawl.phoneE164('+33 6 12 34 56 78'), '+33612345678');
  assert.equal(cawl.phoneE164('12'), undefined);
});

test('validation : nettoyage et site web complété', () => {
  const { fields, errors } = validate({
    firstName: '  Camille  ', lastName: 'Durand', email: 'CAMILLE@Example.com ', phone: '0612345678',
    company: 'X', role: 'Y', activity: 'Z', sector: 'Autre', website: 'monsite.fr', looking: 'a', offer: 'b', consent: 'on',
  });
  assert.deepEqual(errors, {});
  assert.equal(fields.first_name, 'Camille');
  assert.equal(fields.email, 'camille@example.com');
  assert.equal(fields.website, 'https://monsite.fr');
});

test('e-mails : contenu échappé (pas d’injection HTML) et informations clés', () => {
  const reg = {
    id: 'DP-ABCDEFGH', token: 't', first_name: '<script>alert(1)</script>', last_name: 'Durand',
    role: 'CEO', company: 'ACME & Co', email: 'a@b.fr', amount_cents: 1000,
    phone: '0612345678', activity: 'x', sector: 'Autre', looking: 'y', offer: 'z',
  };
  const conf = confirmationEmail(reg, { qrSrc: 'data:image/png;base64,AAA' });
  assert.doesNotMatch(conf.html, /<script>/);
  assert.match(conf.html, /&lt;script&gt;/);
  assert.match(conf.html, /ACME &amp; Co/);
  assert.match(conf.html, /DP-ABCDEFGH/);
  assert.match(conf.html, /10 €/);
  assert.match(conf.subject, /invitation/i);
  const rem = reminderEmail(reg, { qrSrc: 'x' });
  assert.match(rem.subject, /Rappel/);
  const org = organizerEmail(reg);
  assert.match(org.text, /Recherche : y/);
});

test('noms : majuscules corrigées si tout est saisi en minuscules ou en capitales', () => {
  const { validate: v } = require('../server/app');
  const base = { email: 'a@b.fr', phone: '0612345678', company: 'x', role: 'x', activity: 'x', sector: 'Autre', looking: 'x', offer: 'x', consent: true };
  const name = (f, l) => { const r = v({ ...base, firstName: f, lastName: l }).fields; return `${r.first_name} ${r.last_name}`; };
  assert.equal(name('brad', 'mbosseu'), 'Brad Mbosseu');
  assert.equal(name('JEAN-PIERRE', "D'ARC"), "Jean-Pierre D'Arc");
  assert.equal(name('éloïse', 'le goff'), 'Éloïse Le Goff');
  assert.equal(name('Marie', 'McAllister'), 'Marie McAllister');
});
