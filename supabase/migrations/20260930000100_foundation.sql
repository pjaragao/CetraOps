-- =====================================================================
-- SIÉ JOY OS 2.0 · Fundação: extensões, schemas por domínio, grants e utilitários
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm  with schema extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists vector   with schema extensions;
create extension if not exists pgmq;
create extension if not exists pg_cron  with schema pg_catalog;

-- Schemas de domínio (expostos ao PostgREST) e internos (não expostos)
create schema if not exists core;
create schema if not exists crm;
create schema if not exists catalog;
create schema if not exists inv;
create schema if not exists sales;
create schema if not exists fin;
create schema if not exists fiscal;
create schema if not exists omni;
create schema if not exists ai;
create schema if not exists audit;
create schema if not exists private;  -- helpers de RLS e triggers
create schema if not exists agent;    -- RPCs chamadas pelo servidor MCP (role agent_rpc)

-- Sem acesso anônimo a nada de negócio
do $$
declare s text;
begin
  foreach s in array array['core','crm','catalog','inv','sales','fin','fiscal','omni','ai'] loop
    execute format('revoke all on schema %I from anon, public', s);
    execute format('grant usage on schema %I to authenticated, service_role', s);
    execute format('alter default privileges in schema %I grant select, insert, update, delete on tables to authenticated', s);
    execute format('alter default privileges in schema %I grant all on tables to service_role', s);
    execute format('alter default privileges in schema %I grant usage, select on sequences to authenticated, service_role', s);
    execute format('alter default privileges in schema %I grant execute on functions to authenticated, service_role', s);
    execute format('alter default privileges in schema %I revoke execute on functions from public, anon', s);
  end loop;
end $$;

revoke all on schema audit, private, agent from anon, public, authenticated;
grant usage on schema audit to service_role;
grant usage on schema private to authenticated, service_role, supabase_auth_admin;
alter default privileges in schema private revoke execute on functions from public, anon;
alter default privileges in schema audit grant all on tables to service_role;

-- Role usada pelo servidor MCP: só executa funções agent.*, sem grant em tabelas
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'agent_rpc') then
    create role agent_rpc login password 'agent_rpc' noinherit;  -- troque a senha fora do ambiente local
  end if;
end $$;
grant usage on schema agent to agent_rpc;
alter default privileges in schema agent revoke execute on functions from public, anon, authenticated;
alter default privileges in schema agent grant execute on functions to agent_rpc, service_role;

-- ---------------------------------------------------------------------
-- Utilitários
-- ---------------------------------------------------------------------
create or replace function private.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function private.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'Tabela % é só-inserção: corrija com um estorno (reversal_of_id)', tg_table_schema || '.' || tg_table_name
    using errcode = 'P0001';
end $$;

-- unaccent imutável (necessário para índices e busca)
create or replace function private.norm(t text) returns text
language sql immutable parallel safe as $$
  select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(t, '')))
$$;

-- Normalização de telefone brasileiro para E.164 (+55DDNNNNNNNNN)
create or replace function private.normalize_phone(p text) returns text
language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if d = '' then return null; end if;
  if left(d, 2) = '00' then d := substr(d, 3); end if;
  if length(d) in (10, 11) then d := '55' || d; end if;   -- DDD + número sem país
  return '+' || d;
end $$;

-- Aplica set_updated_at em todas as tabelas com coluna updated_at de um schema
create or replace function private.attach_updated_at(p_schema text) returns void
language plpgsql as $$
declare r record;
begin
  for r in
    select c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = p_schema and c.column_name = 'updated_at' and t.table_type = 'BASE TABLE'
  loop
    execute format('drop trigger if exists trg_updated_at on %I.%I', p_schema, r.table_name);
    execute format('create trigger trg_updated_at before update on %I.%I for each row execute function private.set_updated_at()', p_schema, r.table_name);
  end loop;
end $$;
