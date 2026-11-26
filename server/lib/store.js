'use strict';

/**
 * Enregistrement des inscriptions.
 * - Supabase si DINER_SUPABASE_URL + DINER_SUPABASE_SERVICE_ROLE_KEY sont définis (table
 *   diner_registrations, voir supabase/schema.sql) — à utiliser en ligne.
 *   Les noms SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sont volontairement ignorés : dans le projet
 *   Vercel ils peuvent venir de la boutique Box Plus, dont la base ne doit jamais être touchée.
 * - Sinon fichiers JSON dans data/registrations (développement local uniquement).
 */

const fs = require('fs');
const path = require('path');

const TABLE = 'diner_registrations';
const PENDING_HOLD_MS = 30 * 60 * 1000; // une place est réservée 30 min pendant le paiement

let supabase = null;
function supabaseEnv() {
  const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '');
  return { url: clean(process.env.DINER_SUPABASE_URL), key: clean(process.env.DINER_SUPABASE_SERVICE_ROLE_KEY) };
}

/** Configuré seulement avec une vraie URL https et une clé (pas un texte « COLLER_ICI » oublié). */
function supabaseConfigured() {
  const { url, key } = supabaseEnv();
  return /^https:\/\/\S+$/.test(url) && key.length > 30;
}

function remote() {
  if (!supabaseConfigured()) return null;
  const { url, key } = supabaseEnv();
  if (!supabase) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(url, key, { auth: { persistSession: false } });
  }
  return supabase;
}

function localDir() {
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, 'registrations');
  return process.env.VERCEL ? '/tmp/diner-registrations' : path.join(__dirname, '../../data/registrations');
}

function safeId(id) {
  return /^DP-[A-Z0-9]{6,12}$/.test(String(id || '')) ? String(id) : null;
}

async function save(reg) {
  reg.updated_at = new Date().toISOString();
  const db = remote();
  if (db) {
    const { error } = await db.from(TABLE).upsert({
      id: reg.id,
      status: reg.status,
      email: reg.email,
      created_at: reg.created_at,
      data: reg,
    });
    if (error) throw new Error(`Supabase: ${error.message}`);
    return reg;
  }
  const dir = localDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${reg.id}.json`), JSON.stringify(reg, null, 2));
  return reg;
}

async function load(id) {
  const sid = safeId(id);
  if (!sid) return null;
  const db = remote();
  if (db) {
    const { data, error } = await db.from(TABLE).select('data').eq('id', sid).maybeSingle();
    if (error) throw new Error(`Supabase: ${error.message}`);
    return data ? data.data : null;
  }
  const file = path.join(localDir(), `${sid}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function listAll() {
  const db = remote();
  if (db) {
    const { data, error } = await db.from(TABLE).select('data').order('created_at', { ascending: true });
    if (error) throw new Error(`Supabase: ${error.message}`);
    return (data || []).map((r) => r.data);
  }
  const dir = localDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

/** Places occupées : payées + paiements en cours depuis moins de 30 minutes. `scope` filtre (vrai / test). */
async function seatsTaken(scope = () => true) {
  const now = Date.now();
  const all = (await listAll()).filter(scope);
  return all.filter((r) => {
    if (r.status === 'paid' || r.status === 'review') return true;
    return r.status === 'pending' && now - Date.parse(r.created_at) < PENDING_HOLD_MS;
  }).length;
}

async function findPaidByEmail(email, scope = () => true) {
  const target = String(email || '').trim().toLowerCase();
  const all = (await listAll()).filter(scope);
  return all.find((r) => r.status === 'paid' && String(r.email).toLowerCase() === target) || null;
}

async function remove(id) {
  const sid = safeId(id);
  if (!sid) return;
  const db = remote();
  if (db) {
    const { error } = await db.from(TABLE).delete().eq('id', sid);
    if (error) throw new Error(`Supabase: ${error.message}`);
    return;
  }
  const file = path.join(localDir(), `${sid}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = {
  supabaseConfigured, save, load, listAll, seatsTaken, findPaidByEmail, remove, safeId, PENDING_HOLD_MS };
