#!/usr/bin/env bash
# Banco de testes DESCARTÁVEL, fora do Postgres de produção: sobe um contêiner próprio (mesma imagem do Supabase),
# monta o banco do zero (todas as migrations + seeds, com stubs de cron/vault/net/storage) e roda os testes pgTAP.
#
#   infra/scripts/test-db.sh            # monta e roda todos os testes
#   infra/scripts/test-db.sh 066        # monta e roda só os arquivos que começam com 066
#   KEEP=1 infra/scripts/test-db.sh     # deixa o contêiner de pé no fim (para inspecionar)
#   infra/scripts/test-db.sh --down     # remove o contêiner
#
# Testes do worker no mesmo banco: CENTRALOPS_DATABASE_URL="postgresql://postgres:test-only-local@$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' centralops-testdb):5432/t" (com KEEP=1).
# Variáveis: TEST_DB_CONTAINER (padrão centralops-testdb), TEST_DB_IMAGE (padrão supabase/postgres:15.8.1.085).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
C="${TEST_DB_CONTAINER:-centralops-testdb}"
IMAGE="${TEST_DB_IMAGE:-supabase/postgres:15.8.1.085}"
PASS="test-only-local"
FILTER="${1:-}"

if [ "$FILTER" = "--down" ]; then docker rm -f "$C" >/dev/null 2>&1 || true; echo "contêiner $C removido"; exit 0; fi

psqlc() { docker exec -i -e PGPASSWORD="$PASS" "$C" psql -h localhost -U supabase_admin -q "$@"; }

if ! docker ps --format '{{.Names}}' | grep -qx "$C"; then
  docker rm -f "$C" >/dev/null 2>&1 || true
  docker run -d --name "$C" -e POSTGRES_PASSWORD="$PASS" --memory 1g "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do psqlc -d postgres -Atc "select 1" >/dev/null 2>&1 && break; sleep 2; done
fi

psqlc -d postgres -c "drop database if exists t with (force)" -c "create database t" >/dev/null
psqlc -d t <<'SQL' >/dev/null 2>&1 || true
create schema if not exists extensions;
create extension if not exists pgtap with schema extensions; create extension if not exists unaccent with schema extensions;
create extension if not exists pgcrypto with schema extensions; create extension if not exists pg_trgm with schema extensions;
create extension if not exists vector with schema extensions; create extension if not exists "uuid-ossp" with schema extensions; create extension if not exists pgmq;
create schema cron; create table cron.job(jobid serial, jobname text, schedule text, command text, active boolean default true);
create table cron.job_run_details(runid serial, jobid int, status text, return_message text, start_time timestamptz, end_time timestamptz);
create function cron.schedule(text,text,text) returns bigint language sql as 'insert into cron.job(jobname,schedule,command) values ($1,$2,$3) returning jobid::bigint';
create function cron.unschedule(text) returns boolean language sql as 'delete from cron.job where jobname=$1 returning true';
create function cron.unschedule(bigint) returns boolean language sql as 'delete from cron.job where jobid=$1 returning true';
create schema vault; create table vault.secrets(id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
create view vault.decrypted_secrets as select id, name, secret as decrypted_secret, description from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null) returns uuid language sql as 'insert into vault.secrets(name, secret) values (new_name, new_secret) returning id';
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null) returns void language sql as 'update vault.secrets set secret=coalesce(new_secret,secret), name=coalesce(new_name,name) where id=secret_id';
create schema net; create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as 'select 1::bigint';
create schema storage; create table storage.buckets(id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz default now()); alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
create publication supabase_realtime;
create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
SQL
psqlc -d t < "$ROOT/supabase/tests/support/auth_schema.sql" >/dev/null 2>&1 || true
psqlc -d t -c "grant usage on schema auth, extensions to authenticated, anon, service_role; grant execute on all functions in schema auth, extensions to authenticated, anon, service_role; alter database t set search_path = public, extensions; grant usage on schema vault, cron, net, storage, supabase_migrations to postgres, service_role; grant all on all tables in schema vault, cron, storage, supabase_migrations to postgres, service_role; grant all on all sequences in schema cron to postgres; grant execute on all functions in schema vault, cron, net, storage to postgres, service_role; alter role postgres password '$PASS'" >/dev/null 2>&1 || true

n=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  v=$(basename "$f"); v=${v%%_*}
  out=$( (echo "begin;"; grep -v "create extension if not exists pg_cron" "$f"; echo "; insert into supabase_migrations.schema_migrations(version,name) values ('$v','x'); commit;") \
        | psqlc -d t -v ON_ERROR_STOP=1 2>&1 | grep -E "ERROR|FATAL" | head -3 || true)
  if [ -n "$out" ]; then echo "MIGRATION FALHOU $(basename "$f"): $out"; exit 1; fi
  n=$((n+1))
done
for f in "$ROOT"/supabase/seed/*.sql; do
  out=$(psqlc -d t -v ON_ERROR_STOP=1 < "$f" 2>&1 | grep -E "ERROR" | head -2 || true)
  if [ -n "$out" ]; then echo "SEED FALHOU $(basename "$f"): $out"; exit 1; fi
done
psqlc -d t -c "grant usage on schema pgmq to postgres; grant all on all tables in schema pgmq to postgres; grant all on all sequences in schema pgmq to postgres; grant create, connect, temporary on database t to postgres; grant create on schema supabase_migrations to postgres; alter table supabase_migrations.schema_migrations owner to postgres;" >/dev/null
echo "banco de teste montado: $n migrations + seeds"

fail=0
for f in "$ROOT"/supabase/tests/*.sql; do
  b=$(basename "$f"); if [[ -n "$FILTER" && "$b" != "$FILTER"* ]]; then continue; fi
  out=$(psqlc -d t -At < "$f" 2>&1 | grep -v "^$\|NOTICE" || true)
  ok=$(echo "$out" | grep -c '^ok' || true); nok=$(echo "$out" | grep -c '^not ok' || true); plan=$(echo "$out" | grep -m1 "^1\.\." | cut -d. -f3 || true)
  err=$(echo "$out" | grep -m1 "^ERROR" || true)
  st=PASS; [ "$nok" != "0" ] && st=FAIL; [ -n "$err" ] && st=ERR; [ "$st" = PASS ] && [ "$ok" != "$plan" ] && st=PLAN
  if [ "$st" != PASS ]; then fail=1; echo "$out" | grep -E "^(not ok|#)" | head -8; fi
  echo "$st $b ok=$ok/$plan ${err:0:200}"
done
if [ -z "${KEEP:-}" ]; then docker rm -f "$C" >/dev/null 2>&1 || true; fi
exit $fail
