# Diretrizes do Projeto & Instruções para IA / Desenvolvedores

Este documento estabelece as regras de governança, arquitetura e manutenção contínua do projeto **SIÉ Wear @ JOY Wellness Club**.

---

## 🔒 Regra de Ouro: Sincronização Obrigatória (.xlsx $\leftrightarrow$ .md)

> [!IMPORTANT]
> **TODA E QUALQUER ALTERAÇÃO** realizada nas premissas de negócio, custos, alíquotas, taxas de cartão, investimentos ou projeções **DEVE ser refletida simultaneamente**:
> 1. Na planilha Excel (`primeira_unidade_joy/Plano_de_Negocios_SIE_JOY.xlsx`), através da atualização do script gerador `scripts/build_financial_model.py`.
> 2. Em todos os arquivos de documentação Markdown (`README.md`, `primeira_unidade_joy/docs/*.md` e `plano_de_expansao/*.md`).

Nenhum arquivo `.md` pode conter valores defasados em relação à planilha Excel.

---

## 🏗️ Arquitetura do Repositório & Módulos

O repositório foi estruturado em módulos independentes e especializados:

1. **Primeira Unidade Piloto (`primeira_unidade_joy/`)**:
   - Centraliza o arquivo Excel mestre (`Plano_de_Negocios_SIE_JOY.xlsx`), o parecer em PDF/Markdown de CNAEs e a pasta `docs/` com 9 notas técnicas aprofundadas.
   - Serve como base histórica, piloto de validação e modelo operacional.

2. **Plano de Expansão High-Ticket (`plano_de_expansao/`)**:
   - Centraliza o dossiê executivo compilado em PDF (`Plano_de_Expansao_SIE_Wear.pdf`), o mapeamento regional de 14 cidades em SC e RS e os 3 modelos comerciais de parceria.

3. **Sistema Web & PDV (`sistema_web/`)**:
   - Servidor HTTP nativo em Python, gateway de webhooks Stone e painel interativo de vendas e simulações em tempo real.

4. **Automação & Scripts (`scripts/`)**:
   - Scripts geradores do Excel, validadores de integridade referencial de fórmulas e compiladores de PDF via Edge Headless.

---

## 📋 Mapeamento de Abas e Células-Chave no Excel

Ao modificar o script `scripts/build_financial_model.py`, mantenha os seguintes endereços na aba `Premissas`:

| Código | Célula | Descrição do Parâmetro | Valor Atual |
| :--- | :---: | :--- | :---: |
| `P03` | `C7` | Perfil do Aluno JOY (Ticket Médio Musculação/Clube) | R$ 1.300,00 |
| `P04` | `C8` | Base Inicial de Alunos (Mês 1) | 400 |
| `P05` | `C9` | Meta de Alunos em 6 Meses | 1.000 |
| `P06` | `C10` | Jornada de Trabalho Vendedora | 6 horas |
| `P07` | `C11` | Dias de Operação / Mês | 26 dias |
| `P08` | `C12` | Dias Úteis Trabalhados para VT | 22 dias |
| `INV_TOT` | `C23` | **Total Investimento Inicial (Capex)** | **R$ 30.000,00** |
| `CF01` | `C26` | Aluguel do Espaço na JOY | R$ 6.800,00 |
| `CF02` | `C27` | Salário Base Vendedora (CLT 6h/dia) | R$ 2.100,00 |
| `CF03` | `C28` | Tarifa de Ônibus por Trajeto (VT) | R$ 15,00 |
| `CF07` | `C32` | Custo Líquido de VT para a Empresa | R$ 534,00 |
| `CF09` | `C34` | Encargos & Provisões Salário Base (~28,5%) | R$ 598,50 |
| `CF10` | `C35` | Honorários Contábeis Especializados | R$ 650,00 |
| `CF11` | `C36` | Software PDV / Emissor Fiscal NFC-e | R$ 220,00 |
| `CF12` | `C37` | Despesas Gerais / Embalagens Base / Internet / Limpeza | R$ 400,00 |
| `CF_TOT` | `C38` | **Total de Custos Fixos Mensais Regulares** | **R$ 11.302,50** |
| `VAC_TOT` | `C44` | **Custo Mensal Vendedora Substituta (Férias)** | **R$ 3.232,50** |
| `COM01` | `C49` | **Markup Praticado SIÉ Wear** | **2,40** |
| `COM02` | `C50` | CMV (% sobre Preço de Venda = 1 / Markup) | 41,67% |
| `COM03` | `C51` | Margem Bruta Comercial (% sobre Venda) | 58,33% |
| `COM04` | `C52` | % Vendas Realizadas pela Vendedora | 60,00% |
| `COM05` | `C53` | % Vendas Diretas Proprietária | 40,00% |
| `COM06` | `C54` | Taxa de Comissão da Vendedora | 3,00% |
| `COM07` | `C55` | Comissão Efetiva Global s/ Faturamento | 1,80% |
| `COM08` | `C56` | Encargos s/ Comissão Efetiva | 0,51% |
| `COM09` | `C57` | Embalagens de Luxo / Sacolas / Mimos | 1,00% |
| `COM10` | `C58` | Provisão para Avarias, Trocas e Ajustes | 0,50% |
| `TAX_ADOT` | `C83` | **Taxa Média SIPAG Adotada (D+1 Antecipado)** | **3,18%** |
| `TRIB_PADRAO` | `C90` | Alíquota Simples Nacional (Faixa Inicial < R$ 35k/mês) | 5,50% |
| `EV01` | `C96` | **Custo por Evento de Ativação / Drop** | **R$ 4.000,00** |
| `EV02` | `C97` | Periodicidade dos Eventos (Dias) | 60 dias |
| `EV03` | `C98` | Quantidade de Eventos no Ano 1 | 6 eventos |
| `EV05` | `C100` | **Provisão Média Mensal de Eventos** | **R$ 2.000,00** |
| `EV06` | `C101` | **Desembolso Anual em Eventos (Ano 1)** | **R$ 24.000,00** |

---

## 🛠️ Procedimento Padrão para Alterações Futuras

Sempre que o usuário solicitar uma alteração (exemplo: *"o aluguel subiu para R$ 7.500"* ou *"o salário da vendedora é R$ 2.500"*):

1. **Atualizar o script**: Abra `scripts/build_financial_model.py` e altere a respectiva linha de premissa em `premissas_rows`.
2. **Executar a geração**:
   ```bash
   python scripts/build_financial_model.py
   ```
3. **Validar as fórmulas**:
   ```bash
   python scripts/validate_formulas.py
   ```
4. **Extrair os novos resultados**:
   ```bash
   python scripts/dump_values.py
   ```
5. **Atualizar a documentação**: Modifique os arquivos correspondentes em `docs/` e `README.md` com os novos valores consolidados.
