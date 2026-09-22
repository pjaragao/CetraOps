# 02 — Módulo Financeiro & DRE

> **SIÉ JOY OS — Inteligência Financeira, DRE Gerencial, Cenários de Payback e Ponto de Equilíbrio**

---

## 📊 1. Sub-Aba 1: Dashboard de KPIs (Página Principal)

Ao abrir o módulo financeiro, o usuário visualiza imediatamente os indicadores executivos de desempenho da boutique física:

### A. Quatro Cards de Métricas Principais:
1. **Faturamento Capturado Stone:** Total bruto acumulado de vendas via Smart POS e links de WhatsApp.
2. **Lucro Operacional Líquido:** Resultado real após deduções de CMV (41,67%), Simples Nacional (5,50%), Taxas Stone D+1 (3,18%), comissões e despesas fixas.
3. **Margem Líquida Real:** Percentual de lucro líquido sobre a receita bruta (meta Cenário 4: 23,1%).
4. **Ticket Médio por Venda:** Média de gasto por transação (meta balcão: R$ 420,00).

### B. Resumo da Operação & Canais:
- **Distribuição de Vendas por Canal:**
  - Balcão Físico JOY (Smart POS P2): ~68,5%
  - Vendas Assistidas WhatsApp (Links Stone): ~31,5%
- **Divisão por Meio de Pagamento:**
  - Cartão de Crédito até 3x: 62%
  - Pix Instantâneo: 26%
  - Cartão de Débito: 12%
- **Feed em Tempo Real:** Transações recentes capturadas via webhook da Stone com nome da aluna, look adquirido, meio de pagamento e valor.

---

## 📑 2. Sub-Aba 2: DRE Gerencial

Demonstração do Resultado do Exercício calculada dinamicamente com base nas transações reais registradas versus a meta do cenário ativo:

| Linha da DRE | Base de Cálculo | Realizado Stone | Meta do Cenário |
| :--- | :--- | :---: | :---: |
| **(+) Receita Bruta de Vendas** | Faturamento bruto capturado | R$ 34.185,00 | R$ 60.000,00 |
| **(-) Deduções / Simples Nacional** | 5,50% sobre a receita bruta | - R$ 1.880,18 | - R$ 3.300,00 |
| **(=) Receita Operacional Líquida** | Receita bruta menos tributos | R$ 32.304,82 | R$ 56.700,00 |
| **(-) CMV (Custo Mercadoria Vendida)** | 41,67% (Markup de 2,40x) | - R$ 14.244,89 | - R$ 25.000,00 |
| **(=) Margem Bruta** | 58,33% da receita bruta | R$ 18.059,93 | R$ 31.700,00 |
| **(-) Taxas Stone / SIPAG** | 3,18% média ponderada D+1 | - R$ 1.087,08 | - R$ 1.908,00 |
| **(-) Comissões Vendedora + Encargos** | 2,31% efetivo global | - R$ 789,67 | - R$ 1.386,00 |
| **(-) Embalagens de Luxo & Avarias** | 1,50% sobre a receita | - R$ 512,78 | - R$ 900,00 |
| **(=) Margem de Contribuição Líquida** | 45,84% efetivo | R$ 15.670,40 | R$ 27.506,00 |
| **(-) Custos Fixos Regulares** | Aluguel JOY (R$ 6k ou R$ 0 na carência) | R$ 0,00 (Carência) | R$ 0,00 |
| **(-) Provisão para Drops** | R$ 2.000,00/mês (R$ 4k/60 dias) | - R$ 2.000,00 | - R$ 2.000,00 |
| **(=) RESULTADO OPERACIONAL LÍQUIDO** | Lucro líquido final | **R$ 13.670,40** | **R$ 25.506,00** |

---

## 📈 3. Sub-Aba 3: Simulador de Cenários

Permite simular o impacto de variações de volume de compras e vendas no lucro mensal e na velocidade de retorno do investimento (Payback):

| Cenário | Compras SIÉ (CMV) | Faturamento Alvo | Lucro Líquido / Mês | Margem | Prazo Payback |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Cenário 1** | R$ 12.875,00 | R$ 30.900,00 | R$ 1.667,00 | 5,4% | 18 Meses |
| **Cenário 2** | R$ 13.625,00 | R$ 32.700,00 | R$ 2.500,00 | 7,6% | 12 Meses |
| **Cenário 3** | R$ 15.917,00 | R$ 38.200,00 | R$ 5.000,00 | 13,1% | 6 Meses |
| **Cenário 4 ⭐** | **R$ 25.000,00** | **R$ 60.000,00** | **R$ 13.882,00** | **23,1%** | **2,2 Meses** |
| **Cenário 5** | R$ 30.000,00 | R$ 72.000,00 | R$ 18.824,00 | 26,1% | 1,6 Meses |
| **Cenário 6** | R$ 35.000,00 | R$ 84.000,00 | R$ 23.766,00 | 28,3% | 1,3 Meses |

- **Controle de 3 Meses de Carência:** Botão interativo que alterna entre `Fase de Carência (Aluguel R$ 0)` e `Operação Regular (Aluguel R$ 6.000)`.

---

## ⚖️ 4. Sub-Aba 4: Ponto de Equilíbrio

- **Meta de Breakeven:** R$ 14.185,11 de faturamento mensal para cobrir todos os custos na fase regular.
- **Economia de Carência:** R$ 18.000,00 economizados nos 3 primeiros meses de operação.
- **Provisão para Drops:** R$ 2.000,00/mês reservados para os eventos bimestrais no JOY Club.
