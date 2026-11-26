'use strict';

/** Informations de l'événement — côté serveur (le front a son équivalent dans public/js/config.js). */
const EVENT = {
  name: 'Business Club · Rencontre Entrepreneurs',
  shortName: 'Rencontre Entrepreneurs',
  dateISO: '2026-12-04',
  dateLabel: 'Vendredi 4 décembre 2026',
  startTime: '11:30', // initiation boxe
  lunchTime: '12:15', // déjeuner, puis networking
  endTime: '15:00', // fin indicative (agenda)
  venue: 'Boxing Center',
  address: "61 route d'Espagne, 31120 Portet-sur-Garonne",
  priceCents: 1000,
  currency: 'EUR',
  timezone: 'Europe/Paris',
};

function publicUrl() {
  const fallback = isProduction() ? 'https://dinerportet.vercel.app' : 'http://localhost:5173';
  return String(process.env.PUBLIC_URL || fallback).replace(/\/+$/, '');
}

function maxPaidSeats() {
  const n = Number(process.env.MAX_PAID_SEATS || 60);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
}

function isProduction() {
  return Boolean(process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production');
}

module.exports = { EVENT, publicUrl, maxPaidSeats, isProduction };
