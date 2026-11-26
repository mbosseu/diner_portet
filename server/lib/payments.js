'use strict';

/**
 * Choix du prestataire de paiement : CAWL (carte, Crédit Agricole) ou PayPal (compte de Portet).
 * PayPal par défaut ; PAYMENT_PROVIDER=cawl pour passer à la carte (les clés CAWL de la boutique
 * peuvent être présentes sans qu'on veuille s'en servir).
 */

const cawl = require('./cawl');
const paypal = require('./paypal');

function provider() {
  const forced = String(process.env.PAYMENT_PROVIDER || '').trim().toLowerCase();
  if (forced === 'cawl' || forced === 'paypal') return forced;
  return 'paypal';
}

function lib(name = provider()) {
  return name === 'cawl' ? cawl : paypal;
}

module.exports = { provider, lib };
