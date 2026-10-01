# Spike do Hermes Agent (S0) — critério de go/no-go

O Hermes é o "cérebro conversacional", mas **não** é o sistema de registro e tem um Plano B pronto (o worker chama o OpenRouter direto com as
mesmas ferramentas — `OpenRouterAgent`). Antes de ligar o autopiloto, valide na versão **fixada por digest**. Registre o resultado abaixo.

## Como rodar

```bash
# 1) stack local do banco + MCP + Hermes (perfil concierge) — ajuste o digest
docker compose --env-file infra/.env -f infra/docker-compose.prod.yml up -d mcp hermes
# 2) crie o perfil e copie o config (volume hermes-data)
docker exec hermes hermes profile create concierge
# 3) dispare conversas reais de teste pelo número de teste da Meta e acompanhe em ai.runs / ai.tool_calls
```

## Checklist

| # | Verificação | Resultado |
|---|---|---|
| 1 | Provider **OpenRouter** funciona com 2–3 modelos candidatos de conversa | |
| 2 | **Prompt caching** repassado: `cache_read_tokens > 0` em `ai.runs` a partir da 2ª mensagem da mesma conversa | |
| 3 | ZDR e `data_collection: deny` aplicados nas chamadas (cabeçalhos/`provider` do OpenRouter) | |
| 4 | Tool calling confiável em PT-BR (chama `propose_reply` ao final em ≥ 98 % das execuções) | |
| 5 | MCP via StreamableHTTP com **allowlist** (`tools.include`) e `resources/prompts` desligados | |
| 6 | p95 < 15 s com 3 chamadas de ferramenta | |
| 7 | 20 execuções concorrentes sem 429 (`gateway.api_server.max_concurrent_runs`) | |
| 8 | Memória e skills desligadas no perfil `concierge` (nenhum arquivo novo em `memories/` e `skills/`) | |
| 9 | O campo `model` da requisição é **honrado**? Se não, a rota `conversation` de `ai.model_routes` vale só para o Plano B | |
| 10 | O token `ctx` no prompt volátil não vaza para o texto final (validador de guardrails) | |

## Decisão

- **GO**: todos os itens ✔ → `SIE_HERMES_BASE=http://hermes:8642/p/concierge/v1` (ou `/v1`, conforme o item de roteamento por perfil) e `SIE_HERMES_KEY` no worker.
- **NO-GO**: deixe `SIE_HERMES_KEY` vazio e configure `SIE_OPENROUTER_KEY` — o worker usa automaticamente o Plano B, com o mesmo contrato de ferramentas
  (`agent.call_tool`), os mesmos guardrails e o mesmo registro em `ai.tool_calls`.

> Se o Hermes falhar em produção (timeouts/5xx), o roteador cai para rascunho/humano (circuit breaker por execução); trocar para o Plano B é só trocar as variáveis.
