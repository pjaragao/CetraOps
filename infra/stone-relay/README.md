# stone-relay

Mini-app (Vercel) com as URLs públicas do CetraOps, que mora no homelab (só na Tailscale):

- **Webhook da Stone** — recebe `POST /api/stone` (Basic auth), enfileira no Redis e o homelab busca em `/api/pull` (Bearer) e confere cada ordem na API da Stone. Passo a passo em `docs/stone-webhook-vercel.md`.
- **App do PDV na maquininha** — `/api/pos/*` é repassado na hora ao homelab pelo Tailscale Funnel (`POS_UPSTREAM`), com o segredo `POS_RELAY_SECRET` que o nginx do homelab confere. Passo a passo em `docs/app-maquininha-stone.md`.

Não tem banco nem regra de negócio.
