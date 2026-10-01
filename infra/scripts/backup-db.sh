#!/usr/bin/env bash
# Backup lógico semanal do banco (além do PITR do Supabase): pg_dump → gzip → R2/S3, com verificação e retenção.
# Agende na VPS (cron do host, domingo 03:00):   0 3 * * 0  /opt/sie/infra/scripts/backup-db.sh >> /var/log/sie-backup.log 2>&1
#
# Variáveis obrigatórias:
#   SIE_BACKUP_DB_URL     conexão do Postgres (pooler em modo sessão ou conexão direta) com um usuário de LEITURA
#   SIE_BACKUP_BUCKET     bucket (ex.: sie-backups)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   credenciais do R2/S3 (só escrita no bucket de backup)
# Opcionais:
#   SIE_BACKUP_ENDPOINT   endpoint S3-compatível (R2: https://<conta>.r2.cloudflarestorage.com)
#   SIE_BACKUP_KEEP       quantos backups manter (padrão 8 = 2 meses de semanais)
#   SIE_HEARTBEAT_URL     URL de heartbeat (Better Stack): chamada SÓ se o backup inteiro deu certo
set -euo pipefail

: "${SIE_BACKUP_DB_URL:?}" "${SIE_BACKUP_BUCKET:?}"
KEEP="${SIE_BACKUP_KEEP:-8}"
ENDPOINT_ARG=(); [[ -n "${SIE_BACKUP_ENDPOINT:-}" ]] && ENDPOINT_ARG=(--endpoint-url "$SIE_BACKUP_ENDPOINT")
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
FILE="$WORK/sie-${STAMP}.dump"

echo "[$(date -u +%FT%TZ)] dump..."
# formato custom (-Fc): comprimido, restauração seletiva e paralela. Schemas do app; o auth/storage do Supabase têm backup próprio (PITR).
pg_dump "$SIE_BACKUP_DB_URL" -Fc --no-owner --no-privileges \
  --schema=core --schema=crm --schema=catalog --schema=inv --schema=sales --schema=fin --schema=fiscal \
  --schema=omni --schema=ai --schema=hr --schema=comm --schema=purch --schema=audit --schema=private --schema=agent \
  -f "$FILE"

echo "[$(date -u +%FT%TZ)] verificando o arquivo..."
pg_restore --list "$FILE" >/dev/null                       # falha se o dump estiver corrompido
SIZE=$(stat -c %s "$FILE")
[[ "$SIZE" -gt 10000 ]] || { echo "dump pequeno demais ($SIZE bytes): abortando" >&2; exit 1; }
sha256sum "$FILE" | awk '{print $1}' > "$FILE.sha256"

echo "[$(date -u +%FT%TZ)] enviando ($SIZE bytes)..."
aws s3 cp "$FILE" "s3://${SIE_BACKUP_BUCKET}/weekly/sie-${STAMP}.dump" "${ENDPOINT_ARG[@]}" --only-show-errors
aws s3 cp "$FILE.sha256" "s3://${SIE_BACKUP_BUCKET}/weekly/sie-${STAMP}.dump.sha256" "${ENDPOINT_ARG[@]}" --only-show-errors

echo "[$(date -u +%FT%TZ)] retenção: mantendo os $KEEP mais recentes"
mapfile -t OLD < <(aws s3 ls "s3://${SIE_BACKUP_BUCKET}/weekly/" "${ENDPOINT_ARG[@]}" | awk '{print $4}' | grep -E '\.dump$' | sort | head -n "-$KEEP" || true)
for key in "${OLD[@]:-}"; do
  [[ -n "$key" ]] || continue
  aws s3 rm "s3://${SIE_BACKUP_BUCKET}/weekly/$key" "${ENDPOINT_ARG[@]}" --only-show-errors
  aws s3 rm "s3://${SIE_BACKUP_BUCKET}/weekly/$key.sha256" "${ENDPOINT_ARG[@]}" --only-show-errors || true
done

[[ -n "${SIE_HEARTBEAT_URL:-}" ]] && curl -fsS -m 10 --retry 3 "$SIE_HEARTBEAT_URL" >/dev/null || true
echo "[$(date -u +%FT%TZ)] ok: sie-${STAMP}.dump"
