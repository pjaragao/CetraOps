# 06 — Módulo Configurações & Integrações

> **SIÉ JOY OS — Central de Integrações, Customização de Regras de Qualificação e Parâmetros Fiscais da Boutique**

---

## 🔌 1. Sub-Aba 1: Central de Integrações

Reúne o painel de homologação, status em tempo real e credenciais de todas as plataformas conectadas ao ecossistema:

### A. Stone POS & Online API:
- **Status:** `CONECTADO 🟢` (badge compacto sem quebra de linha).
- **StoneCode:** `84729104`.
- **Equipamentos:** 2x Smart POS P2 + A8.
- **Taxa Média D+1:** 3,18% (SIPAG/Stone).
- **Webhook Listener:** `/api/stone/simulate-webhook`.
- **Emissão Fiscal:** NFC-e SEFAZ/SC Automática com envio por e-mail/SMS.

### B. Meta Marketing API:
- **Status:** `HOMOLOGADO 🟢`.
- **Ad Account ID:** `act_98124401`.
- **Versão da API:** v19.0 (Graph API).
- **Algoritmo de Hash:** SHA-256 Automático para e-mails e telefones.
- **Públicos Sincronizados:** 3 Audiences ativas (Compradores Reais, Leads Score 5 e Lookalike 1%).

### C. Apify Cloud Scraping:
- **Status:** `ATIVO 🟢`.
- **Actor ID:** `apify/instagram-scraper-v3`.
- **Rede de Proxies:** Proxies móveis 4G/5G residenciais.
- **Webhook Callback:** `/api/scraping/execute-apify`.

### D. WhatsApp Cloud API (Meta Oficial):
- **Status:** `ONLINE 🟢`.
- **WABA ID:** `waba_sie_joy_2026`.
- **Agente IA:** Herme Agent (Concierge).
- **Janela de Conversa:** 24 Horas Oficial com templates HSM pré-aprovados.

---

## ⚙️ 2. Sub-Aba 2: Regras de Qualificação

Permite ao gestor customizar os critérios que alimentam o algoritmo de pontuação (Score 1 a 5 estrelas) do CRM:

1. **Profissões High-Ticket (+2 Estrelas):**
   - Termos ativos: `médica`, `cirurgiã`, `dermatologista`, `arquiteta`, `advogada`, `empresária`, `juíza`, `dentista`.
   - Adição e remoção de termos em tempo real.
2. **Esportes & Estilo de Vida (+2 Estrelas):**
   - Termos ativos: `pilates`, `reformer`, `beach tennis`, `triatlo`, `corrida`, `maratona`, `hipismo`, `yoga`.
3. **Cidades Alvo (+1 Estrela):**
   - Cidades ativas: `Florianópolis`, `Balneário Camboriú`, `Joinville`, `Itapema`, `Porto Alegre`.
4. **Recálculo em Tempo Real:** Botão *"Salvar Regras & Recalcular Base"* que atualiza instantaneamente a base de leads no arquivo `data/crm_leads.json`.

---

## 🏢 3. Sub-Aba 3: Parâmetros da Boutique

Armazena as premissas econômicas do plano de negócios negociado com o JOY Wellness Club:

| Parâmetro | Valor Parametrizado | Detalhes |
| :--- | :---: | :--- |
| **Aluguel Fixo Mensal** | R$ 6.000,00 | Com 3 meses de carência inicial (Economia de R$ 18.000,00). |
| **Markup Praticado** | 2,40x | CMV de 41,67% sobre o preço de venda e Margem Bruta de 58,33%. |
| **Comissão Vendedora** | 3,00% | Aplicada sobre 60% das vendas (Comissão Efetiva Global: 1,80% + encargos = 2,31%). |
| **Alíquota Simples Nacional** | 5,50% | Faixa 1 do Comércio (Receita bruta até R$ 180k/ano). |
| **Taxa Média Stone D+1** | 3,18% | Crédito D+1 antecipado automático (Débito: 0,89% / Pix: 0,00%). |
| **Provisão para Drops** | R$ 2.000,00/mês | Desembolso de R$ 4.000,00 a cada 60 dias para ativação e coquetel. |
