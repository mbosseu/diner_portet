'use strict';

/** Entrée Vercel — toutes les routes /api/* passent par l'application Express. */
let app;

module.exports = (req, res) => {
  if (!app) {
    const { createApp } = require('../server/app');
    app = createApp();
  }
  return app(req, res);
};
