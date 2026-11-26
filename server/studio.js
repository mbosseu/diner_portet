'use strict';

/**
 * STUDIO — environnement de test des paiements, sur le modèle du studio Box Plus (/dev).
 *
 * - Une session Studio (cookie signé) bascule les paiements de ce navigateur vers :
 *     · le bac à sable du prestataire actif (CAWL_TEST_* ou PAYPAL_TEST_*) si ses clés existent,
 *     · sinon le simulateur de ce prestataire ci-dessous (CAWL ou PayPal).
 *   Les visiteurs normaux ne sont jamais concernés.
 * - Le simulateur reproduit l'API CAWL (création / lecture d'un Hosted Checkout, mêmes formats
 *   de réponse) et VÉRIFIE la signature GCS v1HMAC de chaque appel, comme le ferait CAWL.
 * - La page « banque » simulée accepte des cartes de test qui déclenchent chaque scénario.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const cawl = require('./lib/cawl');
const paypal = require('./lib/paypal');
const payments = require('./lib/payments');
const { publicUrl, isProduction, EVENT } = require('./lib/config');
const { outboxDir } = require('./lib/brevo');

const COOKIE = 'bc_studio';
const SESSION_MS = 8 * 60 * 60 * 1000;

/* Cartes de test → scénario */
const TEST_CARDS = {
  '4111111111111111': { outcome: 'captured', label: 'Paiement accepté' },
  '4000000000000002': { outcome: 'rejected', label: 'Carte refusée par la banque' },
  '4000000000000259': { outcome: 'pending', label: 'Paiement en attente, confirmé ensuite par webhook' },
  '4000000000009995': { outcome: 'tampered', label: 'Montant falsifié (contrôle de sécurité)' },
};

/* Comptes acheteurs de test du simulateur PayPal → scénario */
const PAYPAL_ACCOUNTS = {
  'acheteur.accepte@studio.test': { outcome: 'captured', label: 'Paiement accepté' },
  'acheteur.refuse@studio.test': { outcome: 'rejected', label: 'Moyen de paiement refusé à la capture' },
  'acheteur.attente@studio.test': { outcome: 'pending', label: 'Paiement en attente, confirmé ensuite par webhook' },
  'acheteur.fraude@studio.test': { outcome: 'tampered', label: 'Montant falsifié (contrôle de sécurité)' },
};

/** Cible des paiements du Studio : bac à sable réel ou simulateur, selon le prestataire actif. */
function studioTarget() {
  const provider = payments.provider();
  if (provider === 'paypal') return paypal.testConfigured() ? 'paypal-sandbox' : 'paypal-simulator';
  return cawl.testConfigured() ? 'cawl-preprod' : 'simulator';
}

/* ---------- Session Studio ---------- */

function sessionSecret() {
  return crypto.createHash('sha256').update(`studio-session:${process.env.STUDIO_PASSWORD || ''}:${process.env.CRON_SECRET || process.env.ADMIN_TOKEN || 'local'}`).digest();
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('hex').slice(0, 32);
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function studioAvailable() {
  return Boolean(process.env.STUDIO_PASSWORD) || !isProduction();
}

function isStudio(req) {
  if (!studioAvailable()) return false;
  const value = readCookie(req, COOKIE);
  if (!value) return false;
  const [exp, sig] = value.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function setSession(res) {
  const exp = String(Date.now() + SESSION_MS);
  const secure = publicUrl().startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/* ---------- Stockage des paiements simulés ---------- */

function checkoutsDir() {
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, 'studio-checkouts');
  return process.env.VERCEL ? '/tmp/diner-studio' : path.join(__dirname, '../data/studio-checkouts');
}

function safeCheckoutId(id) {
  return /^(HC-[a-f0-9]{16}|S[0-9A-F]{16})$/.test(String(id || '')) ? String(id) : null;
}

function saveCheckout(c) {
  fs.mkdirSync(checkoutsDir(), { recursive: true });
  fs.writeFileSync(path.join(checkoutsDir(), `${c.id}.json`), JSON.stringify(c, null, 2));
  return c;
}

function loadCheckout(id) {
  const sid = safeCheckoutId(id);
  if (!sid) return null;
  const file = path.join(checkoutsDir(), `${sid}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function listCheckouts() {
  const dir = checkoutsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/** Réponse au format CAWL pour GET /hostedcheckouts/{id}. */
function cawlView(c) {
  if (c.outcome === 'cancelled') return { status: 'CANCELLED_BY_CONSUMER' };
  if (!c.outcome) return { status: 'IN_PROGRESS' };
  const map = {
    captured: { category: 'SUCCESSFUL', status: 'CAPTURED', code: 9 },
    tampered: { category: 'SUCCESSFUL', status: 'CAPTURED', code: 9 },
    rejected: { category: 'REJECTED', status: 'REJECTED', code: 2 },
    pending: { category: 'STATUS_UNKNOWN', status: 'PENDING_CAPTURE', code: 4 },
  }[c.outcome];
  return {
    status: 'PAYMENT_CREATED',
    createdPaymentOutput: {
      paymentStatusCategory: map.category,
      payment: {
        id: c.payment_id,
        status: map.status,
        statusOutput: { statusCode: map.code },
        paymentOutput: {
          amountOfMoney: { currencyCode: 'EUR', amount: c.outcome === 'tampered' ? 100 : c.amount },
          references: { merchantReference: c.merchantReference },
        },
      },
    },
  };
}

/** Réponse au format PayPal Orders v2 pour une commande simulée. */
function paypalView(c) {
  const euros = paypal.eurosFromCents(c.amount);
  const unit = {
    reference_id: c.merchantReference,
    custom_id: c.merchantReference,
    amount: { currency_code: 'EUR', value: euros },
  };
  let status = 'PAYER_ACTION_REQUIRED';
  if (c.outcome && c.outcome !== 'cancelled') status = 'APPROVED';
  if (c.captured) {
    status = 'COMPLETED';
    unit.payments = {
      captures: [{
        id: c.capture_id,
        status: c.outcome === 'pending' ? 'PENDING' : 'COMPLETED',
        custom_id: c.merchantReference,
        amount: { currency_code: 'EUR', value: c.outcome === 'tampered' ? '1.00' : euros },
      }],
    };
  }
  return {
    id: c.id,
    status,
    purchase_units: [unit],
    links: [
      { rel: 'self', href: `${publicUrl()}/api/studio/paypal/v2/checkout/orders/${c.id}`, method: 'GET' },
      { rel: 'payer-action', href: `${publicUrl()}/studio/paypal/${c.id}`, method: 'GET' },
    ],
  };
}

function paypalToken() {
  return crypto.createHmac('sha256', paypal.studioSecret()).update('access-token').digest('hex');
}

function sameString(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Le simulateur exige le même jeton OAuth que PayPal (obtenu avec l'identifiant et le secret). */
function paypalAuthorized(req) {
  return sameString(req.headers.authorization || '', `Bearer ${paypalToken()}`);
}

function paypalError(res, status, issue, description) {
  return res.status(status).json({
    name: status === 401 ? 'AUTHENTICATION_FAILURE' : 'UNPROCESSABLE_ENTITY',
    message: description,
    details: [{ issue, description }],
  });
}

/** Vérifie la signature GCS v1HMAC envoyée par notre propre client CAWL. */
function verifySignature(req, resourcePath) {
  const auth = String(req.headers.authorization || '');
  const date = String(req.headers.date || '');
  const contentType = req.method === 'GET' ? '' : String(req.headers['content-type'] || '').split(';')[0];
  const expected = cawl.authorizationHeader(req.method, contentType, date, resourcePath, cawl.STUDIO_KEY_ID, cawl.studioSecret());
  if (!date || Math.abs(Date.now() - Date.parse(date)) > 15 * 60 * 1000) return false;
  return auth.length === expected.length && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function withParams(url, params) {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + new URLSearchParams(params).toString();
}

/* ---------- Page « banque » simulée ---------- */

function bankPage(c, error = '') {
  const amount = (c.amount / 100).toFixed(2).replace('.', ',');
  const cards = Object.entries(TEST_CARDS).map(([num, v]) =>
    `<button type="button" class="tc" data-card="${num}"><b>${num.replace(/(\d{4})(?=\d)/g, '$1 ')}</b><span>${esc(v.label)}</span></button>`).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paiement sécurisé · Studio</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#eef0f3;font-family:Arial,Helvetica,sans-serif;color:#1d2433}
.top{background:#00573d;color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;font-size:14px}
.top b{letter-spacing:.04em}.badge{background:#ffcf33;color:#1d2433;font-weight:bold;font-size:11px;padding:4px 8px;letter-spacing:.06em}
main{max-width:460px;margin:28px auto;padding:0 16px}
.card{background:#fff;border:1px solid #d6dae1;padding:24px}
.merchant{font-size:13px;color:#5b6475}.amount{font-size:30px;font-weight:bold;margin:6px 0 4px}.ref{font-size:12px;color:#5b6475}
label{display:block;font-size:12px;font-weight:bold;margin:16px 0 6px;color:#3b4456}
input{width:100%;padding:12px;font-size:16px;border:1px solid #c3c9d3}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.pay{width:100%;margin-top:20px;padding:15px;background:#00573d;color:#fff;border:0;font-size:16px;font-weight:bold;cursor:pointer}
.cancel{display:block;text-align:center;margin-top:14px;color:#5b6475;font-size:13px;background:none;border:0;width:100%;cursor:pointer;text-decoration:underline}
.err{background:#fde8e8;color:#9b1c1c;padding:10px 12px;font-size:13px;margin-top:14px}
h2{font-size:13px;margin:22px 0 8px;color:#3b4456}
.tc{display:flex;justify-content:space-between;gap:10px;width:100%;text-align:left;background:#f7f8fa;border:1px solid #d6dae1;padding:10px 12px;margin-bottom:6px;cursor:pointer;font-size:13px}
.tc span{color:#5b6475}.note{font-size:12px;color:#5b6475;margin-top:16px;line-height:1.5}
</style></head><body>
<div class="top"><b>CAWL · Paiement sécurisé</b><span class="badge">STUDIO — SIMULATION</span></div>
<main><div class="card">
<div class="merchant">Boxing Center Portet · ${esc(EVENT.shortName)}</div>
<div class="amount">${amount} €</div><div class="ref">Référence ${esc(c.merchantReference)}</div>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
<form method="post" id="payForm">
<label for="card">Numéro de carte</label><input id="card" name="card" inputmode="numeric" autocomplete="off" placeholder="4111 1111 1111 1111" required>
<div class="row"><div><label for="exp">Expiration</label><input id="exp" name="exp" placeholder="12/29" required></div>
<div><label for="cvc">Cryptogramme</label><input id="cvc" name="cvc" inputmode="numeric" placeholder="123" required></div></div>
<button class="pay" name="action" value="pay" id="payBtn">Payer ${amount} €</button>
<button class="cancel" name="action" value="cancel" id="cancelBtn" formnovalidate>Annuler et revenir au site</button>
</form>
<h2>Cartes de test</h2>${cards}
<p class="note">Page de paiement simulée par le Studio du Business Club. Aucune banque n'est contactée et aucun débit n'a lieu.</p>
</div></main>
<script>document.querySelectorAll('.tc').forEach(function(b){b.addEventListener('click',function(){
document.getElementById('card').value=b.dataset.card.replace(/(\\d{4})(?=\\d)/g,'$1 ');document.getElementById('exp').value='12/29';document.getElementById('cvc').value='123';});});</script>
</body></html>`;
}

/* ---------- Page « PayPal » simulée ---------- */

function paypalPage(c, error = '') {
  const amount = (c.amount / 100).toFixed(2).replace('.', ',');
  const accounts = Object.entries(PAYPAL_ACCOUNTS).map(([email, v]) =>
    `<button type="button" class="tc" data-email="${esc(email)}"><b>${esc(email)}</b><span>${esc(v.label)}</span></button>`).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paiement PayPal · Studio</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f2f4f7;font-family:Arial,Helvetica,sans-serif;color:#1d2433}
.top{background:#1d2b4f;color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;font-size:14px}
.badge{background:#ffcf33;color:#1d2433;font-weight:bold;font-size:11px;padding:4px 8px;letter-spacing:.06em}
main{max-width:460px;margin:28px auto;padding:0 16px}
.card{background:#fff;border:1px solid #d6dae1;padding:24px}
.merchant{font-size:13px;color:#5b6475}.amount{font-size:30px;font-weight:bold;margin:6px 0 4px}.ref{font-size:12px;color:#5b6475}
label{display:block;font-size:12px;font-weight:bold;margin:16px 0 6px;color:#3b4456}
input{width:100%;padding:12px;font-size:16px;border:1px solid #c3c9d3}
.pay{width:100%;margin-top:20px;padding:15px;background:#1d2b4f;color:#fff;border:0;font-size:16px;font-weight:bold;cursor:pointer;border-radius:24px}
.cancel{display:block;text-align:center;margin-top:14px;color:#5b6475;font-size:13px;background:none;border:0;width:100%;cursor:pointer;text-decoration:underline}
.err{background:#fde8e8;color:#9b1c1c;padding:10px 12px;font-size:13px;margin-top:14px}
h2{font-size:13px;margin:22px 0 8px;color:#3b4456}
.tc{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;background:#f7f8fa;border:1px solid #d6dae1;padding:10px 12px;margin-bottom:6px;cursor:pointer;font-size:13px}
.tc span{color:#5b6475}.note{font-size:12px;color:#5b6475;margin-top:16px;line-height:1.5}
</style></head><body>
<div class="top"><b>PayPal · Paiement</b><span class="badge">STUDIO — SIMULATION</span></div>
<main><div class="card">
<div class="merchant">Boxing Center Portet · ${esc(EVENT.shortName)}</div>
<div class="amount">${amount} €</div><div class="ref">Référence ${esc(c.merchantReference)}</div>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
<form method="post" id="payForm">
<label for="email">Compte PayPal (adresse e-mail)</label><input id="email" name="email" type="email" autocomplete="off" placeholder="acheteur.accepte@studio.test" required>
<button class="pay" name="action" value="pay" id="payBtn">Payer ${amount} €</button>
<button class="cancel" name="action" value="cancel" id="cancelBtn" formnovalidate>Annuler et revenir au site</button>
</form>
<h2>Comptes acheteurs de test</h2>${accounts}
<p class="note">Page PayPal simulée par le Studio du Business Club. Aucun compte PayPal n'est contacté et aucun débit n'a lieu.</p>
</div></main>
<script>document.querySelectorAll('.tc').forEach(function(b){b.addEventListener('click',function(){document.getElementById('email').value=b.dataset.email;});});</script>
</body></html>`;
}

/* ---------- Routes ---------- */

function mount(app, { store, sendReminders, sendRealTestEmails, isLive, publicView }) {
  /* --- API PayPal simulée (OAuth client_credentials puis jeton Bearer, comme PayPal) --- */
  app.post('/api/studio/paypal/v1/oauth2/token', (req, res) => {
    const expected = `Basic ${Buffer.from(`${paypal.STUDIO_CLIENT_ID}:${paypal.studioSecret()}`).toString('base64')}`;
    if (!sameString(req.headers.authorization || '', expected) || req.body?.grant_type !== 'client_credentials') {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Client Authentication failed' });
    }
    res.json({ access_token: paypalToken(), token_type: 'Bearer', expires_in: 32400 });
  });

  app.post('/api/studio/paypal/v2/checkout/orders', (req, res) => {
    if (!paypalAuthorized(req)) return paypalError(res, 401, 'INVALID_TOKEN', 'Jeton invalide');
    const unit = req.body?.purchase_units?.[0] || {};
    const ctx = req.body?.payment_source?.paypal?.experience_context || {};
    const amount = Math.round(Number(unit.amount?.value) * 100);
    if (req.body?.intent !== 'CAPTURE' || unit.amount?.currency_code !== 'EUR' || !Number.isInteger(amount) || amount <= 0
      || !unit.custom_id || !ctx.return_url || !ctx.cancel_url) {
      return paypalError(res, 422, 'INVALID_PARAMETER_VALUE', 'Commande invalide');
    }
    const c = saveCheckout({
      id: `S${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
      kind: 'paypal',
      capture_id: `CAP${crypto.randomBytes(7).toString('hex').toUpperCase()}`,
      created_at: new Date().toISOString(),
      amount,
      merchantReference: String(unit.custom_id),
      returnUrl: String(ctx.return_url),
      cancelUrl: String(ctx.cancel_url),
      email: req.body?.payment_source?.paypal?.email_address || '',
      outcome: null,
      captured: false,
    });
    res.status(201).json(paypalView(c));
  });

  app.get('/api/studio/paypal/v2/checkout/orders/:id', (req, res) => {
    if (!paypalAuthorized(req)) return paypalError(res, 401, 'INVALID_TOKEN', 'Jeton invalide');
    const c = loadCheckout(req.params.id);
    if (!c || c.kind !== 'paypal') return res.status(404).json({ name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
    res.json(paypalView(c));
  });

  app.post('/api/studio/paypal/v2/checkout/orders/:id/capture', (req, res) => {
    if (!paypalAuthorized(req)) return paypalError(res, 401, 'INVALID_TOKEN', 'Jeton invalide');
    const c = loadCheckout(req.params.id);
    if (!c || c.kind !== 'paypal') return res.status(404).json({ name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
    if (!c.outcome || c.outcome === 'cancelled') return paypalError(res, 422, 'ORDER_NOT_APPROVED', 'Commande non approuvée par l’acheteur');
    if (c.captured) return paypalError(res, 422, 'ORDER_ALREADY_CAPTURED', 'Commande déjà capturée');
    if (c.outcome === 'rejected') return paypalError(res, 422, 'INSTRUMENT_DECLINED', 'Moyen de paiement refusé');
    c.captured = true;
    c.captured_at = new Date().toISOString();
    saveCheckout(c);
    res.status(201).json(paypalView(c));
  });

  /* --- Page PayPal simulée --- */
  function paypalBack(c) {
    const url = c.outcome === 'cancelled' ? c.cancelUrl : c.returnUrl;
    const params = { token: c.id };
    if (c.outcome !== 'cancelled') params.PayerID = 'STUDIOPAYER01';
    return withParams(url, params);
  }

  app.get('/studio/paypal/:id', (req, res) => {
    const c = loadCheckout(req.params.id);
    if (!c || c.kind !== 'paypal') return res.status(404).type('text').send('Commande PayPal introuvable');
    if (c.outcome) return res.redirect(303, paypalBack(c));
    res.type('html').send(paypalPage(c));
  });

  app.post('/studio/paypal/:id', (req, res) => {
    const c = loadCheckout(req.params.id);
    if (!c || c.kind !== 'paypal') return res.status(404).type('text').send('Commande PayPal introuvable');
    if (!c.outcome) {
      if (req.body?.action === 'cancel') {
        c.outcome = 'cancelled';
      } else {
        const email = String(req.body?.email || '').trim().toLowerCase();
        const scenario = PAYPAL_ACCOUNTS[email];
        if (!scenario) {
          return res.status(400).type('html').send(paypalPage(c, 'Compte inconnu : utilisez un compte acheteur de test ci-dessous.'));
        }
        c.outcome = scenario.outcome;
        c.card = email;
      }
      c.completed_at = new Date().toISOString();
      saveCheckout(c);
    }
    res.redirect(303, paypalBack(c));
  });

  /* --- API CAWL simulée (authentifiée par signature HMAC, comme CAWL) --- */
  app.post('/api/studio/cawl/v2/:merchant/hostedcheckouts', (req, res) => {
    const resourcePath = `/v2/${req.params.merchant}/hostedcheckouts`;
    if (req.params.merchant !== cawl.STUDIO_MERCHANT || !verifySignature(req, resourcePath)) {
      return res.status(401).json({ errorId: 'studio', errors: [{ code: '9002', id: 'ACCESS_DENIED', message: 'Signature HMAC invalide' }] });
    }
    const order = req.body?.order || {};
    const amount = Number(order.amountOfMoney?.amount);
    const ref = String(order.references?.merchantReference || '');
    const returnUrl = String(req.body?.hostedCheckoutSpecificInput?.returnUrl || '');
    if (!Number.isInteger(amount) || amount <= 0 || !ref || !returnUrl) {
      return res.status(400).json({ errorId: 'studio', errors: [{ code: '1008', id: 'INVALID_VALUE', message: 'Champ invalide' }] });
    }
    if (returnUrl.length > 200) {
      return res.status(400).json({ errorId: 'studio', errors: [{ code: '1008', id: 'INVALID_VALUE', propertyName: 'returnUrl', message: 'returnUrl trop longue' }] });
    }
    const c = saveCheckout({
      id: `HC-${crypto.randomBytes(8).toString('hex')}`,
      payment_id: `PAY-${crypto.randomBytes(6).toString('hex')}`,
      created_at: new Date().toISOString(),
      amount,
      merchantReference: ref,
      returnUrl,
      customer: order.customer?.personalInformation?.name || {},
      email: order.customer?.contactDetails?.emailAddress || '',
      outcome: null,
      mac: crypto.randomBytes(8).toString('hex'),
    });
    res.status(201).json({
      hostedCheckoutId: c.id,
      RETURNMAC: c.mac,
      merchantReference: ref,
      redirectUrl: `${publicUrl()}/studio/pay/${c.id}`,
    });
  });

  app.get('/api/studio/cawl/v2/:merchant/hostedcheckouts/:id', (req, res) => {
    const resourcePath = `/v2/${req.params.merchant}/hostedcheckouts/${req.params.id}`;
    if (req.params.merchant !== cawl.STUDIO_MERCHANT || !verifySignature(req, resourcePath)) {
      return res.status(401).json({ errorId: 'studio', errors: [{ code: '9002', id: 'ACCESS_DENIED', message: 'Signature HMAC invalide' }] });
    }
    const c = loadCheckout(req.params.id);
    if (!c) return res.status(404).json({ errorId: 'studio', errors: [{ code: '1002', id: 'UNKNOWN_HOSTED_CHECKOUT' }] });
    res.json(cawlView(c));
  });

  /* --- Page de paiement simulée --- */
  app.get('/studio/pay/:id', (req, res) => {
    const c = loadCheckout(req.params.id);
    if (!c) return res.status(404).type('text').send('Session de paiement introuvable');
    if (c.outcome) return res.redirect(303, withParams(c.returnUrl, { RETURNMAC: c.mac, hostedCheckoutId: c.id }));
    res.type('html').send(bankPage(c));
  });

  app.post('/studio/pay/:id', (req, res) => {
    const c = loadCheckout(req.params.id);
    if (!c) return res.status(404).type('text').send('Session de paiement introuvable');
    if (!c.outcome) {
      if (req.body?.action === 'cancel') {
        c.outcome = 'cancelled';
      } else {
        const card = String(req.body?.card || '').replace(/\D/g, '');
        const exp = String(req.body?.exp || '').trim();
        const cvc = String(req.body?.cvc || '').trim();
        if (!/^\d{2}\/\d{2}$/.test(exp) || !/^\d{3}$/.test(cvc)) {
          return res.status(400).type('html').send(bankPage(c, 'Date d’expiration ou cryptogramme invalide.'));
        }
        const scenario = TEST_CARDS[card];
        if (!scenario) {
          return res.status(400).type('html').send(bankPage(c, 'Carte inconnue : utilisez une carte de test ci-dessous.'));
        }
        c.outcome = scenario.outcome;
        c.card = `•••• ${card.slice(-4)}`;
      }
      c.completed_at = new Date().toISOString();
      saveCheckout(c);
    }
    res.redirect(303, withParams(c.returnUrl, { RETURNMAC: c.mac, hostedCheckoutId: c.id }));
  });

  /* --- Session Studio --- */
  app.get('/api/studio/state', (req, res) => {
    res.json({
      ok: true,
      available: studioAvailable(),
      studio: isStudio(req),
      password_required: Boolean(process.env.STUDIO_PASSWORD),
      provider: payments.provider(),
      target: studioTarget(),
    });
  });

  app.post('/api/studio/unlock', (req, res) => {
    if (!studioAvailable()) return res.status(404).json({ ok: false });
    const expected = process.env.STUDIO_PASSWORD;
    const given = String(req.body?.password || '');
    if (expected) {
      const a = Buffer.from(given);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: 'bad_password' });
    }
    setSession(res);
    res.json({ ok: true });
  });

  app.post('/api/studio/leave', (_req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  function guard(req, res, next) {
    if (!isStudio(req)) return res.status(404).json({ ok: false, error: 'not_found' });
    next();
  }

  app.get('/api/studio/overview', guard, async (_req, res) => {
    const regs = (await store.listAll()).filter((r) => !isLive(r));
    const dir = outboxDir();
    const outbox = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort().reverse().map((f) => {
        const head = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')[0];
        const m = head.match(/To: (.*?) \| Subject: (.*?) -->/);
        return { file: f, to: m ? m[1] : '', subject: m ? m[2] : f };
      })
      : [];
    const provider = payments.provider();
    res.json({
      ok: true,
      provider,
      target: studioTarget(),
      registrations: regs.map((r) => ({
        ...publicView(r),
        pay_mode: r.pay_mode,
        created_at: r.created_at,
        confirmation_sent_at: r.confirmation_sent_at || null,
        reminder_sent_at: r.reminder_sent_at || null,
        review_reason: r.review_reason || null,
        checkout: r.cawl_hosted_checkout_id || r.paypal_order_id || null,
      })).reverse(),
      checkouts: listCheckouts().map((c) => ({
        id: c.id, kind: c.kind || 'cawl', ref: c.merchantReference, amount: c.amount, card: c.card || null, created_at: c.created_at,
        // Un paiement PayPal en attente n'existe qu'après la capture (faite au retour sur le site).
        outcome: c.kind === 'paypal' && c.outcome === 'pending' && !c.captured ? 'approved' : c.outcome,
      })),
      outbox,
      cards: provider === 'paypal' ? PAYPAL_ACCOUNTS : TEST_CARDS,
    });
  });

  /* Le paiement « en attente » est confirmé par la banque : on envoie le webhook, comme CAWL */
  app.post('/api/studio/checkouts/:id/webhook', guard, async (req, res) => {
    const c = loadCheckout(req.params.id);
    if (!c) return res.status(404).json({ ok: false });
    if (c.kind === 'paypal') {
      if (c.outcome === 'pending' && c.captured) {
        c.outcome = 'captured';
        saveCheckout(c);
      }
      const r = await fetch(`${publicUrl()}/api/webhooks/paypal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource: {
            id: c.capture_id,
            status: 'COMPLETED',
            custom_id: c.merchantReference,
            supplementary_data: { related_ids: { order_id: c.id } },
          },
        }),
      });
      return res.json({ ok: r.ok, webhook: await r.json().catch(() => null) });
    }
    if (c.outcome === 'pending') {
      c.outcome = 'captured';
      saveCheckout(c);
    }
    const r = await fetch(`${publicUrl()}/api/webhooks/cawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'payment.captured',
        payment: {
          id: c.payment_id,
          paymentOutput: { references: { merchantReference: c.merchantReference } },
          hostedCheckoutSpecificOutput: { hostedCheckoutId: c.id },
        },
      }),
    });
    res.json({ ok: r.ok, webhook: await r.json().catch(() => null) });
  });

  app.get('/api/studio/outbox/:file', guard, (req, res) => {
    const name = path.basename(String(req.params.file));
    const file = path.join(outboxDir(), name);
    if (!name.endsWith('.html') || !fs.existsSync(file)) return res.status(404).end();
    res.type('html').send(fs.readFileSync(file, 'utf8'));
  });

  app.post('/api/studio/reminders', guard, async (_req, res) => {
    const result = await sendReminders('test');
    res.json({ ok: true, sent: result.sent.length, failed: result.failed });
  });

  app.post('/api/studio/real-email', guard, async (req, res) => {
    const to = String(req.body?.to || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return res.status(400).json({ ok: false, error: 'invalid_email' });
    const tests = (await store.listAll()).filter((r) => !isLive(r) && r.status === 'paid');
    const reg = req.body?.id ? tests.find((r) => r.id === req.body.id) : tests[tests.length - 1];
    if (!reg) return res.status(404).json({ ok: false, error: 'no_paid_test_registration' });
    res.json({ id: reg.id, to, ...(await sendRealTestEmails(reg, to)) });
  });

  app.post('/api/studio/reset', guard, async (_req, res) => {
    let removed = 0;
    for (const r of await store.listAll()) {
      if (!isLive(r)) { await store.remove(r.id); removed++; }
    }
    for (const dir of [checkoutsDir(), outboxDir()]) {
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    }
    res.json({ ok: true, removed });
  });
}

module.exports = { mount, isStudio, TEST_CARDS, PAYPAL_ACCOUNTS, cawlView, paypalView };
