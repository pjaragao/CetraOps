#!/usr/bin/env bash
# Backup lógico do banco do CentralOps, conferido, opcionalmente cifrado, com cópia fora da máquina e retenção.
# Serve hoje (homelab, Supabase local) e depois da mudança (Supabase Cloud): só muda a origem.
#
#   infra/scripts/backup-db.sh                  # um backup agora
#   cron (todo dia 02:30):  30 2 * * *  /caminho/infra/scripts/backup-db.sh >> ~/backups/centralops/backup.log 2>&1
#
# ORIGEM (uma das duas):
#   CENTRALOPS_BACKUP_CONTAINER=supabase-db     homelab: pg_dump dentro do contêiner do banco (usuário supabase_admin)
#   CENTRALOPS_BACKUP_DB_URL=postgresql://…     Supabase Cloud: conexão direta ou pooler em modo SESSÃO (porta 5432), usuário postgres
# DESTINO:
#   CENTRALOPS_BACKUP_DIR        pasta local (padrão ~/backups/centralops) — guarda os arquivos e o log
#   CENTRALOPS_BACKUP_RCLONE     (opcional) destino do rclone fora da máquina, ex.: gdrive:centralops-backups ou b2:bucket/centralops
#   CENTRALOPS_BACKUP_PASSPHRASE_FILE  (opcional, recomendado com cópia externa) arquivo com a senha: cifra com gpg (AES-256)
# RETENÇÃO:
#   CENTRALOPS_BACKUP_KEEP_DAILY (padrão 14) · CENTRALOPS_BACKUP_KEEP_MONTHLY (padrão 12; o 1º backup de cada mês)
# AVISO:
#   CENTRALOPS_HEARTBEAT_URL     (opcional) healthchecks.io / Better Stack: chamado no sucesso; em falha chama <url>/fail
#
# O que entra: todos os schemas do sistema + auth (usuários e identidades) + metadados do storage + registro das migrations.
# O que NÃO entra (de propósito): o conteúdo do Vault (credenciais das integrações e a chave dos CPFs ficam cifrados com a chave
# do servidor — guarde a chave `crm_cpf_key` e as credenciais no cofre de senhas; ver infra/MIGRACAO-SUPABASE-CLOUD.md) e as filas.
set -euo pipefail

SCHEMAS=(core crm catalog inv sales fin fiscal omni ai mkt aff hr comm purch audit agent private auth storage supabase_migrations)
DIR="${CENTRALOPS_BACKUP_DIR:-$HOME/backups/centralops}"
KEEP_DAILY="${CENTRALOPS_BACKUP_KEEP_DAILY:-14}"
KEEP_MONTHLY="${CENTRALOPS_BACKUP_KEEP_MONTHLY:-12}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DIR/daily" "$DIR/monthly"
umask 077

log() { echo "[$(date +%FT%T%z)] $*"; }
fail() {
  log "FALHOU: $*"
  [[ -n "${CENTRALOPS_HEARTBEAT_URL:-}" ]] && curl -fsS -m 10 --retry 3 --data-raw "$*" "${CENTRALOPS_HEARTBEAT_URL%/}/fail" >/dev/null 2>&1 || true
  exit 1
}
trap 'fail "erro na linha $LINENO"' ERR

ARGS=(-Fc --no-owner --no-privileges -Z 6)
for s in "${SCHEMAS[@]}"; do ARGS+=(--schema="$s"); done
OUT="$DIR/daily/centralops-$STAMP.dump"

log "dump…"
if [[ -n "${CENTRALOPS_BACKUP_CONTAINER:-}" ]]; then
  docker exec "$CENTRALOPS_BACKUP_CONTAINER" pg_dump -U supabase_admin -d postgres "${ARGS[@]}" > "$OUT"
  LIST() { docker exec -i "$CENTRALOPS_BACKUP_CONTAINER" pg_restore --list < "$1"; }
elif [[ -n "${CENTRALOPS_BACKUP_DB_URL:-}" ]]; then
  if command -v pg_dump >/dev/null && pg_dump --version | grep -qE ' (1[5-9]|[2-9][0-9])\.'; then
    pg_dump "$CENTRALOPS_BACKUP_DB_URL" "${ARGS[@]}" -f "$OUT"
    LIST() { pg_restore --list "$1"; }
  else                                                    # sem pg_dump compatível: usa o da imagem oficial (cliente 17 lê servidor 15 e 17)
    docker run --rm --network host -e PGURL="$CENTRALOPS_BACKUP_DB_URL" postgres:17-alpine sh -c 'pg_dump "$PGURL" "$@"' _ "${ARGS[@]}" > "$OUT"
    LIST() { docker run --rm -i postgres:17-alpine pg_restore --list < "$1"; }
  fi
else
  fail "defina CENTRALOPS_BACKUP_CONTAINER (homelab) ou CENTRALOPS_BACKUP_DB_URL (Supabase Cloud)"
fi

log "conferindo…"
SIZE=$(stat -c %s "$OUT")
[[ "$SIZE" -gt 50000 ]] || fail "dump pequeno demais ($SIZE bytes)"
TOC="$(LIST "$OUT")"                                     # lido uma vez (grep -q num pipe quebraria com pipefail)
ENTRIES=$(grep -c "TABLE DATA" <<<"$TOC" || true)
[[ "$ENTRIES" -gt 100 ]] || fail "dump com poucas tabelas ($ENTRIES)"
for t in "core orgs" "crm parties" "sales orders" "inv movements" "fin titles" "auth users"; do
  grep -q "TABLE DATA $t " <<<"$TOC" || fail "tabela ${t/ /.} ausente no dump"
done

FINAL="$OUT"
if [[ -n "${CENTRALOPS_BACKUP_PASSPHRASE_FILE:-}" ]]; then
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "$CENTRALOPS_BACKUP_PASSPHRASE_FILE" --symmetric --cipher-algo AES256 -o "$OUT.gpg" "$OUT"
  rm -f "$OUT"; FINAL="$OUT.gpg"
fi
sha256sum "$FINAL" | awk '{print $1}' > "$FINAL.sha256"

# o primeiro backup do mês vira mensal
MONTH="$(date +%Y%m)"
if ! ls "$DIR/monthly/" 2>/dev/null | grep -q "centralops-$MONTH"; then
  cp "$FINAL" "$FINAL.sha256" "$DIR/monthly/"
fi

if [[ -n "${CENTRALOPS_BACKUP_RCLONE:-}" ]]; then
  log "copiando para ${CENTRALOPS_BACKUP_RCLONE}…"
  rclone copy "$DIR/daily" "${CENTRALOPS_BACKUP_RCLONE}/daily" --include "$(basename "$FINAL")*"
  rclone copy "$DIR/monthly" "${CENTRALOPS_BACKUP_RCLONE}/monthly"
  rclone check "$DIR/daily" "${CENTRALOPS_BACKUP_RCLONE}/daily" --include "$(basename "$FINAL")" --one-way >/dev/null 2>&1 || fail "cópia externa não confere"
else
  log "AVISO: sem CENTRALOPS_BACKUP_RCLONE o backup fica só nesta máquina"
fi

log "retenção: $KEEP_DAILY diários, $KEEP_MONTHLY mensais"
prune() {   # $1 pasta, $2 quantos manter
  mapfile -t old < <(ls -1 "$1" | grep -E '\.dump(\.gpg)?$' | sort | head -n "-$2" || true)
  for f in "${old[@]:-}"; do [[ -n "$f" ]] && rm -f "$1/$f" "$1/$f.sha256"; done
  if [[ -n "${CENTRALOPS_BACKUP_RCLONE:-}" ]]; then
    for f in "${old[@]:-}"; do [[ -n "$f" ]] && rclone deletefile "${CENTRALOPS_BACKUP_RCLONE}/$(basename "$1")/$f" 2>/dev/null || true; done
  fi
}
prune "$DIR/daily" "$KEEP_DAILY"
prune "$DIR/monthly" "$KEEP_MONTHLY"

[[ -n "${CENTRALOPS_HEARTBEAT_URL:-}" ]] && curl -fsS -m 10 --retry 3 "$CENTRALOPS_HEARTBEAT_URL" >/dev/null 2>&1 || true
log "ok: $(basename "$FINAL") ($(numfmt --to=iec "$(stat -c %s "$FINAL")"), $ENTRIES tabelas)"
