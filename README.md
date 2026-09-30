# SIÉ JOY OS 2.0 — ERP de varejo + plataforma omnichannel com IA (SIÉ Wear)

Plataforma da **[SIÉ Wear](https://siewear.com/)** para a unidade piloto no **[JOY Wellness Club](https://www.founderjoy.com.br/)** (Florianópolis/SC) e para a expansão em rede.
São duas frentes sobre uma fundação comum:

- **ERP de varejo** — PDV, estoque por grade, NFC-e, financeiro com partidas dobradas e rateio na baixa, conciliação, compras com NF-e, RH integrado à folha/contábil/fiscal, fiscal (Simples/DAS/eSocial).
- **Omnichannel + IA** — inbox única (WhatsApp, Instagram, Telegram), agente de IA com ferramentas seguras (Hermes Agent / OpenRouter), troca IA ↔ humano a qualquer momento, CRM integrado às compras.

> O sistema antigo (protótipo em Python/JSON) foi congelado em [`legacy/`](legacy) e **não é publicado**. As decisões da reconstrução estão em [`docs/adr`](docs/adr).

## Arquitetura

```text
apps/web            Next.js 16 (App Router) + TypeScript + Tailwind — Server Components com o JWT do usuário (RLS), Server Actions → RPCs SQL
apps/worker         Python (psycopg 3 async): consome as filas pgmq — normalizador, roteador de conversas, envio, fiscal, mídia, notificações
apps/agent/
  contract/         contrato do agente: token de contexto (JWT), perfis de ferramentas, esquemas — compartilhado pelo worker e pelo MCP
  mcp_server/       servidor MCP (StreamableHTTP) com as 16 ferramentas do agente; chama agent.call_tool como a role agent_rpc
supabase/
  migrations/       todo o modelo de dados e as regras de negócio (funções SQL transacionais); schemas por domínio
  functions/        Edge Functions de ingresso de webhooks (Meta, Telegram): validam assinatura, gravam e enfileiram
  seed/ · tests/    seeds de configuração/desenvolvimento e testes pgTAP
packages/db         tipos TypeScript gerados do banco   ·   packages/domain  regras compartilhadas (dinheiro, comissão, rateio, menu)
infra/              compose de produção (Coolify/Traefik), hardening da VPS, backups, runbook
legacy/             sistema antigo (congelado)   ·   primeira_unidade_joy/ e plano_de_expansao/  plano de negócios e expansão
```

Princípios: **o Postgres é o sistema de registro e o barramento** (invariantes em funções SQL transacionais; efeitos externos por outbox/pgmq); o **agente não é sistema de registro** (chamado sem estado; histórico, memória e pedidos vivem no banco); tudo é **idempotente** (webhooks, envios, pedidos, notas); a política de **janela das plataformas** é aplicada no servidor.

## Começando (Windows/macOS/Linux)

Requisitos: Node 22, pnpm 10 (`corepack enable`), [uv](https://docs.astral.sh/uv/), Docker.

```bash
pnpm install
npx supabase start                # Postgres + Auth + Realtime + Storage + Edge runtime locais (portas 553xx)
npx supabase db reset             # migrations + seeds (config + dados FICTÍCIOS de desenvolvimento)
cp .env.example .env              # e preencha o necessário
pnpm --filter @sie/web dev        # http://localhost:3000  (usuários de teste: supabase/seed/90_dev_demo.sql)
pnpm worker                       # worker (consome as filas)
```

Sem as chaves da IA o sistema funciona: conversas em modo IA caem para atendimento humano (o rascunho exige `SIE_OPENROUTER_KEY` ou `SIE_HERMES_KEY`).

## Testes e qualidade

| Comando | O que roda |
|---|---|
| `npx supabase test db` | pgTAP — ~500 testes: RLS, ledger, estoque, RH, fiscal, pipeline de mensagens, agente, privilégios, cron |
| `pnpm test:py` | contrato do agente + worker + servidor MCP (contra o Postgres local; cada teste roda numa transação revertida) |
| `pnpm test:edge` | funções de webhook (HMAC, chaves de idempotência) — Node 22 executa o mesmo TypeScript do Deno |
| `pnpm exec turbo run typecheck lint test` | TypeScript: tipos, ESLint e Vitest |
| `pnpm lint:py` | Ruff |
| `npx supabase db lint --local --level error` | verificação das funções PL/pgSQL |

O **CI** (`.github/workflows/ci.yml`) roda tudo isso em cada PR e constrói as imagens Docker; **Release** (tag `vX.Y.Z`) publica, aplica as migrations em produção **com aprovação manual** e implanta no Coolify. Veja [`infra/README.md`](infra/README.md).

## Módulos

Menu por tarefa, protegido por permissões (RBAC + RLS em todas as tabelas):

| Área | Situação |
|---|---|
| **Vender** — PDV multi-pagamento, pedidos remotos, reservas e Armário VIP, trocas/devoluções, entregas, caixa, cupons | pronto |
| **Produtos & Estoque** — catálogo com grade, estoque em livro-razão, importação, compras, recebimento de NF-e com conferência de grade, reposição | pronto |
| **Financeiro** — títulos, baixa com **rateio na liquidação**, razão contábil, DRE, fluxo de caixa, recorrentes, orçamento, fechamento mensal, contratos | pronto |
| **Fiscal** — apuração do Simples/DAS, obrigações, eSocial, notas recebidas, **notas emitidas** (NFC-e pelo worker/Focus NFe: reenviar, cancelar com justificativa, vendas pagas sem nota) | pronto |
| **Configurações** — **integrações** (credenciais no Vault, teste pelo worker, canais de atendimento), contas bancárias, plano de contas, rateios, taxas de cartão | pronto |
| **Equipe (RH)** — admissão, escalas, ponto, férias, folha, rescisão, comissões, acessos — integrados ao financeiro, contábil e fiscal | pronto |
| **Atendimento** — inbox, rascunhos da IA, modos Piloto/Copiloto/Humano, janela de envio | núcleo pronto (automações, templates e desempenho: em construção) |
| **Inteligência** — rotas de modelos por tarefa, custos | parcial (personas, base de conhecimento, sugestões: em construção) |
| **Clientes / Marketing** — ficha 360°, cupons | parcial (funis, tarefas, campanhas, eventos: em construção) |

## Plano de negócios e expansão

O modelo financeiro (Excel com fórmulas nativas) e a documentação de negócio continuam no repositório:

- [`primeira_unidade_joy/`](primeira_unidade_joy) — Plano de Negócios (12 abas), descritivo de CNAEs e 10 notas técnicas (premissas, DRE, cenários, tributário, operação do PDV, riscos, remuneração).
- [`plano_de_expansao/`](plano_de_expansao) — dossiê de expansão high-ticket (mapeamento de academias, modelos Shop-in-Shop/Consignação/Drops, planejamento tributário e societário).
- [`scripts/`](scripts) — gerador do Excel, validador de fórmulas e compiladores de PDF.
- [`PROJECT_INSTRUCTIONS.md`](PROJECT_INSTRUCTIONS.md) — regra de ouro: **toda mudança de premissa deve refletir no Excel e nos `.md`**.

> Decisões de negócio que viram configuração do sistema (não constantes no código): a JOY é **patrocínio + licença de espaço** (não aluguel); faixa 1 do Simples (Anexo I) é 4%; taxas de cartão por modalidade/parcelas/antecipação; pró-labore dos sócios entra no DRE.
