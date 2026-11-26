'use strict';

/** Serveur local : site (public/) + API, sur http://localhost:5173 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const { createApp } = require('./server/app');

const port = Number(process.env.PORT || 5173);
const app = createApp();
const root = express();
root.use(app);
root.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
root.listen(port, () => {
  console.log(`Business Club — http://localhost:${port}`);
});
