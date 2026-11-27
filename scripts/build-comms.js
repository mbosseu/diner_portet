'use strict';

/**
 * Génère les supports de communication à partir des informations de l'événement (server/lib/config.js) :
 *  - communication/newsletter-brevo.html : à importer dans Brevo (balises {{ mirror }} et {{ unsubscribe }})
 *  - public/comms/newsletter.html        : version en ligne (« Voir dans le navigateur »)
 *  - communication/invitations-partenaires.html : 10 invitations partenaires numérotées (A5, à imprimer)
 *
 * Après un changement d'heure ou d'adresse : `npm run comms`, puis `npm run comms:pdf` pour le PDF.
 */

const fs = require('fs');
const path = require('path');
const { EVENT } = require('../server/lib/config');

const SITE = 'https://dinerportet.vercel.app';
const SIGNUP = `${SITE}/inscription`;
const ROOT = path.join(__dirname, '..');
const PARTNER_INVITES = 10;

const SERIF = "'Cormorant Garamond', Garamond, Georgia, 'Times New Roman', serif";
const SANS = "Manrope, 'Helvetica Neue', Arial, sans-serif";
const C = { black: '#0b0b0a', charcoal: '#191815', gold: '#c4a46a', ivory: '#eae5da', muted: '#b9b2a6', dim: '#8f8a80', faint: '#6f6a62', line: '#4a3f2c' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const time = (t) => String(t).replace(':', ' h ');
const startLabel = time(EVENT.startTime);
const lunchLabel = time(EVENT.lunchTime);
const price = (EVENT.priceCents / 100).toFixed(0);

/* ---------------- Newsletter ---------------- */

function newsletter({ web }) {
  const IMG = web ? "/assets/mail" : `${SITE}/assets/mail`;
  const LNUM = "font-variant-numeric:lining-nums;font-feature-settings:'lnum' 1;";
  const mirror = web ? '' : `<a href="{{ mirror }}" style="color:${C.faint};text-decoration:underline;">Voir dans le navigateur</a>`;
  const unsubscribe = web ? '' : `<br><br><a href="{{ unsubscribe }}" style="color:${C.faint};text-decoration:underline;">Se désinscrire</a>`;
  const [weekday, ...rest] = EVENT.dateLabel.split(' '); // « Vendredi 4 décembre 2026 »
  const day = String(rest[0]).padStart(2, '0');
  const monthYear = rest.slice(1).join(' ');

  const spacer = (h) => `<div style="height:${h}px;line-height:${h}px;font-size:${h}px;">&nbsp;</div>`;
  const cta = (label = 'Je m’inscris') => `
    <table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>
      <td bgcolor="${C.gold}" style="background:${C.gold};">
        <a href="${SIGNUP}" style="display:inline-block;padding:18px 44px;font-family:${SANS};font-size:13px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:${C.black};text-decoration:none;">${label}</a>
      </td>
    </tr></table>`;
  const eyebrow = (t, align = 'left') => `<div style="text-align:${align};font-family:${SANS};font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:${C.gold};">${t}</div>`;
  const para = (t, extra = '') => `<p style="margin:0 0 16px;font-family:${SANS};font-size:15px;line-height:26px;color:${C.muted};${extra}">${t}</p>`;
  const rule = (w = 70, align = 'left') => `<table role="presentation" cellpadding="0" cellspacing="0" align="${align}" style="margin:0 ${align === 'center' ? 'auto' : '0'};"><tr><td width="${w}" height="1" bgcolor="${C.gold}" style="width:${w}px;height:1px;line-height:1px;font-size:1px;background:${C.gold};">&nbsp;</td></tr></table>`;
  const fullRule = `<tr><td class="px" style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td height="1" bgcolor="${C.line}" style="height:1px;line-height:1px;font-size:1px;background:${C.line};">&nbsp;</td></tr></table></td></tr>`;

  const step = (num, title, text) => `
    <tr>
      <td valign="top" width="64" style="padding:0 0 30px;font-family:${SERIF};font-style:italic;font-size:34px;line-height:34px;color:${C.gold};">${num}</td>
      <td valign="top" style="padding:2px 0 30px 22px;border-left:1px solid ${C.line};">
        <div style="font-family:${SERIF};font-size:26px;line-height:30px;color:${C.ivory};">${title}</div>
        <div style="font-family:${SANS};font-size:14px;line-height:24px;color:${C.muted};margin-top:8px;">${text}</div>
      </td>
    </tr>`;

  const info = (label, value, sub = '') => `
    <tr>
      <td valign="top" width="128" style="padding:16px 0;border-top:1px solid ${C.line};font-family:${SANS};font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${C.gold};line-height:24px;">${label}</td>
      <td valign="top" style="padding:16px 0;border-top:1px solid ${C.line};${LNUM}font-family:${SERIF};font-size:21px;line-height:25px;color:${C.ivory};">${value}${sub ? `<div style="font-family:${SANS};font-size:13px;line-height:20px;color:${C.dim};margin-top:3px;">${sub}</div>` : ''}</td>
    </tr>`;

  return `<!doctype html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>Business Club · Rencontre Entrepreneurs · 4 décembre</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;1,500&family=Manrope:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  body { margin:0; padding:0; background:${C.black}; }
  a { color:${C.gold}; }
  @media (max-width: 620px) {
    .px { padding-left:24px !important; padding-right:24px !important; }
    .h1 { font-size:50px !important; line-height:50px !important; }
    .day { font-size:110px !important; line-height:96px !important; }
    .price { font-size:68px !important; line-height:68px !important; }
    .quote { font-size:26px !important; line-height:34px !important; }
    .gal { width:49% !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.black};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.black};">${esc(weekday)} ${day} ${esc(monthYear)} au Boxing Center : initiation boxe à ${startLabel}, déjeuner, rencontres entre entrepreneurs. ${price} €, déjeuner compris.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.black}" style="background:${C.black};">
<tr><td align="center" style="padding:18px 10px 48px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">

  ${mirror ? `<tr><td align="right" style="padding:0 6px 14px;font-family:${SANS};font-size:10px;color:${C.faint};">${mirror}</td></tr>` : ''}

  <!-- Bandeau -->
  <tr><td align="center" style="padding:8px 20px 30px;">
    ${rule(36, 'center')}
    ${spacer(16)}
    <div style="font-family:${SANS};font-size:10px;letter-spacing:3.5px;text-transform:uppercase;color:${C.dim};">Boxing Center</div>
    <div style="font-family:${SERIF};font-style:italic;font-size:34px;line-height:40px;color:${C.ivory};margin-top:2px;">Business Club</div>
    <div style="font-family:${SANS};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${C.gold};margin-top:8px;">Rencontre Entrepreneurs · N°&nbsp;01</div>
  </td></tr>

  <!-- Visuel -->
  <tr><td style="border-top:1px solid #6b5a3a;border-bottom:1px solid #6b5a3a;">
    <a href="${SIGNUP}"><img src="${IMG}/nl-hero.jpg" width="600" alt="Gants de boxe lacés d’or et coupe de champagne sur une table dressée, devant le ring" style="display:block;width:100%;max-width:600px;height:auto;border:0;background:${C.charcoal};"></a>
  </td></tr>

  <!-- Accroche -->
  <tr><td class="px" bgcolor="${C.charcoal}" style="background:${C.charcoal};padding:50px 44px 52px;">
    ${eyebrow('Première édition · Déjeuner d’affaires')}
    <div class="h1" style="font-family:${SERIF};font-size:62px;line-height:60px;color:${C.ivory};margin:20px 0 28px;">Le ring<br><em style="color:${C.gold};">des affaires</em></div>
    ${rule(70)}
    ${spacer(28)}
    ${para('Un midi, on enfile les gants avant de serrer des mains. On partage une table, des idées, des ambitions. Et chaque rencontre peut devenir un partenariat.', `font-family:${SERIF};font-size:22px;line-height:31px;color:${C.ivory};`)}
    ${para(`Le Business Club du Boxing Center vous convie à sa première <span style="color:${C.ivory};">Rencontre Entrepreneurs</span> : une initiation à la boxe, un déjeuner, et un temps de rencontres entre entrepreneurs, adhérents, partenaires et sponsors.`)}
    ${spacer(14)}
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="${C.gold}" style="background:${C.gold};">
      <a href="${SIGNUP}" style="display:inline-block;padding:18px 44px;font-family:${SANS};font-size:13px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:${C.black};text-decoration:none;">Je m’inscris</a>
    </td></tr></table>
  </td></tr>

  <!-- Date, façon affiche -->
  <tr><td align="center" class="px" style="padding:62px 40px 56px;">
    ${eyebrow(esc(weekday), 'center')}
    <div class="day" style="${LNUM}font-family:${SERIF};font-size:150px;line-height:128px;color:${C.ivory};margin-top:14px;">${day}</div>
    <div style="font-family:${SERIF};font-style:italic;font-size:30px;line-height:36px;color:${C.gold};">${esc(monthYear)}</div>
    ${spacer(24)}
    ${rule(36, 'center')}
    ${spacer(22)}
    <div style="${LNUM}font-family:${SANS};font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${C.muted};line-height:22px;">Dès ${esc(startLabel)} · ${esc(EVENT.venue)}<br><span style="color:${C.dim};">${esc(EVENT.address)}</span></div>
  </td></tr>

  ${fullRule}

  <!-- Le Business Club -->
  <tr><td class="px" style="padding:50px 44px 14px;">
    ${eyebrow('Le Business Club')}
    <div style="font-family:${SERIF};font-size:38px;line-height:41px;color:${C.ivory};margin:16px 0 22px;">Un cercle d’entrepreneurs,<br><em style="color:${C.gold};">né sur le ring.</em></div>
    ${para('Au Boxing Center, dirigeants, artisans, commerçants, indépendants et salariés s’entraînent côte à côte chaque semaine. Le Business Club leur donne un rendez-vous pour se rencontrer autrement : sans badge, sans pitch forcé, autour de valeurs que la boxe connaît bien — l’engagement, le respect, la confiance.')}
    ${para('À l’inscription, chacun indique ce qu’il recherche et ce qu’il peut apporter. Nous nous en servons pour provoquer les bonnes rencontres pendant le déjeuner.')}
  </td></tr>

  <!-- Galerie -->
  <tr><td class="px" style="padding:20px 44px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td class="gal" width="49%" valign="top" style="width:49%;"><img src="${IMG}/nl-diner.jpg" width="250" alt="Dîner du Business Club, entrepreneurs attablés devant le ring" style="display:block;width:100%;height:auto;border:0;background:${C.charcoal};"></td>
      <td width="2%" style="width:2%;font-size:1px;">&nbsp;</td>
      <td class="gal" width="49%" valign="top" style="width:49%;"><img src="${IMG}/nl-ceintures.jpg" width="250" alt="Ceintures de champion exposées en vitrine" style="display:block;width:100%;height:auto;border:0;background:${C.charcoal};"></td>
    </tr></table>
  </td></tr>

  <!-- Programme -->
  <tr><td class="px" style="padding:56px 44px 10px;">
    ${eyebrow('Le programme')}
    ${spacer(28)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${step('I.', `Initiation boxe <span style="font-family:${SANS};font-size:12px;letter-spacing:2px;color:${C.gold};${LNUM}">&nbsp;${startLabel}</span>`, 'Une séance encadrée par nos coachs, accessible à tous les niveaux, même sans jamais avoir boxé. Le meilleur moyen de briser la glace.')}
      ${step('II.', `Le déjeuner <span style="font-family:${SANS};font-size:12px;letter-spacing:2px;color:${C.gold};${LNUM}">&nbsp;${lunchLabel}</span>`, 'À table, entre entrepreneurs. Le repas est compris dans votre participation.')}
      ${step('III.', `Rencontres &amp; networking <span style="font-family:${SANS};font-size:12px;letter-spacing:2px;color:${C.gold};">&nbsp;ENSUITE</span>`, 'Échanger, se présenter, trouver un client, un fournisseur, un associé — ou simplement de bons contacts près de chez soi.')}
    </table>
  </td></tr>

  <!-- Citation -->
  <tr><td align="center" class="px" bgcolor="${C.charcoal}" style="background:${C.charcoal};padding:52px 50px;">
    <div style="font-family:${SERIF};font-size:54px;line-height:30px;color:${C.gold};">“</div>
    <div class="quote" style="font-family:${SERIF};font-style:italic;font-size:31px;line-height:40px;color:${C.ivory};margin-top:6px;">Sur le ring comme en affaires,<br>tout commence par une poignée de main.</div>
    ${spacer(22)}
    ${rule(36, 'center')}
  </td></tr>

  <!-- Infos pratiques -->
  <tr><td class="px" style="padding:56px 44px 6px;">
    ${eyebrow('Informations pratiques')}
    ${spacer(18)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${info('Date', esc(EVENT.dateLabel))}
      ${info('Programme', `${esc(startLabel)} · initiation boxe`, `${esc(lunchLabel)} déjeuner, puis networking`)}
      ${info('Lieu', esc(EVENT.venue), esc(EVENT.address))}
      ${info('Tenue', 'Souple pour l’initiation', 'Baskets et tenue de sport')}
      ${info('Participation', `${price} € par personne`, 'Déjeuner compris · paiement en ligne à l’inscription')}
    </table>
  </td></tr>

  <!-- Réservation -->
  <tr><td class="px" style="padding:40px 44px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #6b5a3a;">
      <tr><td style="padding:6px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};">
          <tr><td align="center" style="padding:44px 26px 46px;">
            ${eyebrow('Places limitées', 'center')}
            <div class="price" style="${LNUM}font-family:${SERIF};font-size:84px;line-height:84px;color:${C.ivory};margin:18px 0 6px;">${price}&nbsp;€</div>
            <div style="font-family:${SERIF};font-style:italic;font-size:20px;color:${C.muted};">par personne, déjeuner compris</div>
            <div style="font-family:${SANS};font-size:13px;line-height:22px;color:${C.dim};margin:22px auto 30px;max-width:400px;">
              Réservé aux adhérents du Boxing Center. Inscription et paiement en ligne en quelques clics ; votre invitation officielle avec QR code vous est envoyée aussitôt par e-mail.
            </div>
            ${cta()}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </td></tr>

  <!-- Pied -->
  <tr><td align="center" style="padding:44px 30px 0;">
    ${rule(36, 'center')}
    ${spacer(18)}
    <div style="font-family:${SERIF};font-style:italic;font-size:20px;color:${C.ivory};">Business Club</div>
    <div style="font-family:${SANS};font-size:11px;line-height:19px;color:${C.faint};margin-top:8px;">
      ${esc(EVENT.venue)} · ${esc(EVENT.address)}<br>
      Une question ? Répondez simplement à cet e-mail.
      ${unsubscribe}
    </div>
  </td></tr>

</table>
</td></tr></table>
</body>
</html>
`;
}

/* ---------------- Invitations partenaires ---------------- */

function invitations(imgBase) {
  const card = (n) => {
    const num = String(n).padStart(2, '0');
    return `
  <section class="page">
    <div class="frame"><div class="inner">
      <header>
        <div class="brand">Boxing Center<br><span>Business Club</span></div>
        <div class="no">Invitation partenaire<br><b>N° ${num} / ${String(PARTNER_INVITES).padStart(2, '0')}</b></div>
      </header>

      <div class="photo"><img src="${imgBase}/nl-hero.jpg" alt=""></div>
      <p class="lead">Le Business Club du Boxing Center a le plaisir de vous convier à sa</p>
      <h1>Rencontre<br><em>Entrepreneurs</em></h1>
      <div class="rule"></div>
      <p class="prog">Initiation boxe · Déjeuner · Rencontres</p>

      <div class="guest">
        <span>Au nom de</span>
        <i></i>
      </div>

      <dl>
        <div><dt>Date</dt><dd>${esc(EVENT.dateLabel.replace(/ (\d{4})$/, ''))}<small>${esc(EVENT.dateLabel.slice(-4))}</small></dd></div>
        <div><dt>Programme</dt><dd>${esc(startLabel)}<small>${esc(lunchLabel)} déjeuner</small></dd></div>
        <div><dt>Lieu</dt><dd>${esc(EVENT.venue)}<small>${esc(EVENT.address)}</small></dd></div>
      </dl>

      <footer>
        <div class="code">BC-PART-${num}</div>
        <div class="note">Offerte par le Business Club · Valable pour une personne<br>À présenter à l’entrée</div>
      </footer>
    </div></div>
  </section>`;
  };

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invitations partenaires · Business Club · 4 décembre</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;1,500&family=Manrope:wght@400;600&display=swap" rel="stylesheet">
<style>
  @page { size: 148mm 210mm; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; background: #2a2925; }
  body { font-family: ${SANS}; color: ${C.ivory}; }
  .page { width: 148mm; height: 210mm; margin: 10mm auto; background: ${C.black}; padding: 9mm; page-break-after: always; break-after: page; }
  .frame { height: 100%; border: 0.35mm solid #6b5a3a; padding: 2.2mm; }
  .inner { height: 100%; border: 0.2mm solid ${C.line}; padding: 9mm 10mm 7mm; display: flex; flex-direction: column; }
  header { display: flex; justify-content: space-between; align-items: flex-start; }
  .brand { font-size: 7pt; letter-spacing: 0.18em; text-transform: uppercase; color: ${C.dim}; line-height: 1.5; }
  .brand span { font-family: ${SERIF}; font-style: italic; font-size: 15pt; letter-spacing: 0; text-transform: none; color: ${C.ivory}; }
  .no { text-align: right; font-size: 6.5pt; letter-spacing: 0.18em; text-transform: uppercase; color: ${C.dim}; line-height: 1.7; }
  .no b { font-weight: 600; color: ${C.gold}; }
  .photo { margin: 8mm 0 0; height: 36mm; border: 0.2mm solid #6b5a3a; overflow: hidden; }
  .photo img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 60% 55%; }
  .lead { font-family: ${SERIF}; font-style: italic; font-size: 12pt; line-height: 1.35; color: ${C.muted}; margin: 8mm 0 3mm; max-width: 95mm; }
  h1 { font-family: ${SERIF}; font-weight: 500; font-size: 36pt; line-height: 0.98; margin: 0; color: ${C.ivory}; }
  h1 em { color: ${C.gold}; }
  .rule { width: 26mm; height: 0.3mm; background: ${C.gold}; margin: 6mm 0 4mm; }
  .prog { font-size: 7.5pt; letter-spacing: 0.2em; text-transform: uppercase; color: ${C.gold}; margin: 0; }
  .guest { display: flex; align-items: flex-end; gap: 4mm; margin: 8mm 0 0; }
  .guest span { font-size: 6.5pt; letter-spacing: 0.18em; text-transform: uppercase; color: ${C.dim}; white-space: nowrap; }
  .guest i { flex: 1; border-bottom: 0.2mm solid #6b5a3a; height: 7mm; }
  dl { display: grid; grid-template-columns: 1.35fr 0.75fr 1.1fr; gap: 4mm; margin: 7mm 0 6mm; }
  dt { font-size: 6.5pt; letter-spacing: 0.18em; text-transform: uppercase; color: ${C.gold}; margin-bottom: 1.5mm; }
  dd { margin: 0; font-variant-numeric: lining-nums; font-feature-settings: 'lnum' 1; font-family: ${SERIF}; font-size: 11.5pt; line-height: 1.2; color: ${C.ivory}; }
  dd small { display: block; font-family: ${SANS}; font-size: 7pt; color: ${C.dim}; margin-top: 1mm; }
  footer { margin-top: auto; padding-top: 5mm; border-top: 0.2mm dashed #6b5a3a; display: flex; justify-content: space-between; align-items: flex-end; }
  .code { font-size: 9pt; letter-spacing: 0.2em; color: ${C.gold}; }
  .note { text-align: right; font-family: ${SERIF}; font-style: italic; font-size: 9.5pt; line-height: 1.35; color: ${C.dim}; }
  @media print { html, body { background: ${C.black}; } .page { margin: 0; } }
</style>
</head>
<body>
${Array.from({ length: PARTNER_INVITES }, (_, i) => card(i + 1)).join('\n')}
</body>
</html>
`;
}

function write(rel, content) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  console.log('écrit', rel);
}

write('communication/newsletter-brevo.html', newsletter({ web: false }));
write('server/templates/newsletter-brevo.html', newsletter({ web: false })); // envoyée depuis le back-office (campagne Brevo)
write('public/comms/newsletter.html', newsletter({ web: true }));
write('communication/invitations-partenaires.html', invitations('../public/assets/mail'));
write('public/comms/_preview-invitations.html', invitations('/assets/mail'));
