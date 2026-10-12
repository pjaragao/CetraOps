#!/usr/bin/env bash
# Mudança do banco do homelab (Supabase local) para o Supabase Cloud, em etapas que podem ser repetidas.
# Leia antes: infra/MIGRACAO-SUPABASE-CLOUD.md. NADA aqui apaga o banco de origem.
#
#   TARGET_DB_URL=postgresql://postgres.<ref>:<senha>@aws-0-sa-east-1.pooler.supabase.com:5432/postgres \
#   infra/scripts/migrate-to-cloud.sh <etapa>
#
# Etapas (nesta ordem):
#   preflight    confere acesso, versão, extensões e se o destino aceita session_replication_role
#   schema       aplica todas as migrations no destino (centralops-migrate --skip-seed: sem seeds, sem dados)
#   data         copia os DADOS da origem (schemas do sistema + usuários do auth) para o destino, com os gatilhos desligados
#   vault        copia os segredos do Vault usados pelo sistema (chave dos CPFs e credenciais das integrações)
#   verify       compara contagens origem × destino e roda as conferências de privilégio
#
# Origem: SOURCE_CONTAINER (padrão supabase-db, usuário supabase_admin) ou SOURCE_DB_URL.
# Recomendado: rode tudo primeiro num projeto de TESTE do Supabase Cloud; depois, com a loja fechada, no definitivo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STEP="${1:-}"
: "${TARGET_DB_URL:?defina TARGET_DB_URL (conexão direta ou pooler em modo sessão, porta 5432, usuário postgres)}"
SRC_CONTAINER="${SOURCE_CONTAINER:-supabase-db}"
WORK="${MIGRATION_WORKDIR:-$HOME/backups/centralops/migracao}"
mkdir -p "$WORK"; chmod 700 "$WORK"; umask 077
APP_SCHEMAS=(core crm catalog inv sales fin fiscal omni ai mkt aff hr comm purch audit agent private)

tpsql() { docker run --rm -i --network host -e PGURL="$TARGET_DB_URL" postgres:17-alpine sh -c 'psql "$PGURL" -v ON_ERROR_STOP=1 -X "$@"' _ "$@"; }
spsql() {
  if [[ -n "${SOURCE_DB_URL:-}" ]]; then docker run --rm -i --network host -e PGURL="$SOURCE_DB_URL" postgres:17-alpine sh -c 'psql "$PGURL" -v ON_ERROR_STOP=1 -X "$@"' _ "$@"
  else docker exec -i "$SRC_CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -X "$@"; fi
}
sdump() {
  if [[ -n "${SOURCE_DB_URL:-}" ]]; then docker run --rm --network host -e PGURL="$SOURCE_DB_URL" postgres:17-alpine sh -c 'pg_dump "$PGURL" "$@"' _ "$@"
  else docker exec "$SRC_CONTAINER" pg_dump -U supabase_admin -d postgres "$@"; fi
}
COUNTS="select s.nspname||'.'||c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', s.nspname, c.relname), false, true, '')))[1]::text::bigint
        from pg_class c join pg_namespace s on s.oid = c.relnamespace
        where c.relkind = 'r' and s.nspname = any(string_to_array('$(IFS=,; echo "${APP_SCHEMAS[*]}"),auth', ',')) and not (s.nspname = 'auth' and c.relname not in ('users', 'identities'))
        order by 1"

case "$STEP" in
preflight)
  echo "== destino"; tpsql -Atc "select current_user, version()"
  tpsql -Atc "set session_replication_role = replica; select 'session_replication_role ok'" \
    || { echo "O destino não aceita session_replication_role: use a conexão DIRETA (db.<ref>.supabase.co) como postgres."; exit 1; }
  echo "== extensões disponíveis no destino"; tpsql -Atc "select name, coalesce(installed_version, '-') from pg_available_extensions where name in ('pg_cron','pgmq','pg_net','supabase_vault','pgcrypto','pg_trgm','unaccent','vector','uuid-ossp') order by 1"
  echo "== origem"; spsql -Atc "select version(); select count(*) || ' migrations' from supabase_migrations.schema_migrations"
  echo "preflight ok. No painel do destino: Database › Extensions — ligue pg_cron e pgmq antes da etapa schema, se não estiverem ligadas."
  ;;
schema)
  echo "aplicando as migrations no destino (sem seeds)…"
  command -v uv >/dev/null || { echo "precisa do uv (https://docs.astral.sh/uv/) para rodar o centralops-migrate"; exit 1; }
  (cd "$ROOT" && CENTRALOPS_DATABASE_URL="$TARGET_DB_URL" uv run --package centralops-worker centralops-migrate --skip-seed)
  ;;
data)
  SV=$(spsql -Atc "select max(version) from supabase_migrations.schema_migrations")
  TV=$(tpsql -Atc "select max(version) from supabase_migrations.schema_migrations")
  if [[ "$SV" != "$TV" && -z "${ALLOW_VERSION_MISMATCH:-}" ]]; then
    echo "A origem está na migration $SV e o destino na $TV. Implante a mesma versão no servidor antigo antes de copiar os dados"
    echo "(senão as linhas que as migrations novas criaram, como permissões, se perdem na cópia)."; exit 1
  fi
  echo "1/4 exportando os dados da origem…"
  ARGS=(--data-only --no-owner --no-privileges --disable-triggers)
  for s in "${APP_SCHEMAS[@]}"; do ARGS+=(--schema="$s"); done
  sdump "${ARGS[@]}" > "$WORK/app-data.sql"
  sdump --data-only --no-owner --no-privileges -t auth.users -t auth.identities > "$WORK/auth-data.sql"
  echo "   $(du -h "$WORK/app-data.sql" | cut -f1) de dados do sistema, $(grep -c '^COPY' "$WORK/app-data.sql") tabelas"
  echo "2/4 esvaziando no destino as tabelas que as migrations preencheram (o destino é novo; a origem traz as mesmas linhas)…"
  tpsql -c "do \$\$ declare r record; begin
    for r in select format('%I.%I', schemaname, tablename) as t from pg_tables where schemaname = any(string_to_array('$(IFS=,; echo "${APP_SCHEMAS[*]}")', ',')) loop
      execute 'truncate ' || r.t || ' cascade';
    end loop; end \$\$;"
  echo "3/4 carregando (gatilhos desligados: o estoque e os saldos vêm prontos da origem)…"
  { echo "set session_replication_role = replica;"; cat "$WORK/auth-data.sql"; } | tpsql -q >/dev/null
  { echo "set session_replication_role = replica;"; grep -v -E '^(ALTER TABLE .* (DISABLE|ENABLE) TRIGGER ALL;)$' "$WORK/app-data.sql"; } | tpsql -q >/dev/null
  echo "4/4 recarregando o PostgREST"; tpsql -c "notify pgrst, 'reload schema'" >/dev/null
  echo "dados copiados. Rode a etapa vault e depois verify."
  ;;
vault)
  OUT="$WORK/vault-secrets.tsv"
  spsql -At -F $'\t' -c "select name, decrypted_secret from vault.decrypted_secrets
    where name = 'crm_cpf_key' or name in (select secret_ref from core.integration_connections where secret_ref is not null)" > "$OUT"
  echo "$(wc -l < "$OUT") segredo(s) exportado(s) para $OUT (só você lê; apague depois)"
  while IFS=$'\t' read -r name secret; do
    [[ -n "$name" ]] || continue
    tpsql -q -v n="$name" -v s="$secret" <<'SQL'
select case when exists (select 1 from vault.secrets where name = :'n')
  then (select vault.update_secret(id, :'s') from vault.secrets where name = :'n')::text
  else vault.create_secret(:'s', :'n')::text end;
SQL
    echo "   ok: $name"
  done < "$OUT"
  shred -u "$OUT" 2>/dev/null || rm -f "$OUT"
  echo "segredos copiados e o arquivo temporário apagado."
  ;;
verify)
  spsql -At -F $'\t' -c "$COUNTS" > "$WORK/src.tsv"
  tpsql -At -F $'\t' -c "$COUNTS" > "$WORK/dst.tsv"
  # só as tabelas que existem na origem (as que só existem no destino são de migrations novas e começam vazias)
  DIFF=$(join -t $'\t' -a1 -e MISSING -o 0,1.2,2.2 <(sort "$WORK/src.tsv") <(sort "$WORK/dst.tsv") | awk -F'\t' '$2!=$3')
  if [[ -z "$DIFF" ]]; then echo "contagens IGUAIS nas $(wc -l < "$WORK/src.tsv") tabelas da origem"
  else echo "DIFERENÇAS (tabela, origem, destino):"; echo "$DIFF"; fi
  echo "== CPF legível com a chave copiada?"
  tpsql -Atc "select case when not exists (select 1 from crm.party_sensitive) then 'sem CPFs' when exists (select 1 from vault.decrypted_secrets where name = 'crm_cpf_key' and decrypted_secret is not null) then 'chave presente' else 'FALTA a chave crm_cpf_key' end"
  echo "== funções expostas sem login (deve ser 0)"
  tpsql -Atc "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any('{core,crm,catalog,inv,sales,fin,fiscal,omni,ai,mkt,aff,hr,purch}') and has_function_privilege('anon', p.oid, 'execute') and p.prosecdef"
  echo "== rotinas agendadas"; tpsql -Atc "select count(*) || ' jobs no pg_cron' from cron.job"
  ;;
*)
  sed -n '2,20p' "$0"; exit 1 ;;
esac
