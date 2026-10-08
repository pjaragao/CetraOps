# Plano: campanhas segmentadas (público, oferta, canais e resultado num só fluxo)

> **Versão 1.0 · 08/10/2026 · documento de planejamento. Nada aqui foi implementado.**
> Base analisada: `main` em `e5de167`.

**Conteúdo**
- Parte 1: como está hoje (página a página)
- Parte 2: o que está quebrado no fluxo
- Parte 3: modelo proposto
- Parte 4: o fluxo novo (telas)
- Parte 5: tarefas de implementação, por fase
- Anexo: decisões em aberto

---

## Parte 1 — Como está hoje

São seis peças soltas. Nenhuma sabe da existência das outras.

| Peça | Tela | Banco | O que faz | Liga com |
|---|---|---|---|---|
| **Campanha** | `/marketing` (lista + "Nova campanha") → `/marketing/campanhas/[id]` | `mkt.campaigns`, `mkt.campaign_recipients`, `crm.audience(jsonb)` | Disparo de **um** template de WhatsApp para um público filtrado. Prévia, consentimento, limite diário, intervalo entre mensagens. Resultado = comprou em até 7 dias. | Nada. Não tem cupom, link nem anúncio. |
| **Cupom** | `/marketing/cupons` | `sales.coupons` (+ `party_id` pessoal, `affiliate_party_id`) | Cria um código (insert direto na tabela, sem RPC). Lista **todos** os cupons, inclusive os pessoais de aniversário. | Afiliada (opcional). Não sabe de qual campanha veio. |
| **Link rastreado** | `/marketing/links` | `mkt.tracking_links`, `mkt.attribution_touches` | Link wa.me / t.me com `(ref: código)`; o toque é gravado quando a **mensagem chega**. | Afiliada e evento (opcionais). Nenhuma campanha. Clique sem mensagem não aparece. |
| **Afiliada** | `/clientes/afiliados` (em Clientes, não em Marketing) | `aff.affiliates`, `aff.statements` | Cria a trainer + cupom dela; extrato de comissão. | Cupom sim; o link/QR da trainer precisa ser criado à mão em outra tela. |
| **Anúncios Meta** | `/marketing/anuncios` | `mkt.ad_insights_daily`, `mkt.ad_sync_state`, `mkt.capi_events` | Só **leitura** dos resultados (gasto, alcance) e cruzamento com quem chegou por Click-to-WhatsApp. CAPI envia Purchase. | Nenhuma campanha do sistema, nenhum público. |
| **Régua** | `/marketing/reguas` | `mkt.journeys`, `journey_enrollments` | Automação por gatilho (aniversário, inativa…). A régua de aniversário **já** gera cupom pessoal (`private.ensure_journey_coupon`) e tem relatório de cupom (`mkt.journey_coupon_report`). | É o único lugar onde cupom + mensagem + resultado já conversam. |

O que já é bom e vai ser reaproveitado:
- `crm.audience` + `private.campaign_skip_reason` (consentimento, telefone, intervalo) — regra certa, no banco.
- Fila `campaign_tasks` + worker `handlers/campaigns.py` (envio em lote, limite diário).
- `private.ensure_journey_coupon` / `sales.party_auto_coupon` (cupom pessoal que entra sozinho no PDV).
- `mkt.attribution_touches` (primeiro e últimos toques) e `sales.orders.attribution` (já previsto para campanha, anúncio, cupom, utm).
- `MetaClient` no worker (Graph API, insights, CAPI) e a conexão `META_ADS` em Integrações.

## Parte 2 — O que está quebrado no fluxo

**Fluxo de hoje para "mandar 10% para quem não compra há 60 dias":**
1. Ir em Cupons, inventar um código, criar.
2. Ir em Atendimento › Templates, escrever um template com o código **digitado no texto**, mandar para aprovação, esperar.
3. Ir em Marketing, criar rascunho escolhendo o template (o público já entra como "Cliente + VIP" sem perguntar).
4. Abrir a campanha, preencher filtros, **salvar** para ver a prévia, voltar e lançar.
5. Se quiser link/QR para o story: ir em Links e criar outro, sem relação com a campanha.
6. Resultado: "comprou em 7 dias" — sem saber se foi pelo cupom, pela mensagem ou se compraria de qualquer jeito.

**Problemas por tela**

*Campanhas (`marketing/page.tsx`, `campanhas/[id]/page.tsx`, `actions.ts`)*
- Começa pelo template (detalhe técnico) e não pelo objetivo/público.
- Público é um JSON dentro da campanha: o comentário da migration diz "reutilizável", mas não existe público salvo.
- Filtros pobres para segmentar: não há valor gasto, nº de pedidos, o que comprou (categoria/coleção/tamanho), origem (link/anúncio), lead sem compra criado em X dias, exclusão ("menos quem…").
- Prévia só depois de salvar; o botão "Lançar" usa a última prévia salva, não o formulário na tela.
- Variáveis do template só aceitam nome ou texto fixo — não dá para mandar **cupom pessoal**, validade ou link.
- Um disparo por campanha: não existe "lembrete em 3 dias para quem não comprou".
- Lista carrega até 20.000 linhas de `campaign_recipients` no servidor web só para contar progresso.
- Resultado sem grupo de controle: "comprou em 7 dias" superestima o efeito (as réguas já têm holdout; campanhas não).

*Cupons (`cupons/page.tsx`, `coupon-form.tsx`, `vender/actions.ts`)*
- Bug: cupom pessoal mostra o dono duas vezes (`só X` e `pessoal · X`, este último lendo o mapa de afiliadas — `cupons/page.tsx:41`).
- Lista mistura cupons de campanha, de afiliada e centenas de pessoais de aniversário.
- Sem edição, sem RPC (insert direto), sem `campaign_id`, sem origem.
- Não há cupom em lote (um por pessoa do público).

*Links (`links/page.tsx`)*
- Não pertencem a nenhuma campanha.
- Só abrem WhatsApp/Telegram; não há link para site/landing com UTM (necessário para anúncio de tráfego).
- Clique que não vira mensagem é invisível (não dá para medir taxa de conversão do link).

*Afiliados (`clientes/afiliados/page.tsx`)*
- Cadastro cria cupom, mas não o link/QR da trainer.
- Fica em Clientes; o resto do marketing está em Marketing.
- Não há como uma campanha usar "o cupom de cada afiliada" (ex.: drop divulgado pelas trainers).

*Anúncios Meta (`anuncios/page.tsx`)*
- Só leitura. Não há: público personalizado a partir da base, lookalike, vínculo com a campanha do sistema, nem custo do anúncio entrando no ROI da campanha.
- Receita só conta Click-to-WhatsApp; quem viu o anúncio e usou o cupom do anúncio na loja não aparece.

## Parte 3 — Modelo proposto

**Ideia central: a Campanha vira o "guarda-chuva".** Tudo o que existe passa a pendurar nela.

```
Campanha (objetivo, período, orçamento, status)
 ├─ Público ........ segmento salvo (base local) e/ou público Meta (personalizado, semelhante, geral)
 ├─ Oferta ......... sem cupom | código único | cupom pessoal por pessoa | cupom de cada afiliada
 ├─ Canais
 │   ├─ WhatsApp ... 1..N disparos (principal + lembretes para quem não comprou/não abriu)
 │   ├─ Links/QR ... gerados automaticamente (story, bio, impresso), um por afiliada se houver
 │   └─ Anúncio .... público enviado para a Meta + campanhas da Meta vinculadas
 └─ Resultado ...... atribuição única: cupom > link/anúncio > mensagem recebida; grupo de controle; custo e ROI
```

### Tabelas novas / alteradas

| Objeto | Tipo | Conteúdo |
|---|---|---|
| `mkt.segments` | nova | `id, name, description, definition jsonb, kind (DYNAMIC/STATIC), cached_count, cached_at, created_by`. Estático guarda lista congelada em `mkt.segment_members`. |
| `crm.audience(jsonb)` | evolui | Filtros novos (abaixo), bloco `exclude` com a mesma forma, `segment_id` (compor segmentos), reescrita set-based. |
| `mkt.campaigns` | altera | + `objective`, `segment_id`, `audience_scope (LOCAL/META/BOTH)`, `starts_at`, `ends_at`, `budget`, `holdout_pct`, `attribution_days`, `code` (slug curto). `channel_account_id`/`template_id` saem daqui (vão para o disparo). Status: `DRAFT → ACTIVE → ENDED / CANCELLED`. |
| `mkt.campaign_dispatches` | nova | Disparo de WhatsApp da campanha (o que hoje é a campanha): `template_id, channel_account_id, variables, scheduled_at, frequency_cap_days, daily_limit, status, filter (ALL / NOT_BOUGHT / NOT_READ / NOT_REPLIED)`. `campaign_recipients` passa a apontar para o disparo. |
| `mkt.campaign_offers` | nova | 1 por campanha: `mode (NONE/SHARED/PERSONAL/AFFILIATE), kind, value, min_order, per_customer_limit, max_uses, valid_days ou valid_to, code_prefix, shared_coupon_id`. |
| `sales.coupons` | altera | + `campaign_id`, `source (MANUAL/CAMPAIGN/JOURNEY/AFFILIATE/REFERRAL)`, `updated_at`. |
| `mkt.tracking_links` | altera | + `campaign_id`, `target (WHATSAPP/TELEGRAM/WEB)`, `target_url`, `utm jsonb`. |
| `mkt.link_clicks` | nova | Clique no link curto `/r/<código>` (hora, user-agent resumido, fbclid/utm, sem IP guardado). |
| `mkt.ad_audiences` | nova | Segmento ↔ público personalizado da Meta: `segment_id, ad_account, meta_audience_id, kind (CUSTOM/LOOKALIKE), source_audience_id, last_sync_at, uploaded, matched, last_error`. |
| `mkt.campaign_ad_links` | nova | Campanha do sistema ↔ campaign_id da Meta (vínculo manual ou automático pela tag `[c:codigo]` no nome). |
| `mkt.campaign_members` | nova | Quem é público da campanha e em que grupo: `party_id, group (TREATMENT/HOLDOUT), coupon_id`. Congela no lançamento. |
| `crm.consent_purpose` | enum | + `MARKETING_ADS` (uso de contato em público personalizado da Meta — LGPD). |

### Filtros de segmento (base local)

Todos opcionais, combinados com E; `exclude` com a mesma forma:
- **Ciclo/qualidade** (já existem): estágio, tier, score mínimo, cidade, etiqueta, aniversário no mês, evento/RSVP.
- **Compra (RFM):** última compra entre X e Y dias; 1ª compra entre datas; nº de pedidos (mín/máx); total gasto no período (mín/máx); ticket médio; comprou categoria/coleção/produto/tamanho; nunca comprou (lead).
- **Lead:** criada há até N dias; origem (`source`), link rastreado, anúncio (ad_id/campanha Meta), indicada por afiliada; etapa de funil; negócio perdido (motivo).
- **Relacionamento:** tem cupom ativo não usado; recebeu campanha X; **não** recebeu marketing há N dias; respondeu nos últimos N dias; CSAT/NPS.
- **Canal alcançável:** tem WhatsApp + consentimento; tem e-mail; tem consentimento `MARKETING_ADS`.

A prévia devolve: total, alcançáveis por canal (WhatsApp, Meta), motivos de exclusão, amostra e distribuição (por estágio, tier).

### Atribuição (uma regra só, no banco)

Para cada pedido pago dentro de `starts_at .. ends_at + attribution_days`:
1. **Direta – cupom:** usou cupom com `campaign_id` → da campanha (mais forte).
2. **Direta – toque:** primeiro/último toque por link ou anúncio da campanha na janela.
3. **Influenciada – mensagem:** estava no grupo TREATMENT, recebeu disparo e comprou na janela.

Gravada em `sales.orders.attribution.campaign_id` + `attribution.kind` no fechamento do pedido (trigger), para o relatório não recalcular tudo. **Lift** = taxa de compra TREATMENT − HOLDOUT (mesma lógica de `mkt.report_journeys`).
Custo da campanha = desconto concedido + comissão de afiliada + gasto Meta vinculado + custo estimado por template enviado (configurável). ROI = (receita atribuída − custo) ÷ custo.

## Parte 4 — O fluxo novo (telas)

### Menu Marketing (reorganizado)
1. **Visão geral** — campanhas ativas, receita atribuída no mês, próximos disparos, alertas (template reprovado, Meta desconectada, número sem endereço público).
2. **Campanhas** — lista + "Nova campanha".
3. **Públicos** — segmentos salvos com contagem e "enviar para Meta".
4. **Cupons** — com filtro por origem; pessoais agrupados ("Aniversário: 132 emitidos, 41 usados").
5. **Links & QR**
6. **Anúncios Meta**
7. **Afiliadas** (movida de Clientes; Clientes mantém atalho)
8. **Réguas**, **Eventos & Drops**, **Check-in** (como hoje)

### Assistente "Nova campanha" (`/marketing/campanhas/nova`) — 5 passos, salva rascunho a cada passo

1. **Objetivo** — cartões com predefinições que preenchem os passos seguintes:
   - *Reativar inativas* (sem compra há 60–180 dias · cupom pessoal 10% · WhatsApp + lembrete D+3).
   - *Lançamento / drop* (clientes + leads quentes · sem cupom ou código único · WhatsApp + story/QR + público Meta).
   - *Captar leads* (público geral Meta · código único de 1ª compra · link CTWA).
   - *Converter leads* (leads sem compra, criadas há ≤ 30 dias · cupom pessoal · WhatsApp).
   - *VIP / fidelização*, *Evento*, *Queima de estoque*, *Personalizada*.
   - Aniversário aponta para a régua existente (é automação, não campanha pontual).
2. **Público** — escolher *Base local* (segmento salvo ou filtros na hora, contagem ao vivo, "salvar como público") e/ou *Meta* (enviar este público como personalizado · criar semelhante 1–5% · público geral, segmentado no Gerenciador). Mostra alcance por canal e grupo de controle (padrão 10%).
3. **Oferta** — Sem cupom · Código único (`DROP10`) · Cupom pessoal por pessoa (prefixo + validade em dias, gerado no lançamento, entra sozinho no PDV) · Cupom de cada afiliada. Regras: valor, mínimo, limite por cliente, validade.
4. **Canais** —
   - *WhatsApp*: escolher template aprovado; variáveis aceitam **primeiro nome, nome, texto, cupom, desconto, validade, link**; agendar; adicionar lembrete (para quem não comprou / não leu).
   - *Links & QR*: criados automaticamente (`<codigo>-story`, `<codigo>-bio`, `<codigo>-qr`, um por afiliada), com cópia e QR.
   - *Anúncio Meta*: status do público enviado; tag `[c:<codigo>]` para colocar no nome da campanha da Meta (vínculo automático) ou escolher manualmente da lista sincronizada; link e código para usar no criativo.
5. **Revisão** — checklist bloqueante (template aprovado, endereço público do canal, Meta conectada se usada, consentimento), mensagem renderizada com cupom de exemplo, custo estimado, dias para concluir o envio. **Lançar**.

### Página da campanha (`/marketing/campanhas/[id]`) — abas
- **Resultado**: funil (público → alcançadas → entregues → leram → clicaram/responderam → compraram), receita direta × influenciada, lift vs. controle, custo, ROI, gráfico diário.
- **Pessoas**: destinatárias com grupo, status do envio, cupom e se comprou; exportar CSV; "criar tarefa para quem respondeu e não comprou".
- **Oferta**: cupons emitidos/usados/desconto dado.
- **Canais**: disparos (com cancelar), links/QR com cliques e conversas, anúncios vinculados com gasto.
- **Configuração**: o que dá para mudar depois de ativa (fim, lembretes novos).

### Atalhos de contexto
- Em **Clientes & Leads**: filtros da lista → "Salvar como público" / "Criar campanha com estas pessoas".
- Em **Públicos**: "Criar campanha", "Enviar para a Meta", "Convidar para evento" (reaproveita `mkt.invite_audience`).
- Em **Afiliadas**: cadastrar já cria cupom **e** link/QR da trainer.

## Parte 5 — Tarefas de implementação

Convenções do repositório: migration em `supabase/migrations/2026MMDDhhmmss_*.sql` com RPC `security definer` + `private.require_perm` + `rpc_only`; teste pgTAP em `supabase/tests/0NN_*_test.sql`; teste e2e em `apps/web/e2e/*.e2e.ts`; regra pura em `packages/domain` com teste unitário; worker em `apps/worker` com teste em `apps/worker/tests`.

### Fase 0 — Correções rápidas (independentes, ~1 dia)
- [ ] **0.1** `cupons/page.tsx:41`: remover o rótulo duplicado de cupom pessoal (o segundo lê `aff`, mapa de afiliadas).
- [ ] **0.2** Lista de campanhas: trocar a leitura de 20.000 `campaign_recipients` por RPC `mkt.campaign_progress()` agregada.
- [ ] **0.3** Rascunho novo não assume "Cliente + VIP" em silêncio: o público começa vazio e a prévia diz "escolha um público".
- [ ] **0.4** Página da campanha: botão "Salvar e ver prévia" e lançar só se não houver alteração não salva (ou salvar+lançar na mesma action).
- [ ] **0.5** Cupons: RPC `sales.save_coupon(p jsonb)` (criar/editar, valida pessoal × afiliada, % ≤ 100) e trocar o insert direto em `vender/actions.ts`; adicionar edição na tela.
- [ ] **0.6** Lista de cupons: filtro por tipo (campanha / afiliada / pessoal / avulso) e pessoais recolhidos por padrão.

### Fase 1 — Públicos (segmentos)
- [ ] **1.1 Migration `segments.sql`**: `mkt.segments`, `mkt.segment_members`, RPCs `mkt.save_segment`, `mkt.delete_segment`, `mkt.segment_preview(p_def jsonb)` (contagem, alcançáveis por canal, motivos, amostra, distribuição), `mkt.refresh_segment_count` (cron diário para `cached_count`).
- [ ] **1.2 `crm.audience` v2** (mesma assinatura, compatível com o JSON antigo): filtros de compra/RFM, lead, origem/link/anúncio, afiliada, cupom ativo, recebeu/não recebeu campanha, respondeu; bloco `exclude`; `segment_id`; reescrita set-based com CTE de agregados de pedido (sem loop por pessoa). Índices de apoio em `sales.orders (party_id, status, created_at)` se faltarem.
- [ ] **1.3** Prévia set-based de `campaign_skip_reason` (uma query com `left join` em consentimento/telefone/última mensagem de marketing) para não iterar 5.000 linhas.
- [ ] **1.4** Tipos e montagem do filtro em `packages/domain/src/segments.ts` (schema zod da definição, rótulos, "descrição em português" do filtro: "Clientes que não compram há 60–180 dias, exceto VIP") + testes.
- [ ] **1.5** Tela `/marketing/publicos` (lista, criar/editar com contagem ao vivo via action debounced, duplicar, excluir) — componente `SegmentBuilder` reutilizável (vai para o assistente e para Clientes).
- [ ] **1.6** Em `/clientes`: "Salvar filtros como público" e "Criar campanha com estas pessoas".
- [ ] **1.7** Testes: pgTAP `061_segments_test.sql` (cada filtro, exclusão, papéis internos nunca entram, anonimizadas/mescladas fora, compatibilidade com JSON antigo); e2e `publicos.e2e.ts`.

### Fase 2 — Campanha guarda-chuva, oferta e disparos
- [ ] **2.1 Migration `campaign_hub.sql`**:
  - `mkt.campaign_dispatches` e migração dos dados (cada campanha atual vira campanha + 1 disparo; `campaign_recipients.dispatch_id`).
  - Alterar `mkt.campaigns` (objetivo, segmento, escopo, período, orçamento, holdout, janela, código, status novo); `mkt.campaign_members`.
  - `mkt.campaign_offers`; `sales.coupons.campaign_id/source/updated_at` (backfill: `affiliate_party_id` → AFFILIATE, cupom ligado a `journey_enrollments` → JOURNEY).
  - RPCs: `mkt.save_campaign` (v2, por passos), `mkt.save_campaign_offer`, `mkt.save_dispatch`, `mkt.campaign_checklist(id)` (pendências bloqueantes), `mkt.launch_campaign` (congela membros, sorteia holdout, emite cupons, agenda disparos), `mkt.end_campaign`, `mkt.cancel_dispatch`.
- [ ] **2.2 Cupom de campanha**: generalizar `private.ensure_journey_coupon` em `private.issue_personal_coupon(p_party, p_offer jsonb, p_source, p_ref)` (código `PREFIXO-NOME4X`, sem colisão) e usar na régua e na campanha. Código único: cria 1 cupom `source=CAMPAIGN`. Afiliada: usa o cupom de cada afiliada ativa, sem duplicar. `sales.party_auto_coupon` passa a escolher o **melhor** cupom vigente (maior desconto) e devolver a origem.
- [ ] **2.3 Variáveis de template**: novas fontes `COUPON_CODE`, `COUPON_VALUE`, `COUPON_EXPIRY`, `LINK`, `CAMPAIGN_END` em `save_dispatch` e no worker (`handlers/campaigns.py` resolve por destinatária); `renderTemplate` em `packages/domain` com os exemplos.
- [ ] **2.4 Lembretes**: disparo com filtro `NOT_BOUGHT / NOT_READ / NOT_REPLIED` calculado no momento do envio sobre o TREATMENT; respeita `frequency_cap_days` (lembrete da mesma campanha conta como exceção configurável, máx. 1).
- [ ] **2.5 Assistente** `/marketing/campanhas/nova` (5 passos, rascunho salvo a cada passo, predefinições por objetivo em `packages/domain/src/campaign-presets.ts`).
- [ ] **2.6 Página da campanha em abas** (Resultado, Pessoas, Oferta, Canais, Configuração) substituindo `campanhas/[id]/page.tsx`; lista `/marketing/campanhas` com objetivo, período, público, receita atribuída.
- [ ] **2.7** "Criar template a partir da campanha": abre Atendimento › Templates com texto sugerido já com `{{1}}` nome e `{{2}}` cupom.
- [ ] **2.8 Testes**: pgTAP `062_campaign_hub_test.sql` (migração de dados antigos, holdout sorteado e estável, cupom pessoal único por pessoa, consentimento revogado no meio, lembrete só para quem não comprou, cancelar disparo); worker `test_db_campaigns.py` (variáveis de cupom); e2e `campanha.e2e.ts` (assistente ponta a ponta com cupom pessoal → venda no PDV com cupom automático).

### Fase 3 — Links curtos, QR e afiliadas unificadas
- [ ] **3.1 Migration `links_v2.sql`**: `tracking_links.campaign_id/target/target_url/utm`, `mkt.link_clicks`, RPC pública `mkt.resolve_link(code, meta jsonb)` (grava clique e devolve destino; só `active`).
- [ ] **3.2 Rota pública** `apps/web/app/r/[code]/route.ts`: registra clique e redireciona (wa.me com `(ref:)`, t.me, ou URL web com UTM `utm_campaign=<codigo>`). QR passa a apontar para `/r/<code>` (o QR impresso continua valendo se o destino mudar).
- [ ] **3.3** Lançar campanha cria os links dela (`<codigo>-story`, `-bio`, `-qr`, e um por afiliada se a oferta for AFFILIATE).
- [ ] **3.4** `/marketing/links`: coluna Campanha, filtro, cliques × conversas × compras.
- [ ] **3.5 Afiliadas**: `aff.save_affiliate` cria também o link `TRAINER` (código = cupom em minúsculas); tela mostra link + QR; mover para `/marketing/afiliadas` (redirect da rota antiga, atalho em Clientes).
- [ ] **3.6** Pedido com cupom de afiliada grava `attribution.affiliate_party_id` (se ainda não grava) para o relatório de campanha.
- [ ] **3.7 Testes**: pgTAP `063_links_v2_test.sql`; e2e `links.e2e.ts` ampliado (clique → mensagem → toque → compra).

### Fase 4 — Atribuição e resultado unificados
- [ ] **4.1 Migration `campaign_attribution.sql`**: trigger no pedido pago que grava `attribution.campaign_id/kind (COUPON/LINK/AD/MESSAGE)` pela regra da Parte 3; função de recálculo para pedidos antigos.
- [ ] **4.2** `mkt.campaign_results(id)` v2: funil, direta × influenciada, lift TREATMENT × HOLDOUT, custo (desconto + comissão + Meta + mensagens), ROI, série diária. Configuração `core.settings` `campaign_costs` (custo por template de marketing).
- [ ] **4.3** `crm.report_acquisition` e `mkt.ads_overview` passam a considerar também cupom/link da campanha (venda na loja com cupom do anúncio conta para o anúncio vinculado).
- [ ] **4.4** Visão geral de Marketing (`/marketing`): campanhas ativas, receita atribuída no mês, próximos disparos, alertas.
- [ ] **4.5** Ficha da cliente (`/clientes/[id]`): linha do tempo "recebeu campanha X · usou cupom Y · veio pelo link Z".
- [ ] **4.6 Testes**: pgTAP `064_campaign_attribution_test.sql` (prioridade cupom > toque > mensagem, um pedido conta para uma campanha só, devolução abate receita).

### Fase 5 — Meta Ads: públicos e vínculo
- [ ] **5.1 Consentimento** `MARKETING_ADS` no enum + onde se coleta (cadastro rápido, ficha, opt-in pelo WhatsApp). Sem ele, a pessoa não sobe para a Meta. Texto LGPD revisado.
- [ ] **5.2 Worker – adapter** (`adapters/meta.py`): `create_custom_audience`, `replace_audience_users` (sessão de substituição, lotes de 10k, telefone/e-mail normalizados + SHA-256), `create_lookalike(source, country=BR, ratio)`, `list_campaigns(ad_account)`; normalização em `normalizer/meta.py`.
- [ ] **5.3 Migration `ad_audiences.sql`**: `mkt.ad_audiences`, RPCs `mkt.request_audience_sync(segment_id)`, `mkt.request_lookalike(ad_audience_id, ratio)`, `mkt.audience_upload_rows(id)` (só service role: devolve contatos já filtrados por consentimento), `mkt.ad_audience_set` (resultado). Ação na fila `campaign_tasks` (`AUDIENCE_SYNC`, `LOOKALIKE_CREATE`) e cron diário para segmentos dinâmicos ligados.
- [ ] **5.4** Exclusão automática: segmento "clientes que compraram nos últimos N dias" como público de **exclusão** para anúncios de aquisição (evita pagar para alcançar quem já é cliente).
- [ ] **5.5 Vínculo campanha ↔ Meta**: `mkt.campaign_ad_links` + casamento automático pela tag `[c:<codigo>]` no nome da campanha da Meta durante o sync de insights; seleção manual na aba Canais.
- [ ] **5.6 CAPI**: incluir `campaign_id` do sistema em `custom_data` do Purchase e enviar evento `Lead` quando entra lead nova por anúncio (melhora a otimização).
- [ ] **5.7** Tela `/marketing/anuncios`: coluna "Campanha do sistema", filtro por campanha, e na aba Canais da campanha o gasto/alcance dos anúncios vinculados.
- [ ] **5.8 Testes**: worker `test_meta_audiences.py` (hash, normalização de telefone BR, lotes, erro transitório), pgTAP `065_ad_audiences_test.sql` (sem consentimento não sai), e2e de vínculo por tag.
- [ ] **5.9 (opcional, depois)** Criar campanha/conjunto/anúncio Click-to-WhatsApp **pausado** pela API a partir da campanha do sistema, para revisar e ligar no Gerenciador. Deixar fora do escopo inicial: revisão de anúncios, políticas e criativos ficam no Gerenciador da Meta.

### Fase 6 — Acabamento
- [ ] **6.1** Navegação (`packages/domain/src/nav.ts`) conforme Parte 4; redirects das rotas antigas (`/marketing` lista → `/marketing/campanhas`, `/clientes/afiliados` → `/marketing/afiliadas`).
- [ ] **6.2** Permissões: `crm.write` para campanha/segmento; `sales.write` para oferta; `core.admin` para envio de público à Meta.
- [ ] **6.3** Assistente central (`/central`, IA): ferramentas "quantas clientes não compram há 90 dias?" e "monte um rascunho de campanha para…" usando `segment_preview` e `save_campaign` (rascunho, nunca lança sozinho).
- [ ] **6.4** Atualizar `docs/plano-marketing-e-atendimento.md` (Parte 1) e o manual de operação com o fluxo novo.
- [ ] **6.5** Remover código morto: `createCampaignAction` antiga, colunas legadas de `mkt.campaigns` depois de uma versão de transição.

### Ordem e dependências

```
Fase 0 ──────────────────────────────► (pode ir já, PR próprio)
Fase 1 (públicos) ──► Fase 2 (campanha + oferta + disparos) ──► Fase 4 (atribuição)
                              └──► Fase 3 (links/afiliadas) ──┘
Fase 1 ──► Fase 5 (Meta)  [5.5–5.7 dependem de Fase 2]
Fase 6 por último
```
Sugestão de PRs: um por fase (Fase 2 pode dividir em 2.1–2.4 banco/worker e 2.5–2.7 telas).

## Anexo — Decisões em aberto

1. **Holdout padrão em campanha**: 10% (como as réguas) ou 0% com opção? Recomendo 10% em reativação/conversão e 0% em lançamento/drop (aviso de novidade não se sorteia).
2. **Janela de atribuição padrão**: 7 dias (hoje) ou 14? Recomendo 7 para WhatsApp e 14 para anúncio.
3. **Base legal para público Meta**: consentimento explícito `MARKETING_ADS` (recomendado) ou legítimo interesse para clientes com compra. Validar com o jurídico.
4. **Criar anúncio pela API (5.9)**: só se o volume justificar; o vínculo por tag resolve o essencial.
5. **Afiliadas em Marketing**: mover o menu (recomendado) ou manter em Clientes com atalho.
