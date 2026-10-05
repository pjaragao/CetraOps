# Infraestrutura de produção — CentralOps

Tudo que roda fora do navegador, versionado aqui para **recriar a VPS em menos de 1 hora**.

```
 Internet ──443──▶ Traefik (Coolify) ──▶ web (Next.js)                        [único serviço público]
                                            │  JWT do usuário + RLS
 Meta / Telegram ──HTTPS──▶ Supabase Edge Functions (webhooks-meta, webhooks-telegram)   ← continuam no ar se a VPS cair
                                            │ grava + enfileira (pgmq)
                                            ▼
                                   Supabase Cloud (sa-east-1): Postgres · Auth · Realtime · Storage · Vault · pg_cron
                                            ▲                ▲
                     worker (filas) ────────┘                └──── mcp (role agent_rpc) ◀── hermes ──▶ OpenRouter
```

| Peça | Onde roda | Como sobe |
|---|---|---|
| Banco, Auth, Realtime, Storage, Vault, pg_cron, Edge Functions | Supabase Cloud (sa-east-1) | migrations pelo workflow **Release** |
| `web`, `worker`, `mcp`, `hermes` | VPS em São Paulo (Docker + Coolify + Traefik) | `infra/docker-compose.prod.yml` |
| Imagens | GHCR (`ghcr.io/<dono>/centralops-{web,worker,mcp}`) | workflow **CI** (main) e **Release** (tags) |

## 1. Contas e pré-requisitos

- **Supabase**: projeto de produção em `sa-east-1` (plano Pro + PITR). Anote: `project ref`, senha do banco, `service_role`, `anon`.
- **Domínio** apontando para o IP da VPS (A/AAAA).
- **GitHub**: Environment `production` com **revisores obrigatórios** (Settings › Environments) — é ele que trava migrations e deploy até alguém aprovar.
  - Variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (a chave anon é pública por desenho), `SUPABASE_PROJECT_REF`.
  - Secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `COOLIFY_DEPLOY_WEBHOOK`, `COOLIFY_TOKEN`.
- **Tailscale** (acesso administrativo à VPS), **OpenRouter** (ZDR + `data_collection: deny` na conta), **Focus NFe**, **Meta**, **Groq** (áudio) — chaves entram só como variáveis do Coolify.

## 2. VPS

Produção: 4 vCPU / 8–16 GB (Ubuntu 24.04 LTS, datacenter em São Paulo). Staging: 2 vCPU / 4 GB — recebe os previews por PR e serve de **standby morno**.

```bash
# 1) como root, na VPS nova (usuário "deploy" com sua chave SSH já criado)
curl -fsSL https://tailscale.com/install.sh | sh && tailscale up          # confira o acesso por ela
sudo ./infra/scripts/harden-vps.sh --ssh-user deploy --tailscale-ssh      # ufw (80/443), SSH só por chave e só pela Tailscale, fail2ban, updates automáticos
# 2) Coolify
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash          # painel em http://<ip-tailscale>:8000
```

> O Docker publica portas **por fora do ufw**. Por isso o compose de produção não publica porta alguma: só o Traefik do Coolify escuta 80/443. Confira de outra máquina: `nmap -Pn -p- <ip>` → apenas **80 e 443**.

## 3. Primeiro deploy

1. Coolify › novo recurso › **Docker Compose** a partir deste repositório, arquivo `infra/docker-compose.prod.yml`.
2. Variáveis (modelo em `infra/.env.example`) como **secretas**. `CENTRALOPS_AGENT_CTX_SECRET`, `CENTRALOPS_MCP_KEY`, `CENTRALOPS_HERMES_KEY`: `openssl rand -hex 32` (o `CENTRALOPS_AGENT_CTX_SECRET` precisa ser **o mesmo** no worker e no MCP).
3. Domínio do `web` = `CENTRALOPS_DOMAIN`. O Traefik emite o TLS (Let's Encrypt).

> **Nome antigo (SIE_\*).** Até outubro de 2026 o produto se chamava de outro jeito e as variáveis tinham o prefixo `SIE_`. Worker, MCP, `centralops-migrate` e o assistente da web ainda aceitam o prefixo antigo (cada `SIE_X` vale como `CENTRALOPS_X` quando esta não existe, com um aviso no log). Renomeie as variáveis no Coolify/.env; depois, o módulo `centralops_agent_contract/legacy_env.py` pode ser apagado. No `docker-compose.prod.yml` (interpolação do Compose) o prefixo antigo **não** é aceito: lá as variáveis precisam ter o nome novo.
4. Imagens: a primeira publicação sai da tag `v0.1.0` (workflow **Release**); o compose usa a tag móvel `prod`.
5. Hermes: use uma imagem **fixada por digest** (`HERMES_IMAGE=nousresearch/hermes-agent@sha256:…`) e siga o checklist `infra/hermes/SPIKE.md` antes de ligar o autopiloto.

## 4. Supabase de produção

- `supabase link --project-ref <ref>` e `supabase db push` (o workflow **Release** faz isso, com aprovação).
- **Schemas expostos** (Project Settings › API): `core, crm, catalog, inv, sales, fin, fiscal, omni, ai, hr, comm, purch`. **Não** exponha `private`, `agent`, `audit`.
- **Role `agent_rpc`**: a migration cria com senha de desenvolvimento — **troque**: `alter role agent_rpc password '<senha forte>'` e use-a em `CENTRALOPS_AGENT_DATABASE_URL`.
- **Vault**: os tokens de integração (WhatsApp, Instagram, Telegram, Focus NFe) ficam no Vault; o nome do segredo vai em `core.integration_connections.secret_ref`.
- **Secrets das Edge Functions**: `supabase secrets set META_VERIFY_TOKEN=… META_APP_SECRETS=app_secret_wa,app_secret_ig TELEGRAM_WEBHOOK_SECRET=…`.
- **pg_cron** já vem agendado pela migration (SLA, janela de 24 h, reservas/armários, DLQ, retenção de 90 dias).

## 5. Webhooks

| Provedor | URL | Segurança |
|---|---|---|
| Meta (WhatsApp + Instagram) | `https://<ref>.supabase.co/functions/v1/webhooks-meta` | `X-Hub-Signature-256` (HMAC-SHA256 do corpo bruto) + `META_VERIFY_TOKEN` no handshake |
| Telegram | `https://<ref>.supabase.co/functions/v1/webhooks-telegram/<bot_id>` | `X-Telegram-Bot-Api-Secret-Token` |

```bash
# Telegram (uma vez por bot)
curl -sS "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<ref>.supabase.co/functions/v1/webhooks-telegram/<bot_id>" -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

As funções só validam, gravam (idempotente por evento) e respondem 200. Se a VPS cair, os eventos ficam na fila `inbound_events` e o worker processa o atraso quando voltar.

## 6. Operação

### Migrations a cada deploy (serviço `migrate`)
Todo `docker compose up` (e todo deploy pelo Coolify) roda primeiro o serviço **`migrate`** (imagem do worker, comando `centralops-migrate`):
1. compara `supabase/migrations` com `supabase_migrations.schema_migrations` (a mesma tabela do `supabase db push`) e aplica as pendentes em ordem, cada uma numa transação;
2. em banco novo (empresa ainda não existe) roda os seeds de configuração `supabase/seed/0*.sql`;
3. confere o **administrador inicial** (`seed/08_initial_admin.sql`): se não houver sócio ativo, ou se a conta do e-mail existir sem vínculo, cria/vincula como Sócio(a) com a senha provisória padrão e troca obrigatória no primeiro acesso.

`web` e `worker` só sobem depois que o `migrate` termina com sucesso; se uma migration falhar, ela é desfeita e a versão nova não sobe sobre banco desatualizado (veja o log com `docker compose logs migrate`). Para só conferir: `docker compose run --rm migrate centralops-migrate --check` (sai com 2 se houver pendência). `CENTRALOPS_DATABASE_URL` precisa ser uma conexão como usuário `postgres` (a mesma do worker); sem ela o `migrate` só registra o aviso no log e não confere nada. No homelab (Coolify, `docker-compose.yml` da raiz) o mesmo passo existe como `centralops-migrate`, lendo o `.env` do deploy.


- **Deploy**: `git tag v1.2.3 && git push --tags` → imagens → **aprovação** → migrations → `prod` reapontada → Coolify troca sem downtime.
- **Rollback**: Actions › **Rollback** › informe a tag anterior (aprovação). Migrations não voltam: corrija com outra migration.
- **Saúde**: `web` `/api/health`; `mcp` `/healthz`; alertas de fila morta (`DLQ_ALERT`) e de integrações chegam no sino do app. Configure heartbeats/uptime no Better Stack e Sentry nos três apps.
- **Logs**: JSON em stdout (`docker logs`, Coolify). Nunca logamos corpo de mensagem nem dado pessoal.

## 7. Backups e restauração

| O quê | Como | Frequência |
|---|---|---|
| Banco (PITR) | Supabase (plano Pro) | contínuo |
| Dump lógico externo | `infra/scripts/backup-db.sh` → R2/S3 (verificado, retenção de 8) | semanal |
| VPS | snapshot do provedor | semanal |
| Volume do Hermes | `hermes-data` incluído no snapshot | semanal |

**Teste de restauração (trimestral)** — um backup que ninguém restaurou não é backup:

```bash
aws s3 cp s3://<bucket>/weekly/centralops-<data>.dump . --endpoint-url <endpoint>
createdb centralops_restore && pg_restore --no-owner -d centralops_restore centralops-<data>.dump
psql centralops_restore -c "select count(*) from sales.orders; select count(*) from fin.journal_entries;"   # confira contra a produção
```

## 8. Recriar a VPS em < 1 h

1. Nova VPS (Ubuntu 24.04) → `harden-vps.sh` → Tailscale → Coolify (≈ 15 min).
2. Coolify: recurso Docker Compose com este repositório + variáveis (guarde uma cópia cifrada das variáveis no cofre de senhas da empresa) (≈ 10 min).
3. DNS para o novo IP; o Traefik emite o TLS (≈ 5 min).
4. Conferir `nmap`, `/api/health`, uma venda de teste e uma mensagem de teste no WhatsApp (≈ 10 min).

O estado de negócio vive no Supabase; a VPS é quase *stateless* (só o volume do Hermes, que é descartável: a memória da cliente fica no banco).

## 9. Checklist de produção (hardening — S7)

- [ ] `nmap -Pn -p- <ip>`: só 80/443
- [ ] SSH: só chave e só pela Tailscale; fail2ban ativo; `unattended-upgrades` ativo
- [ ] Nenhum serviço interno com `ports:` / labels do Traefik (worker, mcp, hermes)
- [ ] `agent_rpc` com senha forte; `service_role` só no worker; chaves antigas (legado) **rotacionadas**
- [ ] Environment `production` com revisores; branch `main` protegida com CI obrigatório
- [ ] OpenRouter: ZDR e `data_collection: deny`; DPA assinado; RoPA atualizado
- [ ] Restauração testada e registrada
