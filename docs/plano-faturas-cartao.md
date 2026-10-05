# Faturas de cartão de crédito corporativo: plano do módulo

> Versão 1.0 · 05/10/2026 · Escopo: tratar a fatura do cartão de crédito da empresa linha a linha, com rateio por categoria e centro de custo, comprovante de cada compra e conciliação com o banco. Somente planejamento; nada foi implementado.

## Resumo

- **Problema.** Hoje a fatura do cartão entraria como um único título "Fatura Inter R$ 4.312,90". O DRE perde o detalhe: o que foi Meta Ads, almoço, combustível ou assinatura. Também não aparece qual compra não tem nota e qual foi pessoal.
- **Proposta.** A fatura vira um documento com linhas:
  - cada compra é classificada (categoria + centro de custo, com rateio quando precisar);
  - cada compra é ligada ao comprovante (NF/recibo) e ao fornecedor efetivo;
  - parcelamentos, estornos, IOF e anuidade têm tratamento próprio.
- **Pagamento.** A fatura fechada gera **uma conta a pagar ao banco emissor**, que é o recebedor. As despesas reconhecidas no DRE são as linhas, cada uma com o fornecedor efetivo (`party_id` da linha), usando o conceito de recebedor diferente que já existe nos títulos.
- **Reaproveitamento.** O módulo reaproveita:
  - os favorecidos e categorias padrão;
  - o recebedor diferente;
  - o Storage de comprovantes e a chave de NF com dígito verificador (do reembolso);
  - as regras de conciliação;
  - a consulta de CNPJ.

## 1. Conceitos

| Conceito | O que é |
|---|---|
| **Cartão** | Cartão corporativo de um banco (Inter, BTG, Mercado Pago…), com **portador** (sócia, vendedora) e final do número. Um cartão titular pode ter adicionais |
| **Fatura** | Período entre dois fechamentos, com data de fechamento, vencimento e total. Situação: aberta → fechada → conferida → paga |
| **Lançamento** | Cada linha da fatura: data, descritor do estabelecimento ("IFD*RESTAURANTE X"), valor, parcela (3/10), cartão/portador. Tipos: compra, estorno, IOF, anuidade, juros/multa, pagamento, crédito/cashback, ajuste |
| **Classificação** | Categoria do plano de contas + centro de custo, ou um modelo de rateio (ex.: Meta Ads 80% digital / 20% balcão) |
| **Comprovante** | NF-e/NFC-e/NFS-e, cupom ou recibo, com arquivo; sem comprovante, só com justificativa |
| **Fornecedor efetivo** | Quem vendeu de fato (restaurante, Meta, posto). O descritor do cartão vira fornecedor por regra aprendida |
| **Despesa pessoal** | Compra pessoal no cartão da empresa: vira **valor a receber do portador** (desconto em folha/pró-labore ou Pix de volta), não despesa |

## 2. Modelo de dados (proposta)

- `fin.cards`:
  - `bank_party_id` (emissor, o recebedor do pagamento), `holder_party_id` (portador), `last4`, `brand`, `parent_card_id` (adicional);
  - `closing_day`, `due_day`, `credit_limit`, `default_cost_center_id`, `active`.
- `fin.card_statements`:
  - `card_id`, `period_start`, `closing_date`, `due_date`, `total_reported` (o que o banco diz) e `total_lines` (soma das linhas);
  - `status OPEN|CLOSED|CHECKED|PAID`, `title_id` (conta a pagar ao banco), `import_id`.
- `fin.card_transactions`:
  - identificação: `statement_id`, `card_id`, `posted_on`, `purchase_on`;
  - texto do banco: `descriptor` (bruto), `descriptor_norm`;
  - valores: `amount` (sinal: estorno e crédito negativos), `kind`, `installment_n/total`, `original_purchase_id` (liga as parcelas), `fx_amount/currency/iof` (compras internacionais);
  - fornecedor: `supplier_party_id`, `supplier_doc`;
  - classificação: `chart_account_id`, `cost_center_id`, `allocation_template_id`;
  - comprovante: `access_key`, `attachment_path`, `no_document_reason`;
  - pessoal: `personal` (bool), `personal_receivable_title_id`;
  - controle: `status UNCLASSIFIED|CLASSIFIED|DOCUMENTED|CHECKED`, `rule_id`, `dedupe_key`.
- `fin.card_transaction_splits`: rateio manual linha a linha (`chart_account_id`, `cost_center_id`, `amount`, `memo`), somando o valor da transação (mesma regra de `fin.title_lines`).
- `fin.card_rules` (aprendizado), com prioridade e contador de acertos:
  - condição: descritor contém/regex, faixa de valor, cartão;
  - ação: fornecedor, categoria, centro de custo, rateio, "pessoal".
- `fin.card_imports`: arquivo importado (OFX, CSV do banco ou XLSX), hash para não importar duas vezes, linhas lidas/novas/repetidas.

**Chaves de idempotência:**
- `dedupe_key = hash(card_id, purchase_on, descriptor_norm, amount, installment_n)`;
- o mesmo arquivo importado de novo não duplica nada.

## 3. Fluxos

### 3.1 Importar a fatura
1. Upload do arquivo do banco:
   - **OFX** (Inter e BTG exportam);
   - **CSV/XLSX** (Mercado Pago e outros), com mapeamento de colunas salvo por banco, como no importador da adquirente.
2. O sistema cria ou atualiza a fatura do período (pelas datas de fechamento do cartão).
3. Para cada linha, nesta ordem:
   1. deduplica;
   2. detecta o tipo pelo descritor ("IOF", "ANUIDADE", "PAGAMENTO EFETUADO", "ESTORNO");
   3. liga as parcelas à compra original;
   4. aplica `card_rules` (fornecedor + categoria + CC);
   5. sem regra, sugere pela IA (rota `classify`), com a categoria em enum do plano de contas e a confiança, **sem aplicar sozinha** abaixo de 0,9.
4. Confere `total_lines` × `total_reported`. Se houver diferença, o painel mostra o que falta (linha não importada, ajuste do banco).

*Fase 2:* leitura direta pela API (Pluggy/Open Finance já previsto no plano principal) ou pelo PDF da fatura (extração por IA, com conferência obrigatória).

### 3.2 Conferir e classificar (tela "Fatura do cartão")
- **Lista das linhas** com filtros (sem categoria, sem comprovante, pessoais, parcelas) e edição em lote: selecionar várias e aplicar categoria/CC/rateio.
- **"Criar regra a partir desta linha"**: na próxima fatura, o mesmo descritor já entra classificado.
- **Comprovante por linha:**
  - foto/PDF (o mesmo bucket `fin-docs`) ou chave da NF (DV conferido, sem repetir em reembolso ou em outra linha);
  - **busca automática na MDe:** NF recebida no CNPJ da empresa com o mesmo CNPJ do emitente, valor igual e data ±3 dias é sugerida para vincular;
  - por portador, uma tarefa "anexe os comprovantes de setembro" com a lista dos que faltam.
- **Marcar como pessoal:** sai da despesa e gera valor a receber do portador. Pode ser descontado na folha (verba da folha "desconto de despesa pessoal") ou cobrado por Pix.
- **Parcelamento:**
  - padrão: a competência de cada parcela é o mês da parcela (o que o caixa vê);
  - opção por regra: a compra parcelada de bem durável reconhece tudo na compra, com as parcelas futuras como passivo (decidir com o contador).
- **Internacional:** valor em moeda, câmbio e IOF separados. O IOF vai para despesa financeira (conta própria).

### 3.3 Fechar e pagar
1. "Fechar fatura" só é liberado com 100% das linhas classificadas. Comprovante é exigido conforme política: obrigatório acima de R$ X, ou alerta só.
2. Ao fechar, gera **um título a pagar** da fatura:
   - `party_id` = banco emissor; `receiver_party_id` = o mesmo;
   - linhas (`title_lines`) agregadas por categoria × centro de custo de todas as transações não pessoais;
   - estornos e créditos reduzem a categoria original;
   - valor = total da fatura;
   - competência das linhas pela data de cada compra/parcela.
   
   Assim o DRE recebe o detalhe sem um título por compra.
3. Despesas pessoais: um título a receber por portador (ou um evento na folha do mês).
4. O pagamento da fatura é a baixa normal do título:
   - **pagamento mínimo/parcial:** baixa parcial; o saldo rotativo e os juros entram na fatura seguinte como linhas JUROS/MULTA → despesa financeira;
   - o pagamento identificado no extrato bancário concilia com o título pela regra já existente.

### 3.4 Conciliação com o banco e a contabilidade
- **Extrato da conta-corrente ↔ título da fatura:** valor + vencimento ±2 dias, com descritor "PAGTO CARTAO" via `recon_rules`.
- **Linha do cartão ↔ comprovante ↔ NF (MDe)**, como na seção 3.2.
- **Fatura ↔ arquivo:** `total_lines` = `total_reported`.
- **Painel de fechamento mensal** (já existe o checklist de fechamento), com o item "faturas de cartão conferidas: 100%, comprovantes: N faltando".

## 4. Regras de negócio

- **Limite de comprovante:** compras ≥ R$ 50 exigem comprovante ou justificativa (parâmetro em `core.settings`).
- **Segregação de funções:**
  - quem é portador não fecha a própria fatura sozinho, salvo sócio;
  - quem classifica pode ser o portador;
  - quem fecha precisa de `fin.approve`.
- **Prazo para o portador anexar comprovantes:** até o fechamento + 5 dias, com lembrete automático (notificação + tarefa).
- **Bloqueio:** período contábil fechado não aceita reclassificação (já existe `assert_period_open`). Ajuste depois do fechamento vira lançamento de ajuste.
- **Reembolso × cartão:**
  - compra no cartão pessoal → reembolso (módulo pronto);
  - compra pessoal no cartão da empresa → "pessoal" na fatura.
  - Os dois módulos compartilham a regra de chave de NF única, então a mesma nota não entra nos dois.

## 5. Permissões

| Permissão | Quem | Pode |
|---|---|---|
| `fin.card.read` | Financeiro, contador | Ver faturas |
| `fin.card.classify` | Financeiro + portadores (só as linhas do próprio cartão) | Classificar e anexar comprovantes |
| `fin.approve` | Sócios | Fechar fatura e gerar o título |
| `core.admin` | Sócios | Cadastrar cartões e portadores |

O menu mostra **Financeiro › Cartões** e, para o portador sem `fin.read`, só "Meu cartão", como já feito em Reembolsos.

## 6. Telas

1. **Financeiro › Cartões:** lista de cartões (banco, portador, final, limite, fatura atual, % classificado, comprovantes faltando).
2. **Fatura:**
   - cabeçalho com fechamento/vencimento/total do banco × total das linhas;
   - grade de linhas com ações em lote, regras e comprovantes;
   - botão Fechar.
3. **Meu cartão (portador):** as próprias compras, os comprovantes que faltam (com câmera do celular) e "isto foi pessoal".
4. **Regras do cartão:** lista editável, com contador de uso e de acerto.
5. **Relatórios:** gastos por categoria/CC/portador/fornecedor; comprovantes faltando; despesas pessoais; parcelas futuras comprometidas (para o fluxo de caixa).

## 7. Integração com o que já existe

- **Fluxo de caixa:** as parcelas futuras e a fatura aberta entram como saída projetada no vencimento.
- **DRE:** as despesas classificadas vêm das linhas do título da fatura (nada novo no DRE).
- **Orçamento:** orçado × realizado por categoria já funciona com as linhas.
- **Favorecidos padrão:**
  - o banco emissor é um favorecido do tipo "Banco / intermediador";
  - Meta, Google e as assinaturas de software ganham categoria padrão.

## 8. Entregas sugeridas

| Etapa | Escopo | Aceite |
|---|---|---|
| 1 | Cartões e portadores; importador OFX/CSV com mapeamento; fatura e linhas; deduplicação; tipos automáticos (IOF, anuidade, estorno, pagamento, parcela) | Importar a mesma fatura duas vezes não duplica; total das linhas = total do banco |
| 2 | Classificação: linha a linha, em lote, rateio, regras aprendidas, sugestão da IA; comprovante por linha; despesa pessoal | Segunda fatura do mesmo cartão entra ≥ 80% classificada pelas regras |
| 3 | Fechar fatura → título ao banco com linhas por categoria × CC; título a receber das despesas pessoais; baixa e pagamento parcial | DRE do mês mostra as despesas do cartão por categoria; pagamento conciliado com o extrato |
| 4 | Busca de NF na MDe; lembretes ao portador; "Meu cartão" no celular; relatórios; parcelas no fluxo de caixa | Checklist de fechamento com o item de cartões; nenhum comprovante sem dono |

Cada etapa: migration + pgTAP + telas + E2E, como nas demais entregas.

## 9. Decisões pendentes com os sócios

1. Quais cartões existem hoje (bancos, titulares, adicionais) e em que formato cada banco exporta a fatura (OFX, CSV, XLSX, só PDF).
2. Valor a partir do qual o comprovante é obrigatório (sugestão: R$ 50) e o prazo do portador para anexar.
3. Compra parcelada: reconhecer por parcela (padrão) ou tudo na compra para bens duráveis (com o contador).
4. Despesa pessoal no cartão da empresa: desconto na folha/pró-labore ou devolução por Pix?
5. Quem fecha a fatura (sugestão: sócio que não é o portador, ou o financeiro).
6. Cashback e pontos do cartão: viram receita financeira, abatimento ou são ignorados?
