# Hermes do CentralOps (LLM = AGY)

Instância **exclusiva** do Hermes Agent para o CentralOps, separada dos bots (luisa-bot, sie-joy-bot, mr-irrelevant). Ela é só o
motor de linguagem: o modelo é o **AGY** (Antigravity CLI, Gemini Flash) pelo shim OpenAI-compatível do host, sem custo por token.

```
web (Central) ─┐                                   ┌─ systemd --user agy-shim (172.26.0.1:8787, ~/mr-irrelevant/ops/agy_shim.py)
               ├─▶ centralops-hermes:8642/v1 ──────┤
worker ────────┘   (rede services_internal)        └─▶ agy -p … (CLI, sem ferramentas próprias)
```

## Como usar no CentralOps

Inteligência › **Modelos & custos**: o seletor (com busca) de qualquer rota lista cada modelo do AGY em cada nível de pensamento
(`hermes/agy/<id do agy models>`, ex.: `hermes/agy/claude-sonnet-5-5-high`) e o padrão `hermes/agy` (Gemini Flash mais novo, baixo).
Também dá para clicar em **Usar Hermes** (o modelo atual vira reserva). Principal e reservas podem misturar Hermes e OpenRouter: se um lado falhar, o outro tenta.

- Ferramentas: o API server do Hermes ignora `tools`, então o CentralOps descreve as ferramentas no prompt e o modelo pede uma por
  linha `TOOL_CALL {...}` (`apps/web/lib/central/hermes.ts`, `apps/worker/centralops_worker/ai/hermes_llm.py`). A ferramenta roda
  no CentralOps, com a sessão/RLS (Central) ou o ctx assinado (atendimento) de sempre.
- JSON: o schema vai no prompt e a resposta é validada como antes.
- Modelo escolhido: o CentralOps manda `provider: "agy"` + `model: <id>`; o Hermes repassa ao shim, que roda esse id no `agy`
  (ids fora do catálogo, como o alias `gemini-flash-latest` dos bots, seguem a resolução padrão).
- Imagem e PDF (`vision_extract`, anexos da Central): a imagem vai como `image_url` pelo Hermes; o API do Hermes recusa PDF, então o
  web sobe o arquivo para o shim (`POST /v1/files`, 15 min em memória) e manda `[[agy-file:<id>]]`. O shim grava os anexos na pasta
  temporária da execução e o `agy` abre esses arquivos (somente leitura, `--sandbox`).
- **Não serve** para `embeddings` (não gera vetores): a tela bloqueia.
- Atendimento ao cliente (`conversation`): precisa passar nas Avaliações da IA como qualquer modelo (`hermes/agy` é aceito lá).
- Latência: 5 a 60 s por chamada (o AGY é um CLI). O shim roda até `AGY_SHIM_PARALLEL` (2) chamadas ao mesmo tempo, dividido com os bots.

## Variáveis (Coolify, app CetraOps → web e worker)

| Variável | Valor |
|---|---|
| `CENTRALOPS_HERMES_LLM_KEY` | `API_SERVER_KEY` de `~/centralops-hermes/data/.env` |
| `CENTRALOPS_HERMES_LLM_BASE` | opcional; padrão `http://centralops-hermes:8642/v1` |
| `CENTRALOPS_AGY_SHIM_TOKEN` | (só web) `AGY_SHIM_TOKEN` do shim: necessário para PDF e para o catálogo ao vivo |
| `CENTRALOPS_AGY_SHIM_URL` | opcional; padrão `http://172.26.0.1:8787/v1` |

Sem a chave, as rotas `hermes/*` caem nas reservas do OpenRouter (se houver).

## Subir / atualizar

```bash
mkdir -p ~/centralops-hermes/data
cp infra/hermes/central/docker-compose.yml ~/centralops-hermes/
cp infra/hermes/central/{config.yaml,SOUL.md} ~/centralops-hermes/data/
# data/.env (modo 600): TZ, HERMES_UID/GID=1000, AGY_SHIM_TOKEN/HOST/PORT/URL (iguais aos dos bots),
#   API_SERVER_KEY=<openssl rand -hex 24>, API_SERVER_HOST=0.0.0.0, API_SERVER_PORT=8642, API_SERVER_MODEL_NAME=hermes-agy
cd ~/centralops-hermes && docker compose up -d
curl -s http://127.0.0.1:8648/health
```

Imagem fixada pelo mesmo digest dos bots. Na migração para a VPS, o contêiner precisa estar na mesma rede do web/worker e o shim
do AGY (com o login do `agy`) precisa ir junto — ou a rota volta para um modelo do OpenRouter.
