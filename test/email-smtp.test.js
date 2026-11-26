'use strict';

/**
 * QR code intégré dans l'e-mail (cid) via le SMTP Brevo, et repli sur l'API si le SMTP échoue.
 * Aucun e-mail réel : transport SMTP en mémoire, API Brevo simulée.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  BREVO_API_KEY: 'xkeysib-test-0000000000000000',
  BREVO_SMTP_LOGIN: 'login@smtp-brevo.com',
  BREVO_SMTP_KEY: 'cle-smtp-test',
  BREVO_SENDER_EMAIL: 'expediteur@example.com',
  SMTP_STREAM_FOR_TESTS: '1',
});
for (const k of ['SMTP_USER', 'SMTP_PASS', 'SMTP_HOST', 'SMTP_PORT']) delete process.env[k];

const brevo = require('../server/lib/brevo');
const { confirmationEmail } = require('../server/lib/emails');

const reg = { id: 'DP-ABCDEFGH', token: 'tok', first_name: 'Brad', last_name: 'Mbosseu', company: 'X', role: 'Y', amount_cents: 1000 };
const qr = Buffer.from('fake-png').toString('base64');

test('SMTP : le QR est intégré au message (Content-ID) et aussi joint', async () => {
  const cid = 'qr-dp-abcdefgh@businessclub';
  const mail = confirmationEmail(reg, { qrSrc: `cid:${cid}` });
  const r = await brevo.sendEmail({
    to: 'invite@example.com', subject: mail.subject, html: mail.html, text: mail.text,
    attachments: [{ name: 'invitation-DP-ABCDEFGH.png', content: qr }],
    inline: [{ cid, name: 'qr-DP-ABCDEFGH.png', content: qr }],
    htmlFallback: '<p>secours</p>',
  });
  assert.equal(r.via, 'brevo-smtp');
  const raw = r.raw.toString();
  assert.match(raw, new RegExp(`Content-ID: <${cid}>`));
  assert.match(raw, /Content-Disposition: inline/);
  assert.match(raw, /invitation-DP-ABCDEFGH\.png/);
  assert.match(raw, /src=3D"cid:qr-dp-abcdefgh@businessclub"|src="cid:qr-dp-abcdefgh@businessclub"/);
  assert.match(raw, /From: [\s\S]{0,120}<expediteur@example\.com>/);
});

test('SMTP en échec : envoi par l’API avec l’image hébergée (htmlFallback)', async () => {
  const realFetch = global.fetch;
  let sentBody = null;
  global.fetch = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({ messageId: '<api@brevo>' }), { status: 201 });
  };
  const nodemailer = require('nodemailer');
  const original = nodemailer.createTransport;
  // force un transport qui échoue
  delete require.cache[require.resolve('../server/lib/brevo')];
  nodemailer.createTransport = () => ({ sendMail: async () => { throw new Error('SMTP indisponible'); } });
  const fresh = require('../server/lib/brevo');
  try {
    const r = await fresh.sendEmail({
      to: 'invite@example.com', subject: 'S', html: '<img src="cid:x">', text: 't',
      inline: [{ cid: 'x', name: 'x.png', content: qr }], htmlFallback: '<img src="https://site/qr.png">',
    });
    assert.equal(r.via, 'brevo-api');
    assert.match(sentBody.htmlContent, /https:\/\/site\/qr\.png/);
    assert.doesNotMatch(sentBody.htmlContent, /cid:/);
  } finally {
    global.fetch = realFetch;
    nodemailer.createTransport = original;
  }
});
