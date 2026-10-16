# Webhook da Stone via Vercel (relay) — passo a passo

**Como funciona:** a Stone/Pagar.me envia `charge.paid` / `charge.refunded` para `https://<projeto>.vercel.app/api/stone`.
O relay (`infra/stone-relay`) valida usuário/senha, grava o aviso numa fila (Upstash Redis) e responde 200.
A cada minuto o homelab busca a fila (`infra/scripts/stone-drain.sh` → `/api/internal/stone-drain`), e para cada ordem **confere na API da Stone**
(mesma regra do webhook direto: o corpo do aviso nunca é a fonte da verdade) e baixa o pagamento. O PDV continua consultando sozinho, então o webhook é reforço.

## 1. Gerar os segredos (no homelab)
```bash
for n in WEBHOOK_PASS PULL_TOKEN CRON_SECRET; do echo "$n=$(openssl rand -hex 24)"; done
```
Guarde os três. O usuário do webhook pode ser `stone`.

## 2. Publicar o relay na Vercel
```bash
cd ~/cetraops/infra/stone-relay
npx vercel login            # abre o link no navegador; conta gratuita serve
npx vercel link             # cria o projeto "stone-relay"
```
No painel da Vercel → projeto → **Storage → Create → Upstash for Redis (Marketplace)** (plano grátis) e conecte ao projeto: isso cria `KV_REST_API_URL` e `KV_REST_API_TOKEN`.

Variáveis (Settings → Environment Variables, ambiente Production):

| Nome | Valor |
|---|---|
| `WEBHOOK_USER` | `stone` |
| `WEBHOOK_PASS` | o gerado no passo 1 |
| `PULL_TOKEN` | o gerado no passo 1 |

```bash
npx vercel deploy --prod
curl https://<projeto>.vercel.app/api/health     # {"ok":true,...}
```

## 3. Cadastrar o webhook na Stone
**Formulário "Ativação do Connect Stone"** (só tem o campo URL, sem usuário/senha): em *URL do webhook* use a URL com a chave,
`https://stone-relay-seven.vercel.app/api/stone?key=<WEBHOOK_PASS>` (a chave está em `~/.stone-relay-secrets`). *URL do site* pode ficar vazio ou levar o site da loja.
O relay aceita a chave na URL **ou** Basic Auth, conforme o canal.

- **Connect Stone:** a URL é configurada na ativação do produto — informe à Stone (ou ao seu contato) a URL abaixo.
- **Dashboard Pagar.me:** Conta → Configurações → Webhooks → Criar:
  - URL: `https://<projeto>.vercel.app/api/stone`
  - Usuário/senha (Basic Auth): `stone` / `WEBHOOK_PASS`
  - Eventos: `charge.paid` e `charge.refunded`

## 4. Ligar o homelab ao relay
No Coolify, app CetraOps → variáveis de ambiente (e **redeploy manual**):
```
STONE_RELAY_URL=https://<projeto>.vercel.app
STONE_RELAY_PULL_TOKEN=<PULL_TOKEN>
CENTRALOPS_CRON_SECRET=<CRON_SECRET>
```
Faça o deploy do commit com a rota `/api/internal/stone-drain`. Depois crie o arquivo do cron:
```bash
cat > ~/.stone-drain.env <<EOF
CENTRALOPS_CRON_SECRET=<CRON_SECRET>
STONE_DRAIN_URL=https://mpbflndsk201-wsl.tabby-broadnose.ts.net:3051
