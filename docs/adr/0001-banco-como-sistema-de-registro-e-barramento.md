# ADR-0001 — Postgres (Supabase) é o sistema de registro e o barramento

**Contexto.** O protótipo antigo guardava tudo em arquivos JSON (corrompidos, sem transações, sem chaves estrangeiras). A plataforma precisa de
consistência financeira, fiscal e de estoque, e de integrações confiáveis (webhooks, notas, pagamentos).

**Decisão.**
- Regras de negócio e invariantes vivem em **funções SQL transacionais** (`sales.finalize_order`, `purch.post_receipt`, `fin.settle`, `private.post_entry`…); a web chama RPCs.
- Partidas dobradas (`fin.journal_entries/lines`) numa **única porta** (`private.post_entry`), idempotente por (livro, tipo, origem); estoque e dinheiro são **livros-razão só de inserção**, corrigidos por estorno.
- Efeitos externos saem por **outbox transacional** (`pgmq.send` na mesma transação); o worker Python consome as filas.
- RLS em todas as tabelas (negado por padrão); permissões em tabela; o Next.js usa o JWT do usuário.
- O app fala com o banco; o **worker** é o único cliente privilegiado (service role); o agente de IA só enxerga `agent.call_tool`.

**Consequências.** Regras testadas com pgTAP (500+ testes), independentes do front; o banco é o gargalo de escrita (aceitável no porte do negócio);
mudanças de regra exigem migration. Supabase Cloud (PITR) em vez de operar Postgres na VPS.
