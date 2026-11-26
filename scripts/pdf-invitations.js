'use strict';

/** Imprime communication/invitations-partenaires.html en PDF (A5, 10 pages) avec Chrome ou Edge en mode headless. */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);
const browser = candidates.find((p) => fs.existsSync(p));
if (!browser) throw new Error('Chrome ou Edge introuvable (définir CHROME_PATH)');

const src = path.join(__dirname, '..', 'communication', 'invitations-partenaires.html');
const out = path.join(__dirname, '..', 'communication', 'invitations-partenaires.pdf');
execFileSync(browser, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=8000',
  `--print-to-pdf=${out}`, pathToFileURL(src).href], { stdio: 'ignore' });
console.log('écrit communication/invitations-partenaires.pdf');
