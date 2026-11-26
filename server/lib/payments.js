'use strict';

/**
 * Choix du prestataire de paiement : CAWL (carte, Crédit Agricole) ou PayPal (compte de Portet).
 * CAWL (carte, compte de Portet) dès que ses clés existent, PayPal sinon.
 * PAYMENT_PROVIDER=paypal ou cawl force le choix.
 */

const cawl = require('./cawl');
const paypal = require('./paypal');

function provider() {
  const forced = String(process.env.PAYMENT_PROVIDER || '').trim().toLowerCase();
  if (forced === 'cawl' || forced === 'paypal') return forced;
  return cawl.liveConfigured() ? 'cawl' : 'paypal';
}

function lib(name = provider()) {
  return name === 'cawl' ? cawl : paypal;
}

module.exports = { provider, lib };
