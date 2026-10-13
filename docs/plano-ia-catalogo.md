# Plano — IA em dia com o sistema e o catálogo (fotos locais, atendimento e Central)

> Situação conferida no banco de produção (homelab) e no código em 13/10/2026, depois de 57 commits desde 05/10.
> "Atendimento" = a IA que conversa com as clientes (worker `router` + servidor MCP + `agent.call_tool`).
> "Central" = a assistente da equipe na web (`apps/web/lib/central`).

> **Situação em 13/10/2026 (implementado, aguardando deploy):** Fases A, B (menos o envio de foto pelo WhatsApp), C, D e E feitas e testadas
> (pgTAP 070 com 45 verificações, worker 219 testes, contrato e MCP, domínio). Validado também numa cópia restaurada do banco de produção.
> O deploy no Coolify aplica as migrations `20261013000200`–`20261013000500`, já pede a cópia das 876 fotos ao worker e gera os
> 7 rascunhos da base de conhecimento. Revisão do catálogo: [revisao-catalogo-2026-10-13.md](revisao-catalogo-2026-10-13.md);
> persona: [persona-concierge-rascunho.md](persona-concierge-rascunho.md). Pendências no fim (§8).

## 1. Diagnóstico

### 1.1 O que a semana mudou e onde a IA ficou para trás

| Mudança (commit) | Atendimento (clientes) | Central (equipe) |
|---|---|---|
| Catálogo do site da SIÉ: 106 modelos, 834 variações, 876 fotos por cor, descrição (105), composição (78), guia de tamanho, linha, preço "de/por" (86 itens) — `8d7793c` | ❌ `search_catalog` só devolve nome, preço, cores e tamanhos. Não vê foto, descrição, composição, modelagem, guia nem linha. A busca só procura em nome + referência + cor ("short com bolso", "legging de compressão" não acham nada) | ❌ `buscar_produto` mesma limitação |
| Encomendas (`backorder`, pedido de compra automático) — `c2ca924`, `6f1271f`, `563e80f` | ❌ `in_stock_only` vem ligado e **hoje o estoque é zero em todas as variações**: o atendimento responderia "não temos" para tudo. Não sabe que a peça pode ser encomendada | ❌ `propor_venda` recusa peça sem estoque e não oferece encomenda; não há `propor_encomenda` nem consulta de encomendas abertas |
| Horário das lojas ligado ao atendimento — `57c5ab5` | ✅ mensagem de espera e tarefa fora do horário já usam o horário. ⚠️ Não há ferramenta para responder "que horas vocês abrem?" e **`core.stores.business_hours` está vazio** | ❌ não sabe o horário nem as exceções (feriados) |
| Malinhas e peças em campanha (local `WITH_CUSTOMER`/`MARKETING`, não vendável) — `9d52132` | ✅ o estoque emprestado já sai da conta (local não vendável) | ❌ não consulta malinhas abertas/vencidas nem propõe uma |
| Contagem, ajuste, etiquetas, rotina da loja — `9d52132` | — | ❌ sem ferramentas (só `navegar`) |
| Alertas de preço (`catalog.price_changes`) — `8d7793c` | ✅ preço vem de `current_price`, então está certo | ❌ não responde "que preços mudaram?" |
| Pedidos: novos status, rascunhos, trocas com PDV — `638d185`, `454853b` | ⚠️ `get_order_status` devolve o código cru do status; conferir os novos | ⚠️ conferir `vendas`/`resumo_do_dia` |
| Fiscal (Notaas, Brasil NFe), Stone | — (sem impacto) | ✅ `propor_venda` já usa Stone |

### 1.2 Base que o atendimento usa para responder — está vazia

| Item | Hoje |
|---|---|
| Base de conhecimento (`ai.knowledge_docs`) | **0 documentos** — `search_knowledge` sempre volta vazio |
| Políticas (`core.settings.policies`) | troca, entrega, pagamento e desconto, todas **RASCUNHO** |
| Persona "Concierge" | 1 versão com `system_prompt` vazio (usa a persona padrão genérica) |
| Casos de avaliação (`ai.eval_cases`) | 12, todos de regras gerais; nenhum sobre catálogo |
| Canais (`omni.channel_accounts`) | 0 — o atendimento ainda não está ligado a nenhum WhatsApp/Instagram |

### 1.3 Fotos

As 876 fotos são **links para `cdn.shopify.com`** (`catalog.product_media.storage_path`). Se a marca trocar a foto ou tirar o produto do site, a imagem some do PDV, do catálogo e das etiquetas. Não existe bucket de fotos; o `supabase-imgproxy` já está rodando (dá para servir miniaturas sem guardar vários tamanhos). A web hoje só mostra foto quando o caminho começa com `http` (`apps/web/app/(app)/produtos/page.tsx:46`).

## 2. Fase A — Guardar as fotos no Storage

1. **Migration** `catalog_media_storage`:
   - bucket `catalog-media` **público** (são as mesmas fotos do site; precisam abrir em etiqueta, link e WhatsApp), até 5 MB, `image/jpeg|png|webp`.
   - política de escrita só para quem tem `catalog.write`; o worker grava com a chave de serviço.
   - colunas em `catalog.product_media`: `source_url text` (link original), `content_hash text`, `width int`, `height int`. Índice único `(product_id, color_id, source_url)`.
   - `upsert_site_product` passa a **não apagar** a foto já baixada: compara pelo `source_url`; foto que saiu do site fica marcada (`removed_at`) em vez de sumir.
2. **Worker** (`handlers/catalog_site.py`, reaproveitando o `_upload` de `handlers/media.py`):
   - nova fila `catalog_media`: para cada foto com `storage_path` em `http`, baixa do Shopify com `?width=1600` (limita tamanho), grava em `catalog-media/<org>/<referência>/<código da cor>/<hash>.<ext>` e troca `storage_path` pelo caminho do bucket.
   - a sincronização diária enfileira só fotos novas ou alteradas (hash diferente).
   - retentativa com backoff; falha permanente deixa o link do Shopify como reserva.
3. **Web**: um helper `productPhotoUrl(storage_path, {width})` — caminho do bucket vira URL pública do Storage com transformação (`/render/image/public/...?width=`), `http` continua funcionando. Trocar nos lugares que usam `product_media` (lista e ficha de produtos, PDV, etiquetas, Central).
4. **Carga inicial**: rodar a fila para as 876 fotos (estimativa: 150–300 MB). Conferir contagem e abrir amostras.
5. **Backup / mudança para a nuvem**: o `backup-db.sh` hoje só copia o banco — incluir o volume do Storage; acrescentar o bucket ao roteiro `infra/MIGRACAO-SUPABASE-CLOUD.md`. *(pendente: depois da primeira cópia)*

## 3. Fase B — Atendimento conhecendo o catálogo novo

Uma migration nova (sem mexer nas aplicadas) recria as funções do agente:

1. **`agent.t_search_catalog`**
   - procura também em categoria, linha, descrição, composição e tags do site;
   - devolve por produto: `category`, `line`, `composition`, `fit_note` (modelagem menor), `photo` (URL pública da 1ª foto da cor), `compare_at_price` quando houver "de/por", `backorder` (pode encomendar) e `site_url`;
   - `in_stock_only` passa a considerar "tem estoque **ou** aceita encomenda"; o resultado diz qual dos dois.
2. **`agent.t_check_stock`**: por variação, `available` + `backorder_ok`; tamanhos sem estoque de peça encomendável aparecem como "sob encomenda".
3. **Ferramenta nova `get_product_details`** (contrato `tools.py` + servidor MCP + `call_tool`): descrição limpa (sem HTML), composição, cuidados, modelagem, guia de tamanho do gênero em texto, fotos por cor (até 3 URLs).
4. **Ferramenta nova `get_store_info`**: endereço, horário da semana, exceções dos próximos 14 dias e se está aberta agora (usa `core.store_calendar`).
5. **Encomenda pelo atendimento**: o atendimento **não** cria encomenda sozinho (exige pagamento antecipado e pedido de compra). Ele explica como funciona (texto da base, Fase C) e chama `request_handoff` com motivo novo `BACKORDER`, já levando modelo, cor e tamanho para a vendedora fechar no PDV. Acrescentar `BACKORDER` ao enum do contrato.
6. **`get_order_status`**: traduzir os status novos para texto que a cliente entende.
7. **Regras do prompt** (`ai/prompts.py`): quando sem estoque, oferecer encomenda (se `backorder`) antes do avise-me; usar `get_product_details` para tecido/modelagem/tamanho; mandar foto só por URL que veio da ferramenta.
8. *(pendente: depende de canal ligado)* **Foto no WhatsApp**: `propose_reply` aceita até 3 `media` (URLs do bucket vindas das ferramentas); o validador de guardrails confere que a URL é do nosso bucket. O envio sobe o arquivo para a Meta (com o Supabase só na Tailscale, a Meta não consegue baixar pelo link).

## 4. Fase C — Preencher a base de conhecimento com o que o catálogo já tem

Tudo entra como **rascunho** em `ai.knowledge_docs` (status `DRAFT`) para a equipe revisar e publicar em Inteligência › Conhecimento — nada vai para cliente sem aprovação.

| Documento | De onde vem | Pronto? |
|---|---|---|
| Guia de tamanhos — Feminino (PP–GG) | tabela HTML do site (`catalog.size_charts`) convertida em texto | sim |
| Guia de tamanhos — Masculino (P–GG) | idem | sim |
| Modelagens que vestem menor | 3 produtos com aviso do site ("recomendamos um tamanho maior") | sim |
| Tecidos da SIÉ | as composições do catálogo agrupadas (poliamida/elastano em 8 proporções, viscose, poliéster) e quais peças usam cada uma | sim, sem inventar propriedades |
| Cuidados com as peças | só 1 produto tem "cuidados" no site → buscar a página de cuidados do site; se não existir, rascunho com lacunas para a equipe | parcial |
| Linhas Activewear, Everyday, Inspiré | descrição das coleções no Shopify + categorias de cada linha | buscar no site |
| Sobre a SIÉ | página "sobre" do site | buscar no site |
| Como funciona a encomenda | regras do banco (pagamento antes, pedido de compra, aviso quando chega); **prazo a definir pelos sócios** | parcial |
| Loja SIÉ @ JOY: endereço e horário | `core.stores` — **horário ainda não cadastrado** | depende da loja |

Também nesta fase:
- **Revisão de qualidade do catálogo** (lista para a equipe): descrições que citam outro modelo (ex.: "Calça Core" fala da "calça Force"), composição com formato diferente ("90% Poliamida, 10% Elastano" × "/"), 1 produto sem descrição, 28 sem composição.
- **Persona Concierge**: rascunho em [persona-concierge-rascunho.md](persona-concierge-rascunho.md), para os sócios ajustarem antes de virar versão.
- Feito por `ai.draft_catalog_knowledge()` (migration `20261013000500`): guia de tamanhos feminino e masculino, modelagens que vestem menor,
  tecidos, cuidados, linhas e categorias e como funciona a encomenda — como **rascunho**, com [A CONFIRMAR] onde falta informação.
  O site da marca não tem texto nas páginas "Sobre nós" e de cuidados (só seções visuais), por isso "Sobre a SIÉ" ficou de fora.
- **Políticas**: apresentar aos sócios as 4 políticas em RASCUNHO + a nova de encomenda para fechar o texto.

## 5. Fase D — Central em dia com a semana

1. `buscar_produto`: mesmos campos novos da busca do atendimento (foto, linha, encomendável, "de/por"); cartão de produto com foto.
2. `propor_venda`: peça sem estoque e encomendável → em vez de recusar, sugere `propor_encomenda`.
3. Ferramentas novas:
   - `propor_encomenda` (cartão → `sales.create_backorder`) e `encomendas` (abertas, aguardando fornecedor, chegaram);
   - `malinhas` (abertas, vencidas, com quem) e `propor_malinha` (cartão → `inv.create_loan`);
   - `precos_alterados` (`catalog.price_changes` dos últimos dias, destacando peças com estoque);
   - `horario_loja` (hoje/semana/exceções);
   - `rotina_do_dia` (abertura/fechamento: o que falta marcar).
4. `resumo_do_dia`: incluir encomendas chegando, malinhas vencidas e alertas de preço.
5. `navegar`: rotas novas (catálogo, encomendas, malinhas, contagem, etiquetas, rotina, horário).

## 6. Fase E — Testes e avaliação

- pgTAP (`supabase/tests`) para a busca nova, `get_product_details`, `get_store_info` e o enum `BACKORDER`.
- Testes do contrato (`apps/agent/contract/tests`) e do servidor MCP para as ferramentas novas.
- Testes do worker para a fila de fotos (download, hash repetido, falha que mantém o link).
- `ai.eval_cases` novos, montados do catálogo real: "tem a calça X no M?" sem estoque mas encomendável; "qual o tecido do top Y?"; "visto M, qual tamanho na bermuda que veste menor?"; "tem foto em preto?"; "está em promoção?"; "que horas abre no feriado?"; "quero encomendar" → transfere com resumo.
- Central: e2e (Playwright) de buscar produto com foto e cartão de encomenda.

## 7. Ordem sugerida

| # | Entrega | Depende de |
|---|---|---|
| 1 | Fase A (fotos locais) | — |
| 2 | Fase B itens 1–4 e 6–7 (busca, detalhes, loja, status) | A (URL da foto) |
| 3 | Fase C (rascunhos da base + revisão do catálogo) | — (pode correr junto com 1) |
| 4 | Fase D (Central) | A, B |
| 5 | Fase B itens 5 e 8 (encomenda por transferência, foto no WhatsApp) | canal ligado |
| 6 | Fase E (testes e evals) acompanhando cada entrega | — |

## 8. Decisões que precisam dos sócios

1. Prazo e regras da encomenda que o atendimento pode dizer (prazo médio, sinal ou pagamento integral, cancelamento).
2. Texto final das políticas de troca, entrega e pagamento (hoje RASCUNHO).
3. Horário da loja SIÉ @ JOY e feriados.
4. O atendimento pode mostrar o preço "de/por" do site?
5. Tom da persona (aprovar o rascunho).
