'use strict';

/**
 * Newsletter : listes de contacts et campagnes Brevo (même clé API que les e-mails du site).
 * Brevo gère le lien de désinscription, les désinscrits et les statistiques des campagnes.
 * Les campagnes créées ici portent un nom commençant par « Business Club » pour être retrouvées.
 */

const { apiKey, sender, isBrevoEnabled } = require('./brevo');

const CAMPAIGN_PREFIX = 'Business Club · Newsletter';

function base() {
  return (process.env.BREVO_API_BASE || 'https://api.brevo.com/v3').replace(/\/+$/, '');
}

async function call(method, path, body) {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { 'api-key': apiKey(), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw.slice(0, 200) }; }
  if (!res.ok) {
    const err = new Error(data.message || `Brevo HTTP ${res.status}`);
    err.status = res.status;
    err.code = data.code || null;
    throw err;
  }
  return { status: res.status, data };
}

async function lists() {
  const { data } = await call('GET', '/contacts/lists?limit=50&offset=0&sort=desc');
  return (data.lists || []).map((l) => ({
    id: l.id,
    name: l.name,
    count: l.uniqueSubscribers ?? l.totalSubscribers ?? 0,
  }));
}

/** Nouvelle liste, rangée dans le premier dossier de contacts du compte. */
async function createList(name) {
  const { data: f } = await call('GET', '/contacts/folders?limit=10&offset=0');
  let folderId = (f.folders || [])[0]?.id;
  if (!folderId) folderId = (await call('POST', '/contacts/folders', { name: 'Business Club' })).data.id;
  const { data } = await call('POST', '/contacts/lists', { name, folderId });
  return { id: data.id, name, count: 0 };
}

// Les comptes Brevo français nomment les attributs PRENOM / NOM, les autres FIRSTNAME / LASTNAME.
let attrStyle = null;
const ATTR_STYLES = [
  (fn, ln) => ({ PRENOM: fn, NOM: ln }),
  (fn, ln) => ({ FIRSTNAME: fn, LASTNAME: ln }),
  () => null,
];

/**
 * Ajoute (ou met à jour) un contact dans une liste. Un contact désinscrit reste désinscrit :
 * on ne touche jamais à son statut de désinscription.
 * Retourne 'created' ou 'updated'.
 */
async function addContact({ email, firstName = '', lastName = '', listId }) {
  const order = attrStyle !== null ? [attrStyle, ...[0, 1, 2].filter((i) => i !== attrStyle)] : [0, 1, 2];
  let lastErr = null;
  for (const i of order) {
    const attributes = (firstName || lastName) ? ATTR_STYLES[i](firstName, lastName) : null;
    try {
      const r = await call('POST', '/contacts', { email, listIds: [listId], updateEnabled: true, ...(attributes ? { attributes } : {}) });
      if (attributes) attrStyle = i;
      return r.status === 201 ? 'created' : 'updated';
    } catch (err) {
      lastErr = err;
      // Attribut inconnu dans ce compte : on essaie la convention suivante. Autre erreur : on s'arrête.
      if (!(err.status === 400 && /attribute/i.test(err.message)) || !attributes) throw err;
    }
  }
  throw lastErr;
}

async function campaigns() {
  const { data } = await call('GET', '/emailCampaigns?limit=30&offset=0&sort=desc');
  return (data.campaigns || [])
    .filter((c) => String(c.name || '').startsWith(CAMPAIGN_PREFIX))
    .slice(0, 8)
    .map((c) => {
      const g = c.statistics?.globalStats || {};
      return {
        id: c.id, name: c.name, subject: c.subject, status: c.status,
        sentDate: c.sentDate || c.scheduledAt || c.createdAt || null,
        sent: g.sent ?? g.delivered ?? null, opens: g.uniqueViews ?? null, clicks: g.uniqueClicks ?? null,
      };
    });
}

/** Crée la campagne et l'envoie tout de suite. */
async function sendCampaign({ subject, html, listIds }) {
  const s = sender();
  const stamp = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  const { data } = await call('POST', '/emailCampaigns', {
    name: `${CAMPAIGN_PREFIX} · ${stamp}`,
    subject,
    sender: { name: s.name, email: s.email },
    replyTo: process.env.DINER_REPLY_TO || 'boxingcenter31@gmail.com',
    htmlContent: html,
    recipients: { listIds },
  });
  await call('POST', `/emailCampaigns/${data.id}/sendNow`);
  return { id: data.id };
}

module.exports = { isConfigured: isBrevoEnabled, lists, createList, addContact, campaigns, sendCampaign, CAMPAIGN_PREFIX };
