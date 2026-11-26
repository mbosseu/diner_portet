'use strict';

/**
 * Choix du prestataire de paiement : CAWL (carte, Crédit Agricole) ou PayPal (compte de Portet).
 * PAYMENT_PROVIDER force le choix ; sinon CAWL dès que ses clés existent, PayPal autrement.
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
