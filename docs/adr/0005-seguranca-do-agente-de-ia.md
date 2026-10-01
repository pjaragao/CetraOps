# ADR-0005 — Segurança do agente de IA

**Contexto.** O texto da cliente é entrada não confiável (injeção de prompt); o agente pode reservar peças, criar pedido e gerar link de pagamento.

**Decisão.**
- O agente só age por **`agent.call_tool(ctx, tool, args)`**, executado pela role `agent_rpc` (sem acesso a tabelas). Organização, cliente e conversa vêm do **token de contexto** (JWT HS256, 10 min, assinado pelo roteador) e são **revalidados no banco**; IDs enviados pelo modelo são descartados.
- Regras de negócio no banco: preço, estoque e totais calculados no banco; reserva limitada; teto de pedido (R$ 1.500 → humano); confirmar pedido exige mensagem real da cliente; link só para pedido confirmado; a IA **não concede desconto** (só aplica cupom válido).
- Saída obrigatória por `propose_reply`; o **validador de guardrails** confere números (preço, estoque, prazo, cupom) contra as ferramentas chamadas **naquela execução**, o formato (≤ 3 bolhas, 600 caracteres), dado pessoal, alegação de saúde e desconto; 1 nova tentativa com o motivo e, depois, rascunho para humano.
- Autopiloto só para uma **lista fechada** de intenções, com confiança ≥ 0,75, fora do VIP Black e dentro da janela; o restante é copiloto/humano.
- Toda chamada de ferramenta fica em `ai.tool_calls` com o resultado completo. O Hermes roda sem terminal/arquivos/web, sem memória e com skills sob revisão; o Plano B (OpenRouter direto) tem o mesmo contrato e entra por circuit breaker.

**Consequências.** Um prompt malicioso não alcança dados de outra cliente nem valores que o banco não calculou; trocar o motor (Hermes ↔ OpenRouter) não muda as garantias.
