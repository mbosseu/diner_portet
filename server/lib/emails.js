'use strict';

/**
 * Gabarits des e-mails (HTML compatible messageries : tableaux et styles en ligne).
 * Charte : noir #0b0b0a, charbon #191815, or #c4a46a, ivoire #eae5da.
 */

const crypto = require('crypto');
const { EVENT, publicUrl } = require('./config');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** « 11:30 » → « 11 h 30 » */
const time = (t) => String(t || '').replace(':', ' h ');

const SERIF = "'Cormorant Garamond', Garamond, Georgia, 'Times New Roman', serif";
const SANS = "Manrope, 'Helvetica Neue', Arial, sans-serif";

function layout({ preheader, body }) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<title>${esc(EVENT.name)}</title>
<style>
  /* iPhone et Gmail transforment adresses et dates en liens bleus : on garde la charte. */
  a[x-apple-data-detectors], u + #body a, #MessageViewBody a { color: inherit !important; text-decoration: none !important; font: inherit !important; }
</style></head>
<body id="body" bgcolor="#0b0b0a" style="margin:0;padding:0;background:#0b0b0a;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0b0b0a" style="background:#0b0b0a;">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
    <tr><td style="padding:0 8px 22px;font-family:${SANS};font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8f8a80;">
      Boxing Center<br><span style="font-family:${SERIF};font-style:italic;font-size:22px;letter-spacing:0;text-transform:none;color:#eae5da;">Business Club</span>
    </td></tr>
    ${body}
    <tr><td style="padding:26px 8px 0;font-family:${SANS};font-size:11px;line-height:18px;color:#6f6a62;">
      Business Club · Boxing Center, ${esc(EVENT.address)}<br>
      Une question ? Répondez simplement à cet e-mail.
      <!-- Marqueur unique : empêche Gmail de masquer l'e-mail (« ••• ») quand un envoi ressemble au précédent -->
      <span style="color:#0b0b0a;font-size:1px;line-height:1px;">${crypto.randomBytes(6).toString('hex')}</span>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

/** Bloc date / programme / lieu : deux colonnes puis le lieu sur toute la largeur (lisible sur téléphone). */
function details() {
  const nb = (t) => esc(t).replace(/ /g, '&nbsp;');
  const sub = (t) => `<div style="font-family:${SANS};font-size:12px;line-height:18px;color:#8f8a80;margin-top:2px;">${t}</div>`;
  const cell = (label, value, attrs = '') => `
    <td valign="top" ${attrs} style="padding:0 12px 16px 0;">
      <div style="font-family:${SANS};font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#c4a46a;">${label}</div>
      <div style="font-family:${SERIF};font-size:19px;line-height:24px;color:#eae5da;margin-top:4px;">${value}</div>
    </td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      ${cell('Date', `${esc(EVENT.dateLabel.replace(/ \d{4}$/, '')).replace(/ (\d+) /, ' $1&nbsp;')}${sub(EVENT.dateLabel.slice(-4))}`, 'width="50%"')}
      ${cell('Programme', `${nb(time(EVENT.startTime))}${sub(`Initiation boxe<br>${nb(`Déjeuner à ${time(EVENT.lunchTime)}`)}`)}`, 'width="50%"')}
    </tr>
    <tr>
      ${cell('Lieu', `${esc(EVENT.venue)}${sub(esc(EVENT.address).replace(/, /, ',&#8203; '))}`, 'colspan="2"')}
    </tr>
  </table>`;
}

function invitationLinks(reg) {
  const base = publicUrl();
  return {
    view: `${base}/inscription?id=${encodeURIComponent(reg.id)}&t=${encodeURIComponent(reg.token)}`,
    ics: `${base}/api/registrations/${encodeURIComponent(reg.id)}/calendar.ics?t=${encodeURIComponent(reg.token)}`,
    qr: `${base}/api/registrations/${encodeURIComponent(reg.id)}/qr.png?t=${encodeURIComponent(reg.token)}`,
  };
}

function button(href, label) {
  // Bouton plein (or, texte noir) : lisible aussi quand l'appli mail affiche l'e-mail en clair.
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#c4a46a" style="background:#c4a46a;">
    <a href="${href}" style="display:inline-block;padding:16px 30px;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#0b0b0a;text-decoration:none;">${label}</a>
  </td></tr></table>`;
}

/** E-mail de confirmation + invitation officielle (QR code). */
function confirmationEmail(reg, { qrSrc }) {
  const links = invitationLinks(reg);
  const name = `${esc(reg.first_name)} ${esc(reg.last_name)}`;
  const company = [reg.role, reg.company].filter(Boolean).map(esc).join(' · ');
  const body = `
  <tr><td bgcolor="#191815" style="background:#191815;border:1px solid #6b5a3a;padding:10px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #4a3f2c;">
      <tr><td style="padding:34px 30px 8px;">
        <div style="font-family:${SANS};font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8f8a80;">Invitation nominative · Édition N°01</div>
        <div style="font-family:${SERIF};font-style:italic;font-size:18px;color:#b9b2a6;margin-top:18px;">Le Business Club du Boxing Center a le plaisir de vous convier à sa</div>
        <div style="font-family:${SERIF};font-size:40px;line-height:44px;color:#eae5da;margin-top:8px;">Rencontre <em style="color:#c4a46a;">Entrepreneurs</em></div>
        <div style="height:1px;width:110px;background:#c4a46a;margin:24px 0;"></div>
        <div style="font-family:${SERIF};font-size:28px;color:#eae5da;">${name}</div>
        <div style="font-family:${SANS};font-size:13px;color:#a39d92;margin:6px 0 24px;">${company}</div>
        ${details()}
      </td></tr>
      <tr><td align="center" style="padding:8px 30px 30px;border-top:1px dashed #6b5a3a;">
        <div style="padding-top:26px;">
          <img src="${qrSrc}" width="168" height="168" alt="QR code de votre invitation (également en pièce jointe)" style="display:block;background:#eae5da;padding:10px;">
        </div>
        <div style="font-family:${SANS};font-size:12px;letter-spacing:2px;color:#c4a46a;margin-top:12px;">${esc(reg.id)}</div>
        <div style="font-family:${SERIF};font-style:italic;font-size:15px;color:#8f8a80;margin-top:4px;">À présenter à l'entrée</div>
        <div style="font-family:${SANS};font-size:11px;line-height:17px;color:#8f8a80;margin-top:12px;">QR code invisible ? Il est aussi en pièce jointe<br>et sur <a href="${links.view}" style="color:#c4a46a;">votre invitation en ligne</a>.</div>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:30px 8px 0;font-family:${SANS};font-size:14px;line-height:23px;color:#b9b2a6;">
    Bonjour ${esc(reg.first_name)},<br><br>
    Votre place est confirmée et votre règlement de ${(reg.amount_cents / 100).toFixed(0)} € (déjeuner compris) a bien été reçu.
    Au programme : à ${esc(time(EVENT.startTime))}, initiation boxe encadrée par nos coachs ; à ${esc(time(EVENT.lunchTime))}, déjeuner ; puis un temps de rencontres entre entrepreneurs.<br><br>
    Prévoyez une tenue souple pour l'initiation. Un rappel vous sera envoyé la veille.
  </td></tr>
  <tr><td style="padding:26px 8px 0;">
    ${button(links.view, 'Voir mon invitation')}
  </td></tr>
  <tr><td style="padding:18px 8px 0;">
    <a href="${links.ics}" style="font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#eae5da;text-decoration:underline;">Ajouter à l'agenda</a>
  </td></tr>`;
  return {
    subject: `Votre invitation · ${EVENT.shortName} du 4 décembre`,
    html: layout({ preheader: `Place confirmée. Votre invitation avec QR code pour le ${EVENT.dateLabel}.`, body }),
    text: `Bonjour ${reg.first_name},\n\nVotre place pour la ${EVENT.shortName} est confirmée (${EVENT.dateLabel}, dès ${time(EVENT.startTime)}, ${EVENT.venue}, ${EVENT.address}).\nRéférence : ${reg.id}\nVotre invitation : ${links.view}\n\nBusiness Club · Boxing Center`,
  };
}

/** Invitation offerte à un partenaire (code BC-PART-xx), avec QR code signé. */
function partnerEmail(reg, { qrSrc, code }) {
  const links = invitationLinks(reg);
  const name = [reg.first_name, reg.last_name].filter(Boolean).map(esc).join(' ');
  const company = [reg.role, reg.company].filter(Boolean).map(esc).join(' · ');
  const body = `
  <tr><td bgcolor="#191815" style="background:#191815;border:1px solid #6b5a3a;padding:10px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #4a3f2c;">
      <tr><td style="padding:34px 30px 8px;">
        <div style="font-family:${SANS};font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8f8a80;">Invitation partenaire · Édition N°01</div>
        <div style="font-family:${SERIF};font-style:italic;font-size:18px;color:#b9b2a6;margin-top:18px;">Le Business Club du Boxing Center a le plaisir de vous convier, en tant que partenaire, à sa</div>
        <div style="font-family:${SERIF};font-size:40px;line-height:44px;color:#eae5da;margin-top:8px;">Rencontre <em style="color:#c4a46a;">Entrepreneurs</em></div>
        <div style="height:1px;width:110px;background:#c4a46a;margin:24px 0;"></div>
        <div style="font-family:${SERIF};font-size:28px;color:#eae5da;">${name}</div>
        <div style="font-family:${SANS};font-size:13px;color:#a39d92;margin:6px 0 24px;">${company}</div>
        ${details()}
      </td></tr>
      <tr><td align="center" style="padding:8px 30px 30px;border-top:1px dashed #6b5a3a;">
        <div style="padding-top:26px;">
          <img src="${qrSrc}" width="168" height="168" alt="QR code de votre invitation (également en pièce jointe)" style="display:block;background:#eae5da;padding:10px;">
        </div>
        <div style="font-family:${SANS};font-size:12px;letter-spacing:2px;color:#c4a46a;margin-top:12px;">${esc(code)}</div>
        <div style="font-family:${SERIF};font-style:italic;font-size:15px;color:#8f8a80;margin-top:4px;">À présenter à l'entrée</div>
        <div style="font-family:${SANS};font-size:11px;line-height:17px;color:#8f8a80;margin-top:12px;">QR code invisible ? Il est aussi en pièce jointe.<br>À l'accueil, le code ${esc(code)} suffit également.</div>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:30px 8px 0;font-family:${SANS};font-size:14px;line-height:23px;color:#b9b2a6;">
    Bonjour ${esc(reg.first_name)},<br><br>
    Merci pour votre soutien au Business Club. Vous êtes notre invité(e) : votre déjeuner est offert, aucune inscription ni aucun paiement ne vous est demandé.
    Au programme : à ${esc(time(EVENT.startTime))}, initiation boxe encadrée par nos coachs ; à ${esc(time(EVENT.lunchTime))}, déjeuner ; puis un temps de rencontres entre entrepreneurs.<br><br>
    Prévoyez une tenue souple pour l'initiation. Cette invitation est nominative et valable pour une entrée.
  </td></tr>
  <tr><td style="padding:26px 8px 0;">
    ${button(links.view, 'Voir mon invitation')}
  </td></tr>
  <tr><td style="padding:18px 8px 0;">
    <a href="${links.ics}" style="font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#eae5da;text-decoration:underline;">Ajouter à l'agenda</a>
  </td></tr>`;
  return {
    subject: `Votre invitation partenaire · ${EVENT.shortName} du 4 décembre`,
    html: layout({ preheader: `Vous êtes notre invité(e) le ${EVENT.dateLabel}. Votre invitation avec QR code.`, body }),
    text: `Bonjour ${reg.first_name},\n\nVous êtes notre invité(e), en tant que partenaire, à la ${EVENT.shortName} (${EVENT.dateLabel}, dès ${time(EVENT.startTime)}, ${EVENT.venue}, ${EVENT.address}).\nVotre code d'entrée : ${code}\n\nBusiness Club · Boxing Center`,
  };
}

/** Rappel envoyé la veille. */
function reminderEmail(reg, { qrSrc }) {
  const links = invitationLinks(reg);
  const body = `
  <tr><td bgcolor="#191815" style="background:#191815;border:1px solid #6b5a3a;padding:34px 30px;">
    <div style="font-family:${SANS};font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#c4a46a;">C'est demain</div>
    <div style="font-family:${SERIF};font-size:36px;line-height:40px;color:#eae5da;margin:14px 0 22px;">On vous attend<br><em style="color:#c4a46a;">demain midi.</em></div>
    ${details()}
    <div style="font-family:${SANS};font-size:14px;line-height:23px;color:#b9b2a6;margin-top:8px;">
      Bonjour ${esc(reg.first_name)}, petit rappel avant la Rencontre Entrepreneurs.<br>
      Initiation boxe à ${esc(time(EVENT.startTime))}, déjeuner à ${esc(time(EVENT.lunchTime))}, puis networking. Pensez à une tenue souple pour l'initiation, et présentez ce QR code à l'entrée.
    </div>
    <div style="padding-top:24px;"><img src="${qrSrc}" width="140" height="140" alt="QR code de votre invitation (également en pièce jointe)" style="display:block;background:#eae5da;padding:8px;"></div>
    <div style="font-family:${SANS};font-size:12px;letter-spacing:2px;color:#c4a46a;margin-top:10px;">${esc(reg.id)}</div>
    <div style="font-family:${SANS};font-size:11px;line-height:17px;color:#8f8a80;margin-top:10px;">QR code invisible ? Il est aussi en pièce jointe et sur <a href="${links.view}" style="color:#c4a46a;">votre invitation en ligne</a>.</div>
  </td></tr>
  <tr><td style="padding:26px 8px 0;">${button(links.view, 'Voir mon invitation')}</td></tr>`;
  return {
    subject: `Rappel · ${EVENT.shortName} demain dès ${time(EVENT.startTime)}`,
    html: layout({ preheader: `C'est demain : ${EVENT.dateLabel}, dès ${time(EVENT.startTime)}.`, body }),
    text: `Bonjour ${reg.first_name},\n\nRappel : la ${EVENT.shortName} a lieu demain, ${EVENT.dateLabel}, dès ${time(EVENT.startTime)} au ${EVENT.venue} (${EVENT.address}).\nVotre invitation : ${links.view}\n\nBusiness Club · Boxing Center`,
  };
}

/**
 * Message libre de l'organisateur (back-office, onglet E-mails), dans la charte des invitations.
 * `body` : texte brut ; une ligne vide sépare les paragraphes ; {prenom} et {nom} sont remplacés.
 */
function messageEmail(reg, { subject, body, withInvitation = false }) {
  const fill = (s) => String(s || '')
    .replace(/\{prenom\}/gi, reg.first_name || '')
    .replace(/\{nom\}/gi, reg.last_name || '')
    .trim();
  const text = fill(body);
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const html = paragraphs.map((p) => `<p style="margin:0 0 16px;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const link = withInvitation && reg.token && (reg.status === 'paid' || reg.status === 'partner') ? invitationLinks(reg).view : null;
  const bodyHtml = `
  <tr><td bgcolor="#191815" style="background:#191815;border:1px solid #6b5a3a;padding:34px 30px 18px;">
    <div style="font-family:${SANS};font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#c4a46a;">${esc(EVENT.shortName)} · ${esc(EVENT.dateLabel)}</div>
    <div style="font-family:${SERIF};font-size:30px;line-height:36px;color:#eae5da;margin:12px 0 22px;">${esc(fill(subject))}</div>
    <div style="font-family:${SANS};font-size:14px;line-height:23px;color:#b9b2a6;">${html}</div>
  </td></tr>
  ${link ? `<tr><td style="padding:26px 8px 0;">${button(link, 'Voir mon invitation')}</td></tr>` : ''}`;
  return {
    subject: fill(subject),
    html: layout({ preheader: paragraphs[0] ? paragraphs[0].slice(0, 120) : fill(subject), body: bodyHtml }),
    text: `${text}${link ? `\n\nVotre invitation : ${link}` : ''}\n\nBusiness Club · Boxing Center`,
  };
}

/** Copie interne pour l'organisateur (préparation du networking). */
function organizerEmail(reg) {
  const rows = [
    ['Nom', `${reg.first_name} ${reg.last_name}`],
    ['E-mail', reg.email],
    ['Téléphone', reg.phone],
    ['Entreprise', reg.company],
    ['Fonction', reg.role],
    ['Activité', reg.activity],
    ['Secteur', reg.sector],
    ['Site / LinkedIn', reg.website || '—'],
    ['Recherche', reg.looking],
    ['Peut apporter', reg.offer],
    ['Référence', reg.id],
  ];
  const html = `<table cellpadding="6" style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse;">
    ${rows.map(([k, v]) => `<tr><td style="color:#666;vertical-align:top;">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}
  </table>`;
  return {
    subject: `Nouvelle inscription · ${reg.first_name} ${reg.last_name} (${reg.company})`,
    html,
    text: rows.map(([k, v]) => `${k} : ${v}`).join('\n'),
  };
}

module.exports = { confirmationEmail, reminderEmail, organizerEmail, messageEmail, partnerEmail, invitationLinks };
