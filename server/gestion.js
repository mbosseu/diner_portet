'use strict';

/**
 * Back-office de l'événement (page /gestion) :
 *  - connexion par mot de passe (ADMIN_TOKEN), session signée en cookie HttpOnly ;
 *  - liste des inscrits (nom, entreprise, e-mail, téléphone, paiement, présence), export CSV ;
 *  - contrôle d'entrée : scan du QR code (signature vérifiée), une seule entrée par invitation ;
 *  - invitations partenaires BC-PART-01 à 10, une seule entrée chacune ;
 *  - renvoi de l'invitation par e-mail ;
 *  - ajout d'un invité (payé sur place, invité gratuit), correction des coordonnées, annulation ;
 *  - onglet E-mails : rappels, invitations en échec, message groupé aux participants.
 */

const crypto = require('crypto');
const { publicUrl, isProduction, maxPaidSeats } = require('./lib/config');

const COOKIE = 'bc_gestion';
const SESSION_MS = 12 * 60 * 60 * 1000;
const PARTNER_INVITES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

function secret() {
  return process.env.CRON_SECRET || process.env.ADMIN_TOKEN || 'dev-secret-local';
}

function sign(value) {
  return crypto.createHmac('sha256', `gestion:${secret()}`).update(String(value)).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

/** Mot de passe du back-office : ADMIN_TOKEN. En local sans ADMIN_TOKEN : « local ». */
function password() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  return isProduction() ? '' : 'local';
}

function isAuthed(req) {
  const value = readCookie(req, COOKIE);
  const [exp, sig] = value.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}

function setSession(res) {
  const exp = String(Date.now() + SESSION_MS);
  const secure = publicUrl().startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure}`);
}

const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  attempts.set(ip, list);
  return list.length >= LOGIN_MAX_ATTEMPTS;
}
function recordFailure(ip) {
  attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);
}

/** Vue complète pour l'organisateur (jamais le jeton d'accès de l'invitation). */
function adminView(reg) {
  return {
    id: reg.id,
    status: reg.status,
    partner: reg.status === 'partner',
    test: Boolean(reg.pay_mode && reg.pay_mode !== 'live'),
    first_name: reg.first_name || '',
    last_name: reg.last_name || '',
    email: reg.email || '',
    phone: reg.phone || '',
    company: reg.company || '',
    role: reg.role || '',
    activity: reg.activity || '',
    sector: reg.sector || '',
    website: reg.website || '',
    looking: reg.looking || '',
    offer: reg.offer || '',
    amount_cents: reg.amount_cents || 0,
    created_at: reg.created_at || null,
    paid_at: reg.paid_at || null,
    checked_in_at: reg.checked_in_at || null,
    confirmation_sent_at: reg.confirmation_sent_at || null,
    confirmation_error: reg.confirmation_error || null,
    recovered: Boolean(reg.recovered_at),
    checked_in_via: reg.checked_in_via || null,
    reminder_sent_at: reg.reminder_sent_at || null,
    note: reg.note || '',
    source: reg.provider === 'manual' ? (reg.payment_kind === 'free' ? 'free' : 'onsite') : (reg.status === 'partner' ? 'partner' : 'online'),
    messages: (reg.messages_sent || []).map((m) => ({ id: m.id, subject: m.subject, at: m.at })),
  };
}

const AUDIENCES = {
  paid: { label: 'Tous les inscrits payés', test: (r) => r.status === 'paid' },
  absent: { label: 'Inscrits pas encore arrivés', test: (r) => r.status === 'paid' && !r.checked_in_at },
  present: { label: 'Participants présents', test: (r) => r.status === 'paid' && Boolean(r.checked_in_at) },
  pending: { label: 'Paiements non finalisés', test: (r) => r.status === 'pending' },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SAMPLE = { first_name: 'Camille', last_name: 'Durand', status: 'paid', token: 'apercu', id: 'DP-APERCU' };

function partnerId(n) {
  return `DP-PART${String(n).padStart(2, '0')}`;
}

/** « BC-PART-3 », « bc part 03 »… → numéro 1 à 10, sinon null. */
function partnerNumber(code) {
  const m = String(code || '').trim().toUpperCase().match(/^BC[-\s]?PART[-\s]?(\d{1,2})$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= PARTNER_INVITES ? n : null;
}

function hhmm(iso) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)).replace(':', ' h ');
}

function mount(app, {
  store, isLive, qrPayload, reconcile, resendInvitation, sendReminders, reminderWindow,
  newId, newToken, properName, clean, sectors = [], sendMessage, messageEmail, sendPartnerInvitation,
}) {
  function guard(req, res, next) {
    if (!isAuthed(req)) return res.status(401).json({ ok: false, error: 'login_required' });
    next();
  }

  app.get('/api/gestion/state', (req, res) => {
    res.json({ ok: true, authed: isAuthed(req), available: Boolean(password()) });
  });

  app.post('/api/gestion/login', (req, res) => {
    const ip = req.ip || 'unknown';
    if (tooManyAttempts(ip)) return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    const expected = password();
    if (!expected || !safeEqual(String(req.body?.password || '').trim(), expected)) {
      recordFailure(ip);
      return res.status(401).json({ ok: false, error: 'bad_password' });
    }
    attempts.delete(ip);
    setSession(res);
    res.json({ ok: true });
  });

  app.post('/api/gestion/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  async function listFor(includeTest) {
    await reconcile();
    return (await store.listAll()).filter((r) => includeTest || isLive(r));
  }

  app.get('/api/gestion/overview', guard, async (req, res) => {
    const includeTest = req.query.test === '1';
    const all = await listFor(includeTest);
    const now = Date.now();
    const paid = all.filter((r) => r.status === 'paid');
    const partners = all.filter((r) => r.status === 'partner');
    const pending = all.filter((r) => r.status === 'pending' && now - Date.parse(r.created_at) < 3 * 24 * 3600 * 1000);
    res.json({
      ok: true,
      stats: {
        paid: paid.length,
        max: maxPaidSeats(),
        pending: pending.length,
        present: [...paid, ...partners].filter((r) => r.checked_in_at).length,
        expected: paid.length + PARTNER_INVITES,
        partners_present: partners.filter((r) => r.checked_in_at).length,
        partners_total: PARTNER_INVITES,
        revenue_cents: paid.filter(isLive).reduce((s, r) => s + (r.amount_cents || 0), 0),
        reminders_sent: paid.filter((r) => r.reminder_sent_at).length,
        invitations_sent: paid.filter((r) => r.confirmation_sent_at && !r.confirmation_error).length,
        invitations_failed: paid.filter((r) => r.confirmation_error).length,
        review: all.filter((r) => r.status === 'review').length,
        onsite: paid.filter((r) => r.provider === 'manual').length,
      },
      sectors,
      partners: await partnersList(all),
      audiences: Object.fromEntries(Object.entries(AUDIENCES).map(([k, a]) => [k, {
        label: a.label, count: all.filter((r) => a.test(r) && r.email).length,
      }])),
      reminders: reminderWindow ? reminderWindow() : null,
      registrations: all
        .filter((r) => r.status !== 'pending' || pending.includes(r))
        .sort((a, b) => String(a.last_name).localeCompare(String(b.last_name), 'fr'))
        .map(adminView),
    });
  });

  /**
   * Contrôle d'entrée. Corps : { qr } (contenu du QR), { id } (référence DP-…) ou { code } (BC-PART-xx).
   * Réponse : result = ok | already | refused, avec un message prêt à afficher.
   */
  app.post('/api/gestion/checkin', guard, async (req, res) => {
    const allowTest = req.body?.allowTest === true;
    const raw = String(req.body?.qr || req.body?.id || req.body?.code || '').trim();
    const refused = (reason, message, extra = {}) => res.json({ ok: true, result: 'refused', reason, message, ...extra });
    if (!raw) return refused('empty', 'Aucun code lu.');

    // Invitation partenaire
    const pn = partnerNumber(raw);
    if (pn) {
      const id = partnerId(pn);
      let reg = await store.load(id);
      if (reg?.checked_in_at) {
        return res.json({ ok: true, result: 'already', message: `Invitation partenaire N° ${String(pn).padStart(2, '0')} déjà utilisée à ${hhmm(reg.checked_in_at)}.`, registration: adminView(reg) });
      }
      reg = reg || {
        id, status: 'partner', first_name: 'Invité partenaire', last_name: `N° ${String(pn).padStart(2, '0')}`,
        email: '', company: 'Partenaire / sponsor', created_at: new Date().toISOString(), amount_cents: 0,
      };
      const guestName = clean(req.body?.name, 80);
      if (guestName) {
        reg.first_name = properName(guestName);
        reg.last_name = '';
        reg.company = `Invitation partenaire N° ${String(pn).padStart(2, '0')}`;
      }
      reg.checked_in_at = new Date().toISOString();
      await store.save(reg);
      const who = reg.first_name && reg.first_name !== 'Invité partenaire' ? ` ${[reg.first_name, reg.last_name].filter(Boolean).join(' ')}` : '';
      return res.json({ ok: true, result: 'ok', message: `Bienvenue${who} — invitation partenaire N° ${String(pn).padStart(2, '0')}.`, registration: adminView(reg) });
    }

    // QR code (BCDINER|id|signature) ou référence saisie à la main
    let id = raw.toUpperCase();
    let fromQr = false;
    if (raw.startsWith('BCDINER|')) {
      const parts = raw.split('|');
      if (parts.length !== 3) return refused('invalid', 'QR code illisible ou inconnu.');
      id = parts[1];
      fromQr = true;
      const reg = /^DP-[A-Z0-9]{6,12}$/.test(id) ? await store.load(id) : null;
      if (!reg || !safeEqual(raw, qrPayload(reg))) return refused('forged', 'QR code non reconnu : signature invalide.');
    } else if (/^https?:\/\//i.test(raw) || raw.includes('|')) {
      return refused('invalid', 'Ce QR code n’est pas une invitation du Business Club.');
    }

    if (!/^DP-[A-Z0-9]{6,12}$/.test(id)) return refused('invalid', 'Référence inconnue.');
    const reg = await store.load(id);
    if (!reg) return refused('unknown', 'Aucune inscription avec cette référence.');
    if (!isLive(reg) && !allowTest) return refused('test', 'Invitation de TEST (Studio) : non valable le jour J.', { registration: adminView(reg) });
    if (reg.status !== 'paid' && reg.status !== 'partner') {
      const why = reg.status === 'pending' ? 'paiement non finalisé' : `inscription ${reg.status === 'cancelled' ? 'annulée' : 'non payée'}`;
      return refused('unpaid', `Refusé : ${why}.`, { registration: adminView(reg) });
    }
    if (reg.checked_in_at) {
      return res.json({ ok: true, result: 'already', message: `${reg.first_name} ${reg.last_name} : déjà entré(e) à ${hhmm(reg.checked_in_at)}.`, registration: adminView(reg) });
    }
    reg.checked_in_at = new Date().toISOString();
    reg.checked_in_via = fromQr ? 'qr' : 'manual';
    await store.save(reg);
    res.json({ ok: true, result: 'ok', message: `Bienvenue ${reg.first_name} ${reg.last_name}.`, registration: adminView(reg) });
  });

  app.post('/api/gestion/checkin/undo', guard, async (req, res) => {
    const reg = await store.load(String(req.body?.id || ''));
    if (!reg) return res.status(404).json({ ok: false, error: 'not_found' });
    reg.checked_in_at = null;
    reg.checked_in_via = null;
    await store.save(reg);
    res.json({ ok: true, registration: adminView(reg) });
  });

  app.post('/api/gestion/resend', guard, async (req, res) => {
    const reg = await store.load(String(req.body?.id || ''));
    if (!reg || reg.status !== 'paid') return res.status(404).json({ ok: false, error: 'not_found' });
    const result = await resendInvitation(reg);
    res.json({ ok: !result.error, error: result.error || null, via: result.via || null });
  });

  /* Rappels de secours : envoi manuel, seulement la veille ou le jour même (jamais « C'est demain » trop tôt). */
  app.post('/api/gestion/reminders', guard, async (req, res) => {
    const w = reminderWindow();
    if (w.today !== w.sends_on && w.today !== w.event_day) {
      return res.status(409).json({ ok: false, error: 'too_early', sends_on: w.sends_on });
    }
    const result = await sendReminders('live');
    res.json({ ok: true, sent: result.sent.length, failed: result.failed.length, remaining: result.remaining });
  });

  /* ---------- Invités : ajout, correction, annulation ---------- */

  function guestFields(body) {
    const f = {
      first_name: properName(body.first_name),
      last_name: properName(body.last_name),
      email: clean(body.email, 120).toLowerCase(),
      phone: clean(body.phone, 30),
      company: clean(body.company, 120),
      role: clean(body.role, 80),
      sector: clean(body.sector, 60),
      note: String(body.note ?? '').trim().slice(0, 600),
    };
    const errors = {};
    if (!f.first_name) errors.first_name = 'required';
    if (f.email && !EMAIL_RE.test(f.email)) errors.email = 'invalid';
    return { f, errors };
  }

  /* Ajout par l'organisateur : invité payé sur place (10 €) ou invité gratuit. */
  app.post('/api/gestion/guests', guard, async (req, res) => {
    const body = req.body || {};
    const { f, errors } = guestFields(body);
    if (!f.last_name) errors.last_name = 'required';
    if (body.send && !f.email) errors.email = 'required';
    if (Object.keys(errors).length) return res.status(400).json({ ok: false, error: 'invalid_fields', fields: errors });
    const kind = body.kind === 'free' ? 'free' : 'onsite';
    const all = await store.listAll();
    if (f.email && !body.force && all.some((r) => isLive(r) && r.status === 'paid' && String(r.email).toLowerCase() === f.email)) {
      return res.status(409).json({ ok: false, error: 'already_registered' });
    }
    const taken = all.filter((r) => isLive(r) && (r.status === 'paid' || r.status === 'review')).length;
    if (taken >= maxPaidSeats() && !body.force) return res.status(409).json({ ok: false, error: 'full', max: maxPaidSeats() });
    const now = new Date().toISOString();
    const reg = {
      id: newId(), token: newToken(), status: 'paid', pay_mode: 'live', provider: 'manual', payment_kind: kind,
      amount_cents: kind === 'free' ? 0 : 1000, created_at: now, paid_at: now, added_by_admin: true, ...f,
    };
    if (body.checkin) { reg.checked_in_at = now; reg.checked_in_via = 'manual'; }
    await store.save(reg);
    let email = null;
    if (body.send && reg.email) email = await resendInvitation(reg);
    res.json({ ok: true, registration: adminView(reg), email });
  });

  /* Correction des coordonnées (faute de frappe, nouvelle adresse e-mail…) et note interne. */
  app.post('/api/gestion/guests/update', guard, async (req, res) => {
    const reg = await store.load(String(req.body?.id || ''));
    if (!reg) return res.status(404).json({ ok: false, error: 'not_found' });
    const { f, errors } = guestFields({ ...reg, ...req.body });
    if (reg.status !== 'partner' && !f.last_name) errors.last_name = 'required';
    if (Object.keys(errors).length) return res.status(400).json({ ok: false, error: 'invalid_fields', fields: errors });
    Object.assign(reg, f, { updated_at: new Date().toISOString() });
    await store.save(reg);
    res.json({ ok: true, registration: adminView(reg) });
  });

  /* Annuler une inscription (libère la place ; le remboursement se fait dans CAWL) ou la rétablir. */
  app.post('/api/gestion/guests/status', guard, async (req, res) => {
    const reg = await store.load(String(req.body?.id || ''));
    if (!reg || reg.status === 'partner') return res.status(404).json({ ok: false, error: 'not_found' });
    if (req.body?.action === 'cancel') {
      if (reg.status !== 'paid') return res.status(409).json({ ok: false, error: 'not_paid' });
      reg.status = 'cancelled';
      reg.cancelled_by_admin_at = new Date().toISOString();
    } else if (req.body?.action === 'pay_onsite') {
      // À l'entrée : la personne n'a pas finalisé son paiement en ligne et règle sur place.
      if (!['pending', 'cancelled', 'failed'].includes(reg.status)) return res.status(409).json({ ok: false, error: 'already_paid' });
      const now = new Date().toISOString();
      Object.assign(reg, {
        status: 'paid', provider: 'manual', payment_kind: 'onsite', amount_cents: 1000, pay_mode: reg.pay_mode || 'live',
        paid_at: now, checked_in_at: req.body?.checkin === false ? reg.checked_in_at || null : now, checked_in_via: 'manual',
        cancelled_by_admin_at: null,
      });
    } else if (req.body?.action === 'restore') {
      if (reg.status !== 'cancelled' || !reg.paid_at) return res.status(409).json({ ok: false, error: 'cannot_restore' });
      reg.status = 'paid';
      reg.cancelled_by_admin_at = null;
    } else {
      return res.status(400).json({ ok: false, error: 'bad_action' });
    }
    await store.save(reg);
    res.json({ ok: true, registration: adminView(reg) });
  });

  /* ---------- Invitations partenaires : attribution d'un code et envoi par e-mail ---------- */

  async function partnersList(list) {
    const all = list || await store.listAll();
    const out = [];
    for (let n = 1; n <= PARTNER_INVITES; n += 1) {
      const reg = all.find((r) => r.id === partnerId(n));
      const named = reg && reg.first_name && reg.first_name !== 'Invité partenaire';
      out.push({
        n, code: `BC-PART-${String(n).padStart(2, '0')}`, id: partnerId(n),
        first_name: named ? reg.first_name : '', last_name: named ? reg.last_name || '' : '',
        email: reg?.email || '', company: named ? reg.company || '' : '', role: reg?.role || '',
        sent_at: reg?.partner_sent_at || null, error: reg?.partner_error || null, checked_in_at: reg?.checked_in_at || null,
      });
    }
    return out;
  }

  function partnerNum(v) {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= PARTNER_INVITES ? n : null;
  }

  app.post('/api/gestion/partners', guard, async (req, res) => {
    const n = partnerNum(req.body?.n);
    if (!n) return res.status(400).json({ ok: false, error: 'bad_code' });
    const f = {
      first_name: properName(req.body?.first_name),
      last_name: properName(req.body?.last_name),
      email: clean(req.body?.email, 120).toLowerCase(),
      company: clean(req.body?.company, 120),
      role: clean(req.body?.role, 80),
    };
    const errors = {};
    if (!f.first_name) errors.first_name = 'required';
    if (f.email && !EMAIL_RE.test(f.email)) errors.email = 'invalid';
    if (Object.keys(errors).length) return res.status(400).json({ ok: false, error: 'invalid_fields', fields: errors });
    const id = partnerId(n);
    const reg = (await store.load(id)) || { id, status: 'partner', created_at: new Date().toISOString(), amount_cents: 0 };
    if (reg.email !== f.email) { reg.partner_sent_at = null; reg.partner_error = null; }
    Object.assign(reg, f, { partner_number: n, assigned_at: reg.assigned_at || new Date().toISOString() });
    if (!reg.token) reg.token = newToken();
    await store.save(reg);
    res.json({ ok: true, partners: await partnersList() });
  });

  app.post('/api/gestion/partners/send', guard, async (req, res) => {
    const n = partnerNum(req.body?.n);
    const reg = n ? await store.load(partnerId(n)) : null;
    if (!reg || !reg.email) return res.status(400).json({ ok: false, error: 'no_email' });
    const result = await sendPartnerInvitation(reg, `BC-PART-${String(n).padStart(2, '0')}`);
    res.json({ ok: !result.error, error: result.error || null, via: result.via || null, partners: await partnersList() });
  });

  /* Libérer un code attribué par erreur (seulement s'il n'a pas encore servi à l'entrée). */
  app.post('/api/gestion/partners/clear', guard, async (req, res) => {
    const n = partnerNum(req.body?.n);
    const reg = n ? await store.load(partnerId(n)) : null;
    if (reg?.checked_in_at) return res.status(409).json({ ok: false, error: 'already_used' });
    if (reg) await store.remove(reg.id);
    res.json({ ok: true, partners: await partnersList() });
  });

  /* ---------- E-mails : message groupé aux participants ---------- */

  function readMessage(body) {
    return {
      subject: String(body?.subject || '').trim().slice(0, 150),
      body: String(body?.body || '').trim().slice(0, 6000),
      withInvitation: body?.withInvitation === true,
    };
  }

  app.post('/api/gestion/messages/preview', guard, async (req, res) => {
    const msg = readMessage(req.body);
    const mail = messageEmail(SAMPLE, {
      subject: msg.subject || 'Objet du message', body: msg.body || 'Votre message apparaîtra ici.', withInvitation: msg.withInvitation,
    });
    res.json({ ok: true, subject: mail.subject, html: mail.html });
  });

  /**
   * Envoi : { subject, body, audience, campaign, withInvitation, includeTest } ou { …, testTo } pour un essai.
   * Par lots, dans le temps imparti ; chaque destinataire ne reçoit une campagne qu'une fois (relancer = reprendre).
   */
  app.post('/api/gestion/messages/send', guard, async (req, res) => {
    const msg = readMessage(req.body);
    if (!msg.subject || !msg.body) return res.status(400).json({ ok: false, error: 'empty_message' });
    const testTo = String(req.body?.testTo || '').trim().toLowerCase();
    if (testTo) {
      if (!EMAIL_RE.test(testTo)) return res.status(400).json({ ok: false, error: 'invalid_email' });
      const r = await sendMessage(SAMPLE, { ...msg, subject: `[Essai] ${msg.subject}` }, { to: testTo });
      return res.json({ ok: true, test: true, via: r.via || null });
    }
    const audience = AUDIENCES[req.body?.audience];
    const campaign = String(req.body?.campaign || '');
    if (!audience) return res.status(400).json({ ok: false, error: 'bad_audience' });
    if (!/^[a-z0-9-]{6,40}$/.test(campaign)) return res.status(400).json({ ok: false, error: 'bad_campaign' });
    const includeTest = req.body?.includeTest === true;
    const todo = (await store.listAll()).filter((r) => (includeTest || isLive(r)) && r.email && audience.test(r)
      && !(r.messages_sent || []).some((m) => m.id === campaign));
    const started = Date.now();
    const sent = []; const failed = [];
    let next = 0;
    async function worker() {
      while (next < todo.length && Date.now() - started < 20000) {
        const reg = todo[next]; next += 1;
        try {
          await sendMessage(reg, msg);
          reg.messages_sent = [...(reg.messages_sent || []), { id: campaign, subject: msg.subject, at: new Date().toISOString() }];
          await store.save(reg);
          sent.push(reg.id);
        } catch (err) {
          failed.push({ id: reg.id, error: err.message });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
    res.json({ ok: true, sent: sent.length, failed: failed.length, failures: failed, remaining: todo.length - next });
  });

  app.get('/api/gestion/export.csv', guard, async (req, res) => {
    const all = (await listFor(req.query.test === '1')).filter((r) => r.status === 'paid' || r.status === 'partner');
    const cols = [
      ['Référence', 'id'], ['Nom', 'last_name'], ['Prénom', 'first_name'], ['Entreprise', 'company'], ['Fonction', 'role'],
      ['E-mail', 'email'], ['Téléphone', 'phone'], ['Activité', 'activity'], ['Secteur', 'sector'], ['Site / LinkedIn', 'website'],
      ['Recherche', 'looking'], ['Peut apporter', 'offer'], ['Payé le', 'paid_at'], ['Arrivé à', 'checked_in_at'],
      ['Origine', 'origin'], ['Note', 'note'],
    ];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = all.sort((a, b) => String(a.last_name).localeCompare(String(b.last_name), 'fr'))
      .map((r) => ({ ...r, origin: { onsite: 'Payé sur place', free: 'Invité gratuit', partner: 'Partenaire', online: 'En ligne' }[adminView(r).source] }))
      .map((r) => cols.map(([, k]) => q(r[k])).join(';'));
    res.set('Content-Disposition', 'attachment; filename="inscrits-business-club.csv"')
      .set('Cache-Control', 'no-store')
      .type('text/csv; charset=utf-8')
      .send(`﻿${[cols.map(([h]) => q(h)).join(';'), ...rows].join('\r\n')}`);
  });
}

module.exports = { mount, partnerNumber, isAuthed };
