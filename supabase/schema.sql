-- Table des inscriptions au dîner du Business Club.
-- À exécuter dans un projet Supabase DÉDIÉ (SQL Editor), pas dans celui de la boutique Box Plus.

create table if not exists public.diner_registrations (
  id          text primary key,
  status      text not null default 'pending',   -- pending | paid | cancelled
  email       text not null,
  created_at  timestamptz not null default now(),
  data        jsonb not null
);

create index if not exists diner_registrations_status_idx on public.diner_registrations (status);

-- Accès uniquement par le serveur (clé service_role) : aucune lecture publique.
alter table public.diner_registrations enable row level security;

-- Les nouveaux projets Supabase ne donnent plus de droits automatiques sur les tables créées en SQL :
-- on les accorde au seul rôle serveur (clé secrète sb_secret_… / service_role).
grant select, insert, update, delete on table public.diner_registrations to service_role;
