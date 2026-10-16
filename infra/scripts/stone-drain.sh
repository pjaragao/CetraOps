#!/usr/bin/env bash
# Cron do homelab: pede ao app para consumir a fila do relay da Stone (Vercel). Ex.: * * * * * /home/paulojr/cetraops/infra/scripts/stone-drain.sh
set -euo pipefail
ENV_FILE="${CENTRALOPS_DRAIN_ENV:-$HOME/.stone-drain.env}"   # CENTRALOPS_CRON_SECRET=... e STONE_DRAIN_URL=https://...:3051
# shellcheck disable=SC1090
source "$ENV_FILE"
curl -fsS -m 50 -X POST -H "Authorization: Bearer ${CENTRALOPS_CRON_SECRET}" "${STONE_DRAIN_URL}/api/internal/stone-drain"
echo
