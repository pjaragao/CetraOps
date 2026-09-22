# 03 — Módulo Aquisição, CRM & Growth

> **SIÉ JOY OS — CRM High-Ticket, Scraping Duplo (Apify + instagrapi), Meta Ads Granular e Protocolo Anti-Ban**

---

## 🗂️ 1. Sub-Aba 1: CRM & Funil High-Ticket

O CRM foi projetado especificamente para prospecção de alunas de alta renda (médicas, arquitetas, empresárias e praticantes de Reformer Pilates, Beach Tennis e Corrida).

### A. Alternador de Visualização (Lista vs. Kanban):
- **Visão Padrão em Lista Compacta (`#crm-list-view`):**
  - Tabela de alta densidade informativa, ideal para navegar rapidamente entre dezenas de leads sem poluição visual.
  - Colunas: Lead (Avatar + Nome + link `@instagram`), Estágio do Funil (com badge colorido), Score de afinidade em estrelas douradas, Tags de estilo de vida, Origem, botão direto de WhatsApp e ações rápidas (`[🔍 Ficha]` e `[➔ Avançar]`).
- **Visão Alternativa em Kanban (`#crm-kanban-view`):**
  - Quadro de 7 colunas clássico para acompanhamento visual e movimentação rápida de etapas.

### B. As 7 Etapas do Funil:
1. `Novo Lead` (Capturado via Apify ou instagrapi)
2. `Qualificado High-Ticket` (Score 4 ou 5 estrelas calculado automaticamente)
3. `Em Campanha Meta` (Sincronizado via SHA-256 com Custom Audience do Gerenciador de Anúncios)
4. `Em Atendimento IA` (Conversando com o Herme Agent via WhatsApp)
5. `Armário VIP / Visita` (Look reservado na boutique do JOY Club)
6. `Convertido Stone POS` (Compra registrada no PDV físico ou link de pagamento)
7. `Cliente VIP / Recompra` (Relacionamento pós-venda para lançamentos de novos drops)

### C. Ficha 360° do Lead (Modal Interativo):
Exibe histórico detalhado do lead: score de afinidade, bio completa, cidade, telefone, link direto para o WhatsApp, histórico de compras Stone e alterador manual de estágio.

---

## 🔍 2. Sub-Aba 2: Extração de Leads (Apify & instagrapi)

O ecossistema utiliza uma estratégia de scraping híbrido para equilibrar escala e segurança:

1. **Apify Cloud (Motor de Escala):**
   - Rotação de proxies móveis residenciais 4G/5G.
   - Extração em massa de curtidores e comentaristas de perfis concorrentes (`@trackfieldoficial`, `@liveoficial`, `@lululemonbrasil`).
   - Disparo assíncrono via API com retorno em webhook JSON.
2. **`instagrapi` Local (Motor Cirúrgico):**
   - Executado em Python local com delays humanizados (3.5s a 8.0s).
   - Coleta de dados públicos de contato (e-mail, telefone) e últimas 3 postagens.
   - Lotes configuráveis (3, 5 ou 10 leads por disparo) para prevenir bloqueios.
3. **Sugestões Automáticas por IA:**
   - Sugere perfis de alto luxo de SC e RS (`@altogiro`, `Bodytech Iguatemi Floripa`, `@ciaathleticafloripa`, etc.) com adição à lista de alvos em 1 clique.

---

## 📈 3. Sub-Aba 3: Meta Ads Granular

Painel analítico integrado à Meta Marketing API com visualização em três níveis hierárquicos:

1. **Nível Campanhas:** Objetivos (Vendas / Leads), Orçamento diário e status.
2. **Nível Conjuntos de Anúncios:** Segmentação geográfica (Florianópolis + 15km), posicionamentos (Instagram Stories, Reels, Feed) e públicos.
3. **Nível Anúncios / Criativos:** Mídia do drop, cliques, CTR, CPC e ROAS atribuído.

- **Sincronização SHA-256 de Públicos Personalizados:**
  - Botão que criptografa os contatos dos leads qualificados e envia diretamente para a criação de **Custom Audience** e **Lookalike 1% a 2%** no Gerenciador da Meta.

---

## 🛡️ 4. Sub-Aba 4: Playbook Anti-Ban Manual

Protocolo operacional passo a passo para a equipe da boutique seguir manualmente a partir do perfil oficial `@sie.wear`:

1. **Dia 1: Visualização de Stories** (assistir aos stories do lead para marcar presença visual).
2. **Dia 2: Curtida Estratégica** (curtir 1 ou 2 fotos recentes de treino ou corrida).
3. **Dia 3: Conexão Oficial (Follow)** (seguir a conta; taxa de follow-back estimada em 35% a 45%).
4. **Dia 4+: Direct VIP** (enviar convite personalizado para café na boutique apenas para quem seguiu de volta).

- **Cronômetro de Intervalo Seguro (180s):** Bloqueia ações consecutivas antes de 3 minutos para simular navegação 100% humana.
- **Modelos de Direct Copiáveis:** Scripts com 1 clique de cópia para a área de transferência.
