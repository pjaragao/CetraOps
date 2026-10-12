#!/usr/bin/env bash
# Teste de restauração: restaura um backup num Postgres DESCARTÁVEL (contêiner próprio, nunca o de produção) e confere as contagens.
# "Backup que ninguém restaurou não é backup." Rode uma vez por mês e depois de mudar o servidor.
#
#   infra/scripts/restore-check.sh                         # o backup diário mais recente
#   infra/scripts/restore-check.sh caminho/arquivo.dump[.gpg]
# Variáveis: CENTRALOPS_BACKUP_DIR (padrão ~/backups/centralops), CENTRALOPS_BACKUP_PASSPHRASE_FILE (se o backup é cifrado),
#            COMPARE_CONTAINER=supabase-db ou COMPARE_DB_URL=… para comparar as contagens com o banco de origem.
set -euo pipefail

DIR="${CENTRALOPS_BACKUP_DIR:-$HOME/backups/centralops}"
FILE="${1:-$(ls -1t "$DIR"/daily/*.dump* 2>/dev/null | grep -v sha256 | head -1)}"
[[ -f "$FILE" ]] || { echo "nenhum backup encontrado em $DIR/daily"; exit 1; }
C=centralops-restore-check
PASS=restore-check-local
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"; docker rm -f "$C" >/dev/null 2>&1 || true' EXIT

if [[ -f "$FILE.sha256" ]]; then
  [[ "$(sha256sum "$FILE" | awk '{print $1}')" == "$(cat "$FILE.sha256")" ]] || { echo "checksum NÃO confere: $FILE"; exit 1; }
fi
DUMP="$FILE"
if [[ "$FILE" == *.gpg ]]; then
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "${CENTRALOPS_BACKUP_PASSPHRASE_FILE:?arquivo de senha}" -o "$WORK/b.dump" -d "$FILE"
  DUMP="$WORK/b.dump"
fi

echo "subindo Postgres descartável…"
docker run -d --name "$C" -e POSTGRES_PASSWORD="$PASS" --memory 1g supabase/postgres:15.8.1.085 >/dev/null
for _ in $(seq 1 60); do docker exec -e PGPASSWORD="$PASS" "$C" psql -h localhost -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1 && break; sleep 2; done
psqlc() { docker exec -i -e PGPASSWORD="$PASS" "$C" psql -h localhost -U supabase_admin -v ON_ERROR_STOP=0 -q "$@"; }
psqlc -d postgres -c "create database r" >/dev/null
psqlc -d r -c "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists pg_trgm with schema extensions; create extension if not exists unaccent with schema extensions; create extension if not exists vector with schema extensions; create extension if not exists \"uuid-ossp\" with schema extensions; create extension if not exists pgmq; create publication supabase_realtime" >/dev/null 2>&1 || true

echo "restaurando $(basename "$FILE")…"
docker cp "$DUMP" "$C:/tmp/b.dump"
docker exec -e PGPASSWORD="$PASS" "$C" pg_restore -h localhost -U supabase_admin -d r --no-owner --no-privileges /tmp/b.dump > "$WORK/restore.log" 2>&1 || true
ERRORS=$(grep -c "error:" "$WORK/restore.log" || true)
echo "avisos/erros do pg_restore: $ERRORS (dependências do Supabase ausentes no contêiner, como cron e vault, são esperadas)"

COUNTS="select 'orgs', count(*) from core.orgs union all select 'pessoas', count(*) from crm.parties union all select 'produtos', count(*) from catalog.products
  union all select 'variantes', count(*) from catalog.variants union all select 'movimentos', count(*) from inv.movements union all select 'pedidos', count(*) from sales.orders
  union all select 'pagamentos', count(*) from sales.payments union all select 'titulos', count(*) from fin.titles union all select 'notas', count(*) from fiscal.documents
  union all select 'usuarios', count(*) from auth.users"
psqlc -d r -At -F' ' -c "$COUNTS" > "$WORK/restored.txt"
echo "restaurado:"; column -t "$WORK/restored.txt"
if [[ -n "${COMPARE_CONTAINER:-}" ]]; then
  docker exec -i "$COMPARE_CONTAINER" psql -U supabase_admin -d postgres -At -F' ' -c "$COUNTS" > "$WORK/source.txt"
elif [[ -n "${COMPARE_DB_URL:-}" ]]; then
  docker run --rm --network host postgres:17-alpine psql "$COMPARE_DB_URL" -At -F' ' -c "$COUNTS" > "$WORK/source.txt"
fi
if [[ -f "$WORK/source.txt" ]]; then
  if diff -q "$WORK/source.txt" "$WORK/restored.txt" >/dev/null; then echo "contagens IGUAIS à origem: restauração ok"
  else echo "contagens diferentes da origem (normal se houve movimento depois do backup):"; diff "$WORK/source.txt" "$WORK/restored.txt" || true; fi
fi
[[ "$(awk '$1=="orgs"{print $2}' "$WORK/restored.txt")" -ge 1 ]] || { echo "FALHOU: empresa não restaurada"; exit 1; }
echo "ok"
