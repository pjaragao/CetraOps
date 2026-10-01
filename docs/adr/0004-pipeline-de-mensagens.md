# ADR-0004 — Pipeline de mensagens

**Contexto.** WhatsApp, Instagram e Telegram entregam webhooks com reentrega e fora de ordem; a IA e os humanos disputam a mesma conversa; as janelas de envio das plataformas são regras duras.

**Decisão.**
1. **Ingresso (Edge Function)**: valida a assinatura sobre o corpo bruto, divide em **um evento por mensagem/status** com chave de idempotência (`wamid:msg`, `mid`, `comment:id`…), grava em `omni.webhook_events` (único por provedor + chave) e enfileira em `inbound_events` **só se o evento é novo**. Responde 200 rápido; se a VPS cair, nada se perde.
2. **Normalizador (worker)** → `omni.ingest_event`: identidade única (telefone E.164 ou handle), conversa aberta/reaberta, mensagem única por (conta, id do provedor), status que só avança.
3. **Roteador** (fila com atraso de 6 s = debounce): pré-regras sem LLM (opt-out, pedido de humano, temas sensíveis), limites (respostas por hora, orçamento diário), agente, **guardrails** e então enviar × rascunho × transferir — com **concorrência otimista** (`conversation.version`): se um humano assumiu durante a execução, a resposta é descartada.
4. **Envio**: a janela (24 h / 7 dias) é decidida no banco; o worker só faz HTTP e classifica os erros (transitório recua e tenta de novo; definitivo marca FAILED).
5. Ordem das mensagens por `(created_at, seq)`: `created_at` é o horário do provedor (segundos) e `seq` desempata.

**Consequências.** Reentregas e rajadas são inofensivas; erros de política não são retentados; tudo é auditável por `webhook_event → message → ai.run → mensagem de saída`.
