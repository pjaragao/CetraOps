# CetraOps: Gestão Operacional, Modelagem Financeira & Expansão (SIÉ Wear)

O **CetraOps** é a plataforma integrada de gestão operacional, inteligência financeira, PDV e planejamento de expansão territorial da **[SIÉ Wear](https://siewear.com/)**. 

O projeto contempla a modelagem econômico-financeira completa, planejamento tributário/societário e diretrizes operacionais para a unidade piloto no clube de bem-estar **[JOY Wellness Club](https://www.founderjoy.com.br/)** (unidade Rua Esteves Júnior, 567 - Centro de Florianópolis/SC), além de um sistema web nativo de PDV (SIÉ Joy OS), esteira de automação documental e roteiro de expansão regional.

---

## 📂 Estrutura do Repositório

```text
CetraOps/
├── README.md                              # Visão geral executiva e índice mestre do projeto
├── PROJECT_INSTRUCTIONS.md                # Diretrizes para IA, regras de governança e arquitetura
├── .gitignore                             # Filtros de arquivos temporários, caches e ambientes
│
├── primeira_unidade_joy/                  # Unidade Piloto: Florianópolis / JOY Wellness Club
│   ├── Plano_de_Negocios_SIE_JOY.xlsx     # Arquivo mestre ÚNICO em Excel (12 abas, 5.773 fórmulas)
│   ├── Descritivo_Empresa_SIE_Wear_CNAE.pdf # Parecer societário e matriz oficial de CNAEs em PDF
│   ├── DESCRITIVO_EMPRESA_CNAE.md         # Descritivo executivo para contabilidade / abertura
│   ├── README.md                          # Visão geral e métricas da primeira unidade
│   └── docs/                              # 9 Notas técnicas aprofundadas em Markdown
│       ├── 01_premissas_e_parametros.md   # Capex, aluguel, carência, vendedora e taxas
│       ├── 02_dre_e_ponto_de_equilibrio.md # Unit economics, margens e breakeven c/ e s/ eventos
│       ├── 03_cenarios_financeiros.md     # Detalhamento dos 6 Cenários (18m, 12m, 6m, 25k, 30k, 35k)
│       ├── 04_projecao_expansao_joy.md    # Rampa dinâmica de alunos (400 -> 1.000)
│       ├── 05_tributario_fiscal_societario.md # Simples Nacional, Anexo I e alíquotas efetivas
│       ├── 06_manual_operacional_pdv.md   # Estoque 60/30/10, rotina de loja e eventos
│       ├── 07_analise_sensibilidade_e_riscos.md # Sensibilidade de aluguel e markup
│       ├── 08_remuneracao_e_comissao_equipe.md # Política CLT 6h e simulador de faixas
│       └── 09_descritivo_empresa_e_cnaes.md # Objeto social e matriz oficial de CNAEs
│
├── plano_de_expansao/                     # Planejamento Estratégico de Expansão Territorial
│   ├── Plano_de_Expansao_SIE_Wear.pdf     # Dossiê executivo diagramado em PDF (6 páginas A4)
│   ├── README.md                          # Índice, cobertura e metodologia de expansão
│   ├── 01_mapeamento_academias_high_ticket.md # Mapeamento completo de 14 cidades em SC e RS
│   ├── 02_modelos_de_negocio_e_parcerias.md # Formatos: Shop-in-Shop, Consignado (15-20%) e Drops
│   ├── 03_planejamento_tributario_e_societario_expansao.md # Rampa tributária e estrutura societária
│   └── generate_pdf_plano_expansao.py     # Script gerador do PDF via Edge headless
│
├── sistema_web/                           # Sistema Operacional de PDV & Integração Stone (SIÉ Joy OS)
│   ├── server.py                          # Servidor HTTP nativo em Python (Zero dependências, porta 3001)
│   ├── index.html                         # Interface web responsiva (Dark/Light mode, simulações)
│   ├── README.md                          # Manual de execução e rotas da API
│   ├── css/                               # Estilização modular em Vanilla CSS
│   ├── js/                                # Regras de negócio, estado e simulações em Vanilla JS
│   └── data/                              # Repositório de dados e persistência JSON local
│
└── scripts/                               # Automação, Compilação e Validações
    ├── build_financial_model.py           # Gerador do arquivo Excel único com fórmulas nativas
    ├── generate_expansion_pdf.py          # Compilador do PDF do Plano de Expansão
    ├── generate_cnae_pdf.py               # Compilador do PDF de CNAE / Societário
    ├── validate_formulas.py               # Validador de integridade de fórmulas (5.773 verificadas)
    ├── dump_values.py                     # Extrator de métricas e relatório de remuneração
    ├── audit_model.py                     # Auditor de integridade do arquivo Excel
    └── README.md                          # Guia de execução dos scripts de automação
```

---

## ⚡ Como Executar

### 1. Sistema Web (SIÉ Joy OS - PDV & Dashboard)
O sistema web foi desenvolvido com foco em performance e simplicidade, sem dependências externas (Python nativo):

```bash
# Executar a partir da raiz ou da pasta sistema_web
python sistema_web/server.py
```
Acesse no navegador: **`http://localhost:3001`**

### 2. Scripts de Automação & Modelagem Financeira
Os scripts em `scripts/` utilizam `openpyxl` para geração e validação de planilhas e relatórios:

```bash
# Gerar o modelo financeiro em Excel (12 abas, fórmulas nativas)
python scripts/build_financial_model.py

# Validar integridade das 5.773 fórmulas
python scripts/validate_formulas.py

# Compilar PDFs executivos
python scripts/generate_expansion_pdf.py
python scripts/generate_cnae_pdf.py
```

---

## 📌 Resumo Executivo das Premissas

| Item | Premissa Adotada | Observação / Metodologia |
| :--- | :---: | :--- |
| **Localização** | JOY Wellness Club | Unidade Esteves Júnior (1.700 m² no Centro de Florianópolis, ticket médio de R$ 1.300/mês). |
| **Início Operacional** | **Outubro / 2026** | Abertura societária, obras e montagem entre Julho e Setembro; inauguração oficial em Outubro. |
| **Investimento Inicial (Capex)** | **R$ 30.000,00** | Comunicação visual, araras de metalon/madeira nobre, manequins, PDV Stone, iluminação e reserva. |
| **Aluguel Renegociado** | **R$ 6.000,00/mês** | Redução de R$ 800/mês vs inicial de R$ 6.800 $\rightarrow$ **Economia de R$ 9.600,00 ao ano**. |
| **Carência Contratual** | **3 Meses de Isenção Total** | **Economia de R$ 18.000,00** em fluxo de caixa de implantação/montagem. |
| **Vendedora Titular (CLT 6h/dia)** | **R$ 2.100,00/mês** | Salário base fixo para jornada de 30h semanais. |
| **Divisão de Vendas** | **60% Vendedora / 40% Proprietária** | Vendedora comissionada em 60% das vendas; 40% são vendas diretas da proprietária. |
| **Comissão da Vendedora** | **3,0% s/ suas vendas (= 1,80% global)** | $3\% \times 60\% = 1,80\%$ sobre o faturamento total da loja (+ 0,51% de encargos trabalhistas). |
| **Vale Transporte (VT Líquido)** | **R$ 534,00/mês** | 22 dias × 2 viagens × R$ 15 (R$ 660) menos desconto legal de 6% em folha (R$ 126). |
| **Vale Alimentação (VA)** | **R$ 0,00** | Isento pela CLT para jornada de 6h diárias. |
| **Encargos s/ Salário Fixo** | **R$ 598,50/mês** | Simples Nacional (~28,5% sobre salário base: FGTS 8%, 13º, Férias + 1/3 e FGTS s/ provisões). |
| **Contabilidade + Software Stone + Desp.** | **R$ 1.270,00/mês** | Contabilidade PJ (R$ 650), ERP/PDV Stone Pro NFC-e (R$ 220), Embalagens/Gerais (R$ 400). |
| **Total Custos Fixos Regulares** | **R$ 10.502,50/mês** | Desembolso fixo regular mensal pós-carência (redução de R$ 800/mês). |
| **Total Custos Fixos na Carência** | **R$ 4.502,50/mês** | Desembolso fixo operacional sem incidência de aluguel. |
| **Eventos de Ativação & Lançamento Drops** | **R$ 4.000,00 / evento** | **Inauguração no Mês 1 (Outubro) e a cada 60 dias (bimestral)**: M1, M3, M5, M7, M9, M11... |
| **Provisão Média Mensal de Eventos** | **R$ 2.000,00/mês** | Equivalente mensal médio para amortização contábil e apuração de breakeven ($4.000 / 2$). |
| **Custos Fixos Totais c/ Eventos** | **R$ 12.502,50/mês** | Custo fixo mensal médio total ($10.502,50 + 2.000,00$). |
| **Custos Fixos c/ Eventos na Carência**| **R$ 6.502,50/mês** | Custo fixo com eventos durante a carência ($4.502,50 + 2.000,00$). |
| **Cobertura de Férias & Overlap** | **R$ 3.232,50/mês** | Substituta: 1 mês de treinamento em dupla (M12) + 1 mês de cobertura exclusiva (M13). |
| **Markup da Marca SIÉ** | **2,40** | **Preço de Venda = Custo × 2,40** $\rightarrow$ **CMV:** 41,67% \| **Margem Bruta:** 58,33%. |
| **Taxas SIPAG / Stone (D+1 Antecipado)**| **3,18%** | Média ponderada com recebimento total no dia seguinte útil. |
| **Tributação Recomendada** | **Simples Nacional** | Anexo I (Comércio). Alíquota efetiva progressiva entre **4,0% e 8,5%**. |
| **Prazo Fornecedor SIÉ** | **30 / 60 / 90 dias** | Boletos parcelados em 3 vezes iguais. |

---

## 🎯 Resumo Comparativo dos Cenários de Operação da Loja (Com Eventos Bimestrais)

| Indicador Financeiro | Breakeven Carência (s/ aluguel) | Ponto de Equilíbrio (c/ Eventos) | Cenário 1 (Payback 18m) | Cenário 2 (Payback 12m) | Cenário 3 (Payback 6m) | Cenário 4 (Compra R$ 25k) | Cenário 5 (Compra R$ 30k) | Cenário 6 (Compra R$ 35k) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Faturamento Mensal** | **R$ 14.185,11** | **R$ 27.274,02** | **R$ 30.909,82** | **R$ 32.727,73** | **R$ 38.181,44** | **R$ 60.000,00** | **R$ 72.000,00** | **R$ 84.000,00** |
| **Compra Mensal (SIÉ)** | **R$ 5.910,46** | **R$ 11.364,17** | **R$ 12.879,09** | **R$ 13.636,55** | **R$ 15.908,93** | **R$ 25.000,00** | **R$ 30.000,00** | **R$ 35.000,00** |
| **CMV (41,67%)** | -R$ 5.910,46 | -R$ 11.364,17 | -R$ 12.879,09 | -R$ 13.636,55 | -R$ 15.908,93 | -R$ 25.000,00 | -R$ 30.000,00 | -R$ 35.000,00 |
| **Simples Nacional** | -R$ 780,18 | -R$ 1.500,07 | -R$ 1.700,04 | -R$ 1.800,03 | -R$ 2.099,98 | -R$ 4.440,00 *(7,4%)* | -R$ 5.904,00 *(8,2%)* | -R$ 7.140,00 *(8,5%)* |
| **Taxas SIPAG/Stone (D+1: 3,18%)** | -R$ 451,09 | -R$ 867,31 | -R$ 982,93 | -R$ 1.040,74 | -R$ 1.214,17 | -R$ 1.908,00 | -R$ 2.289,60 | -R$ 2.671,20 |
| **Comissão (1,80%) + Encargos (0,51%)** | -R$ 328,05 | -R$ 630,73 | -R$ 714,95 | -R$ 757,00 | -R$ 883,14 | -R$ 1.387,80 | -R$ 1.665,36 | -R$ 1.942,92 |
| **Embalagens & Perdas (1,5%)** | -R$ 212,78 | -R$ 409,11 | -R$ 463,65 | -R$ 490,92 | -R$ 572,72 | -R$ 900,00 | -R$ 1.080,00 | -R$ 1.260,00 |
| **Margem de Contribuição** | **R$ 6.502,50** | **R$ 12.502,50** | **R$ 14.169,17** | **R$ 15.002,50** | **R$ 17.502,50** | **R$ 26.364,20** | **R$ 31.061,04** | **R$ 35.985,88** |
| **Custos Fixos Regulares** | -R$ 4.502,50 *(Carência)* | -R$ 10.502,50 | -R$ 10.502,50 | -R$ 10.502,50 | -R$ 10.502,50 | -R$ 10.502,50 | -R$ 10.502,50 | -R$ 10.502,50 |
| **Provisão Eventos (R$ 4k/60d)** | -R$ 2.000,00 | -R$ 2.000,00 | -R$ 2.000,00 | -R$ 2.000,00 | -R$ 2.000,00 | -R$ 2.000,00 | -R$ 2.000,00 | -R$ 2.000,00 |
| **LUCRO LÍQUIDO MÉDIO** | **R$ 0,00** | **R$ 0,00** | **R$ 1.666,67** | **R$ 2.500,00** | **R$ 5.000,00** | **R$ 13.861,70** | **R$ 18.558,54** | **R$ 23.483,38** |
| **Margem Líquida Média %** | **0,0%** | **0,0%** | **5,4%** | **7,6%** | **13,1%** | **23,1%** | **25,8%** | **28,0%** |
| **Prazo de Payback do Capex** | **Carência** | **Breakeven** | **18,0 Meses** | **12,0 Meses** | **6,0 Meses** | **2,2 Meses (65d)** | **1,6 Meses (49d)** | **1,3 Meses (38d)** |
| **Lucro Líquido Acumulado Ano 1** | *(3m Carência)* | -R$ 3.232,50 | R$ 16.767,50 | R$ 26.767,50 | R$ 56.767,50 | **R$ 163.107,90** | **R$ 219.469,98** | **R$ 278.568,06** |
| **(+) Benefício Caixa Carência 3m**| **+R$ 18.000,00**| **+R$ 18.000,00**| **+R$ 18.000,00**| **+R$ 18.000,00**| **+R$ 18.000,00**| **+R$ 18.000,00**| **+R$ 18.000,00**| **+R$ 18.000,00**|
| **ROI Anual s/ Capex (R$ 30k)** | **-** | **0,0%** | **55,9%** | **89,2%** | **189,2%** | **543,7%** | **731,6%** | **928,6%** |
| **Venda Média / Dia (26d)** | R$ 545,58 | R$ 1.049,00 | R$ 1.188,84 | R$ 1.258,76 | R$ 1.468,52 | **R$ 2.307,69** | **R$ 2.769,23** | **R$ 3.230,77** |
| **Atendimentos/Dia (Ticket R$ 420)**| 1,3 clientes | 2,5 clientes | 2,8 clientes | 3,0 clientes | 3,5 clientes | **5,5 clientes** | **6,6 clientes** | **7,7 clientes** |

---

## 👩‍💼 Remuneração da Vendedora (CLT 6h / 60% das Vendas)

| Cenário de Faturamento da Loja | Faturamento Total da Loja | Vendas da Vendedora (60%) | Comissão (3%) | Salário Fixo CLT | Remuneração Bruta Mensal | Salário Líquido Estimado | Ganho Global Anual (c/ 13º, Férias, VT e FGTS) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Ponto Equilíbrio c/ Eventos** | R$ 29.019,20 | R$ 17.411,52 | R$ 522,35 | R$ 2.100,00 | **R$ 2.622,35** | **~R$ 2.281,40** | **R$ 45.698,00 / ano** |
| **Cenário 1 (Payback 18m)** | R$ 32.655,01 | R$ 19.593,01 | R$ 587,79 | R$ 2.100,00 | **R$ 2.687,79** | **~R$ 2.340,30** | **R$ 46.680,20 / ano** |
| **Cenário 2 (Payback 12m)** | R$ 34.472,92 | R$ 20.683,75 | R$ 620,51 | R$ 2.100,00 | **R$ 2.720,51** | **~R$ 2.369,75** | **R$ 47.171,00 / ano** |
| **Cenário 3 (Payback 6m)** | R$ 39.926,63 | R$ 23.955,98 | R$ 718,68 | R$ 2.100,00 | **R$ 2.818,68** | **~R$ 2.458,10** | **R$ 48.643,50 / ano** |
| **Cenário 4 (Compra R$ 25k)** | R$ 60.000,00 | R$ 36.000,00 | R$ 1.080,00 | R$ 2.100,00 | **R$ 3.180,00** | **~R$ 2.773,58** | **R$ 53.711,92 / ano** |
| **Projeção JOY (Mês 6 - 1.000 al.)** | R$ 66.750,00 | R$ 40.050,00 | R$ 1.201,50 | R$ 2.100,00 | **R$ 3.301,50** | **~R$ 2.876,46** | **R$ 55.461,51 / ano** |
| **Cenário 5 (Compra R$ 30k)** | R$ 72.000,00 | R$ 43.200,00 | R$ 1.296,00 | R$ 2.100,00 | **R$ 3.396,00** | **~R$ 2.953,38** | **R$ 56.822,31 / ano** |
| **Projeção JOY (Maturidade)** | R$ 79.200,00 | R$ 47.520,00 | R$ 1.425,60 | R$ 2.100,00 | **R$ 3.525,60** | **~R$ 3.058,88** | **R$ 58.688,55 / ano** |
| **Cenário 6 (Compra R$ 35k)** | R$ 84.000,00 | R$ 50.400,00 | R$ 1.512,00 | R$ 2.100,00 | **R$ 3.612,00** | **~R$ 3.129,21** | **R$ 59.932,70 / ano** |
| **Supermeta (R$ 100k)** | R$ 100.000,00 | R$ 60.000,00 | R$ 1.800,00 | R$ 2.100,00 | **R$ 3.900,00** | **~R$ 3.376,98** | **R$ 64.072,97 / ano** |

---

## 🚀 Plano de Expansão High-Ticket & Governança Multi-Unidades

O projeto conta com inteligência completa de expansão em **[plano_de_expansao/](file:///c:/Users/paulojr/Documents/SIE-Joy/plano_de_expansao/)**, documentada no dossiê oficial **[Plano_de_Expansao_SIE_Wear.pdf](file:///c:/Users/paulojr/Documents/SIE-Joy/plano_de_expansao/Plano_de_Expansao_SIE_Wear.pdf)** (6 páginas A4 executivas):

1. **Alvos de Prioridade Máxima (Tier 1 & Rede JOY)**:
   - **[JOY Wellness Club](https://www.founderjoy.com.br/) (Esteves Júnior)**: Unidade Piloto Oficial (1.700 m², Centro de Floripa).
   - **[JOY Wellness Club](https://www.founderjoy.com.br/) (Mauro Ramos)**: Matriz original ao lado do Beiramar Shopping (Technogym, sauna, cold plunge). Prioridade imediata para replicação de rede.
   - **[F.Scherer Fitness](https://fscherer.com.br/) (Beiramar Shopping, 6º Piso)**: Academia boutique tradicional da família Scherer, com bike studio, yoga e Clínica K Sports (público feminino de alto ticket).
   - **Last Wellness Club** (Praia Brava / Itajaí) e **Wave Barra Sul** (Balneário Camboriú).
   - **INEEX Club** (Praça Japão / Porto Alegre) e **Just Burn Club** (Moinhos de Vento / POA).
2. **Modelos de Negócio Escaláveis**: Shop-in-Shop Integral (padrão JOY), Corner em Consignação com risco fixo zero (15-20% de comissão) e Pop-Up Drops.
3. **Planejamento Tributário & Societário**: Rampa do Simples Nacional (4% a 10,8%), sublimite estadual de ICMS (R$ 3,6M), transição para Lucro Presumido (> R$ 4,8M), blindagem patrimonial via Holding e parcerias locais via SCP.
