# SIÉ JOY OS — Documentação Técnica & Operacional

> **Sistema Integrado de Gestão de Varejo de Luxo, Frente de Caixa Stone, CRM High-Ticket e Inteligência Financeira**  
> **Unidade:** SIÉ Wear Boutique @ JOY Wellness Club (Florianópolis/SC • Centro)  
> **Versão:** 2.4.0 (Arquitetura 5 Macro-Módulos com Barra Retrátil e Abas Superiores)

---

## 📌 Visão Geral do Sistema

O **SIÉ JOY OS** é uma plataforma corporativa desenvolvida para operar e escalar a boutique física da **SIÉ Wear** sediada exclusivamente dentro do **JOY Wellness Club**, o clube de bem-estar e fitness mais exclusivo de Florianópolis.

O sistema integra em uma única interface elegante, moderna e de alto desempenho:
1. **Inteligência Financeira em Tempo Real:** DRE gerencial, acompanhamento de faturamento Stone e termômetro de ponto de equilíbrio com 3 meses de carência de aluguel.
2. **Máquina de Aquisição & Growth:** CRM de alta conversão (visão em Lista Compacta e Kanban), motores de scraping híbrido (Apify Cloud 4G + `instagrapi` Python local), gestão granular do Meta Ads e protocolo manual anti-ban para o perfil oficial `@sie.wear`.
3. **Frente de Caixa & Operação de Varejo:** Terminal Smart POS Stone (P2 e A8), controle de grade por tamanho (P/M/G/GG), planejamento de compras baseado em giro (Curva ABC) e calendário de drops bimestrais.
4. **Atendimento VIP & Concierge de Luxo:** Venda consultiva com inteligência artificial (**Herme Agent**), simulador do WhatsApp Business, gestão do serviço "Armário VIP / Room Service no Vestiário" e insights estratégicos para o público A/A+.
5. **Central de Configurações:** Hub unificado para homologação e monitoramento de APIs (Stone, Meta Marketing API, Apify, WhatsApp Cloud API) e customização de regras de negócio.

---

## 🗂️ Estrutura de Documentos

A documentação detalhada está dividida nos seguintes manuais:

| Arquivo | Descrição |
| :--- | :--- |
| [01_ARQUITETURA_E_NAVEGACAO.md](file:///c:/Users/paulojr/Documents/SIE-Joy/sistema_web/docs/01_ARQUITETURA_E_NAVEGACAO.md) | Arquitetura técnica, layout retrátil, isolamento de containers e abas contextuais. |
| [02_MODULO_FINANCEIRO.md](file:///c:/Users/paulojr/Documents/SIE-Joy/sistema_web/docs/02_MODULO_FINANCEIRO.md) | Dashboard de KPIs, DRE Gerencial, Simulação de Cenários 1 a 6 e Ponto de Equilíbrio. |
| [03_MODULO_GROWTH_E_CRM.md](file:///c:/Users/paulojr/Documents/SIE-Joy/sistema_web/docs/03_MODULO_GROWTH_E_CRM.md) | CRM High-Ticket (Lista/Kanban), Scraping Apify/instagrapi, Meta Ads e Playbook Anti-Ban. |
| [04_MODULO_LOJA_E_OPERACAO.md](file:///c:/Users/paulojr/Documents/SIE-Joy/sistema_web/docs/04_MODULO_LOJA_E_OPERACAO.md) | Frente de Caixa dedicada, Stone POS, Catálogo, Compras Curva ABC, Drops e Trainers. |
| [05_MODULO_ATENDIMENTO_E_CONCIERGE.md](file:///c:/Users/paulojr/Documents/SIE-Joy/sistema_web/docs/05_MODULO_ATENDIMENTO_E_CONCIERGE.md) | Herme Agent IA (Vendedor ERP), WhatsApp Concierge, Armário VIP e Varejo de Luxo. |
| [06_MODULO_CONFIGURACOES_E_INTEGRACOES.md](file:///c:/Users/paulojr/Documents/SIE-Joy/sistema_web/docs/06_MODULO_CONFIGURACOES_E_INTEGRACOES.md) | Central de Integrações, Regras de Qualificação e Parâmetros Fiscais/Operacionais. |
| [07_PLANO_EXPANSAO_ERP_ROBUSTO.md](file:///c:/Users/paulojr/Documents/SIE-Joy/sistema_web/docs/07_PLANO_EXPANSAO_ERP_ROBUSTO.md) | **Plano Estratégico de Expansão ERP:** Arquitetura Multi-CNPJ & Multi-Loja (Corners, Boutiques e Pop-ups), conciliação bancária 3 vias, contas a pagar/receber, orçamento base, previsão de impostos e encargos/folha de pagamento. |

---

## 🛠️ Stack Tecnológica

- **Frontend:** HTML5 Semântico, Vanilla CSS3 com Variáveis de Design Tokens de Alto Luxo (Dark Luxury Palette: `#090D16`, `#D4AF37`, `#10B981`, `#38BDF8`), Vanilla JavaScript Modular ES6+.
- **Backend / API Server:** Python 3 (servidor HTTP leve integrado com rotas REST e persistência JSON em `data/`).
- **APIs Externas Integradas:**
  - **Stone Pagamentos:** Stone Online API + Webhook de Smart POS P2/A8.
  - **Meta Marketing API:** Sincronização SHA-256 de Custom Audiences e métricas de campanhas.
  - **Apify:** Plataforma em nuvem para scraping massivo com proxies móveis 4G.
  - **instagrapi:** Biblioteca Python local para validação cirúrgica de perfis de alto padrão.
  - **WhatsApp Business Cloud API:** API oficial da Meta para atendimento automatizado.

---

## 🚀 Como Executar o Sistema

1. **Iniciar o Servidor:**
   ```bash
   cd sistema_web
   python server.py
   ```
2. **Acessar a Aplicação:**
   Abra o navegador em: [http://localhost:3001](http://localhost:3001)
