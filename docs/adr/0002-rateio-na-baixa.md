# ADR-0002 — O rateio acontece na baixa (liquidação)

**Contexto.** Um Pix pode pagar dois títulos de um fornecedor; um recebimento pode quitar vários títulos a receber; o pagamento de um funcionário tem
salário, descontos e adicionais. A conciliação precisa dessas relações N:M. A versão inicial previa um item de menu "Rateios".

**Decisão.**
- **Não há menu "Rateios" para baixar.** O rateio é feito **dentro da baixa**: as linhas da liquidação ligam 1 movimento a N parcelas (e vice-versa), com juros, multa, desconto e diferença.
- **Modelos e regras por direcionador** (receita, margem, pedidos, headcount, m², percentuais fixos) ficam em Configurações › Rateios; o fechamento mensal os aplica e gera lançamentos **gerenciais** (livro MGMT) — o DRE mostra "com/sem rateio corporativo" sem tocar o livro legal.
- Folha: um único Pix/lote paga os holerites; os descontos e encargos geram os títulos e lançamentos próprios.

**Consequências.** A conciliação bancária casa 1 linha de extrato com N baixas; o DRE por loja/canal/CNPJ usa as linhas de alocação; nenhum valor do banco é sobrescrito (diferenças vão para conta de ajuste).
