# Webhook do WhatsApp (e Instagram) via Vercel — passo a passo

**Por que precisa:** com a API oficial, **enviar** funciona só com o token (o worker chama a Graph API), mas **receber** mensagens
e status (entregue/lida) depende da Meta conseguir chamar uma URL HTTPS pública. No homelab o Supabase só responde pela Tailscale
(`…ts.net:8001`), então a URL que a tela de Integrações mostrava (`…:8001/functions/v1/webhooks-meta`) não é alcançável pela Meta —
e, nesse Supabase, a Edge Function `webhooks-meta` nem está publicada (responde `could not find an appropriate entrypoint`).

**Como fica:** o mesmo relay da Vercel que já recebe a Stone passa a receber a Meta e repassa na hora ao CetraOps:

```
Meta ──HTTPS──▶ stone-relay-seven.vercel.app/api/meta      (infra/stone-relay/api/meta.ts — repassa os bytes, não guarda nada)
                    │ + X-Relay-Secret
                    ▼
     https://mpbflndsk201-wsl.tabby-broadnose.ts.net:10000  (Tailscale Funnel → 127.0.0.1:8090)
                    ▼
     nginx (~/nginx_secure/nginx.conf): /api/pos/* e /api/webhooks/meta, só com o segredo
                    ▼
     CetraOps web 127.0.0.1:3050 /api/webhooks/meta  → confere a assinatura, grava (omni.ingest_webhook) → worker processa
```

- É o mesmo caminho do app da maquininha (`docs/app-maquininha-stone.md`): mesmo Funnel, mesmo segredo `POS_RELAY_SECRET`.
- Quem confere a assinatura `X-Hub-Signature-256` e o token do handshake é o CetraOps; a Vercel só repassa.
- Homelab fora do ar → o relay responde 5xx e a Meta reenvia por vários dias. Cada evento tem chave própria: reenvio não duplica.

## 1. CetraOps (Coolify) — variáveis do app e redeploy

| Variável | Valor |
|---|---|
| `META_VERIFY_TOKEN` | um texto aleatório longo (`openssl rand -hex 24`) — o mesmo vai no painel da Meta |
| `META_APP_SECRETS` | **App Secret** do app da Meta (developers.facebook.com → app → Configurações do app → Básico). Se o Instagram for outro app: `secret_wa,secret_ig` |
| `META_WEBHOOK_URL` | `https://stone-relay-seven.vercel.app/api/meta` (só para a tela de Integrações mostrar a URL certa) |

Redeploy manual. Teste pela Tailscale (deve responder `1234`):
```bash
curl "http://127.0.0.1:3050/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=<META_VERIFY_TOKEN>&hub.challenge=1234"
```

## 2. nginx do Funnel — liberar a rota da Meta

No `~/nginx_secure/nginx.conf`, no mesmo `server` do bloco “app do PDV” (porta 8090), ao lado do `location /api/pos/`, com a mesma
checagem de segredo que esse bloco já usa:
```nginx
location = /api/webhooks/meta {
    if ($http_x_relay_secret != "<POS_RELAY_SECRET>") { return 403; }
    proxy_pass http://127.0.0.1:3050;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $http_x_real_ip;
    proxy_request_buffering on;
    client_max_body_size 2m;
}
```
```bash
sudo nginx -t && sudo nginx -s reload       # ou reinicie o container do nginx, conforme o homelab
sudo tailscale funnel status                # precisa listar :10000 → http://127.0.0.1:8090
sudo tailscale funnel --bg --https=10000 http://127.0.0.1:8090   # se não estiver ligado
```

## 3. Relay da Vercel — publicar a rota nova

```bash
cd ~/cetraops/infra/stone-relay
npx vercel env ls production      # precisa ter POS_UPSTREAM e POS_RELAY_SECRET (os mesmos do app da maquininha)
# se faltarem:
npx vercel env add POS_UPSTREAM production        # https://mpbflndsk201-wsl.tabby-broadnose.ts.net:10000
npx vercel env add POS_RELAY_SECRET production    # o de ~/.stone-relay-secrets
npx vercel deploy --prod
curl "https://stone-relay-seven.vercel.app/api/meta?hub.mode=subscribe&hub.verify_token=<META_VERIFY_TOKEN>&hub.challenge=1234"   # → 1234
```
`503 relay da Meta não configurado` = faltam as variáveis; `504` = Funnel/nginx/web fora; `403` = token errado ou segredo do nginx diferente.
(Opcional: `META_UPSTREAM` e `META_RELAY_SECRET` substituem as do PDV se um dia a Meta precisar de outro destino.)

## 4. Painel da Meta

developers.facebook.com → seu app → **WhatsApp → Configuração** → Webhook → **Editar**:
- **URL de callback:** `https://stone-relay-seven.vercel.app/api/meta`
- **Token de verificação:** o `META_VERIFY_TOKEN`
- **Verificar e salvar**, depois em **Campos do webhook** assine `messages` (status de entrega e leitura chegam por ele).

Confira também que a conta do WhatsApp Business está inscrita no app (sem isso a Meta não manda nada, mesmo com a URL verificada):
```bash
curl -X POST "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps" -H "Authorization: Bearer <TOKEN_DO_SISTEMA>"
curl "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps" -H "Authorization: Bearer <TOKEN_DO_SISTEMA>"   # deve listar o app
```

Instagram (se usar): mesmo app ou outro, mesma URL e token; assine `messages` e `comments`.

## 5. Teste de ponta a ponta

Mande um “oi” de outro celular para o número da loja. Em segundos a conversa aparece na Caixa de entrada. Se não aparecer:
- painel da Meta → Webhooks → **Testar** o campo `messages` e veja o código devolvido;
- logs da Vercel (`npx vercel logs stone-relay-seven.vercel.app`) e do web (`docker logs centralops-web | grep webhooks/meta`);
- `401 invalid signature` = `META_APP_SECRETS` não é o App Secret do app que está mandando;
- `500 webhook not configured` = faltou `META_APP_SECRETS` no Coolify (ou faltou o redeploy).
