# stone-relay

Mini-app (Vercel) que só existe para ter uma URL pública para o webhook da Stone. Não tem banco nem regra de negócio:
recebe `POST /api/stone` (Basic auth), enfileira no Redis e o homelab busca em `/api/pull` (Bearer) e confere cada ordem na API da Stone.
Passo a passo em `docs/stone-webhook-vercel.md`.
