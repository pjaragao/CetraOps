-- =====================================================================
-- Seed de CONFIGURAÇÃO (idempotente): contas adicionais do plano e papéis contábeis usados pelas rotinas
-- que contabilizam (vendas, baixas, folha...). Roda em qualquer ambiente, depois de 01_config.sql.
-- =====================================================================

do $$
declare
  v_org uuid := '00000000-0000-4000-8000-000000000001';
  r record;
begin
  -- Contas novas (code, name, kind, nature, group, dre_line, accountant_code)
  for r in select * from (values
    ('1.1.2.04', 'Permutas a compensar',                             'ANALYTIC',  'DEBIT',  'ASSET',     null,  null),
    ('1.1.4',    'Adiantamentos e tributos a recuperar',             'SYNTHETIC', 'DEBIT',  'ASSET',     null,  null),
    ('1.1.4.01', 'Adiantamentos a fornecedores',                     'ANALYTIC',  'DEBIT',  'ASSET',     null,  null),
    ('1.1.4.02', 'Adiantamentos a empregados (vales)',               'ANALYTIC',  'DEBIT',  'ASSET',     null,  null),
    ('1.1.4.03', 'Impostos retidos a compensar',                     'ANALYTIC',  'DEBIT',  'ASSET',     null,  null),
    ('2.1.3.07', 'Férias a pagar',                                   'ANALYTIC',  'CREDIT', 'LIABILITY', null,  null),
    ('2.1.3.08', 'IRRF sobre folha a recolher',                      'ANALYTIC',  'CREDIT', 'LIABILITY', null,  null),
    ('2.1.3.09', 'Pensão alimentícia e consignados a repassar',      'ANALYTIC',  'CREDIT', 'LIABILITY', null,  null),
    ('2.1.3.10', 'Benefícios a pagar (VR, VT, saúde)',               'ANALYTIC',  'CREDIT', 'LIABILITY', null,  null),
    ('2.1.3.11', '13º salário a pagar',                              'ANALYTIC',  'CREDIT', 'LIABILITY', null,  null),
    ('2.1.3.12', 'Rescisões a pagar',                                'ANALYTIC',  'CREDIT', 'LIABILITY', null,  null),
    ('2.1.3.13', 'Pró-labore a pagar',                               'ANALYTIC',  'CREDIT', 'LIABILITY', null,  null),
    ('2.1.3.14', 'FGTS sobre provisões',                             'ANALYTIC',  'CREDIT', 'LIABILITY', null,  null),
    ('2.1.4.02', 'Tributos retidos de terceiros a recolher',         'ANALYTIC',  'CREDIT', 'LIABILITY', null,  null),
    ('2.1.6.01', 'Adiantamentos de clientes',                        'ANALYTIC',  'CREDIT', 'LIABILITY', null,  null),
    ('2.1.7.01', 'Empréstimos e financiamentos',                     'ANALYTIC',  'CREDIT', 'LIABILITY', null,  null),
    ('4.1.06',   'Outras receitas operacionais',                     'ANALYTIC',  'CREDIT', 'REVENUE',   'RB',  null),
    ('7.2.03.01','Salários e ordenados',                             'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.03.02','Horas extras, adicionais e DSR',                   'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.03.03','Férias e 1/3 constitucional',                      'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.03.04','13º salário',                                      'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.03.05','FGTS',                                             'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.03.06','INSS patronal e encargos',                         'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.03.07','Vale-transporte',                                  'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.03.08','Vale-refeição / alimentação',                      'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.03.09','Plano de saúde e seguro de vida',                  'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.03.10','Rescisões, aviso prévio e multa do FGTS',          'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.03.11','Outros benefícios, uniformes e treinamentos',      'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.10',  'Taxas, licenças e registros (DARE, Junta, alvará, Bombeiros, vigilância sanitária, certidões, IPTU)', 'ANALYTIC', 'DEBIT', 'EXPENSE', 'DF', null),
    ('7.2.11',  'Serviços jurídicos e despachante (contratos, advogada, cartório, registros)', 'ANALYTIC', 'DEBIT', 'EXPENSE', 'DF', null),
    ('7.2.12',  'Despesas de implantação / pré-operacionais (gastos não recorrentes para abrir a loja)', 'ANALYTIC', 'DEBIT', 'EXPENSE', 'DF', null),
    ('7.2.13',  'Telefonia e dados móveis',                          'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.14',  'Material de escritório, uso e consumo',             'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.15',  'Manutenção e reparos',                              'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.16',  'Seguros',                                           'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('1.2.1.04','Expositores, manequins e cabides (itens reutilizáveis de exposição)', 'ANALYTIC', 'DEBIT', 'ASSET', null, null),
    ('2.1.8.01','Reembolsos a pagar a sócios e colaboradores',       'ANALYTIC',  'CREDIT', 'LIABILITY', null,  null),
    ('7.2.99',   'Despesas a classificar',                           'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('8.1.04',   'Diferenças de conciliação e caixa',                'ANALYTIC',  'DEBIT',  'FINANCIAL', 'RF',  null),
    ('8.2.02',   'Descontos obtidos',                                'ANALYTIC',  'CREDIT', 'FINANCIAL', 'RF',  null),
    ('8.2.03',   'Juros e multas recebidos',                         'ANALYTIC',  'CREDIT', 'FINANCIAL', 'RF',  null)
  ) as t(code, name, kind, nature, grp, dre, acc) loop
    insert into fin.chart_accounts (org_id, parent_id, code, name, kind, nature, "group", dre_line_id, accountant_code)
    values (
      v_org,
      (select id from fin.chart_accounts p where p.org_id = v_org and r.code like p.code || '.%' order by length(p.code) desc limit 1),
      r.code, r.name, r.kind, r.nature, r.grp::fin.account_group,
      (select id from fin.dre_lines d where d.org_id = v_org and d.code = r.dre), r.acc)
    on conflict (org_id, code) do nothing;
  end loop;

  -- 7.2.03 "Salários e encargos" vira sintética (as contas de detalhe ficam sob ela)
  update fin.chart_accounts set kind = 'SYNTHETIC', name = 'Salários, encargos e benefícios' where org_id = v_org and code = '7.2.03';
  update fin.chart_accounts c set parent_id = (select id from fin.chart_accounts where org_id = v_org and code = '7.2.03')
  where c.org_id = v_org and c.code like '7.2.03.%';
  update fin.chart_accounts c set parent_id = (select id from fin.chart_accounts where org_id = v_org and code = '1.1.4')
  where c.org_id = v_org and c.code in ('1.1.4.01', '1.1.4.02', '1.1.4.03');

  -- Papéis contábeis → conta (por código)
  for r in select * from (values
    ('CASH_DRAWER', '1.1.1.01'), ('BANK_DEFAULT', '1.1.1.02'),
    ('AR_CARD', '1.1.2.01'), ('AR_B2B', '1.1.2.02'), ('AR_PIX', '1.1.2.03'), ('PERMUTA_RECEIVABLE', '1.1.2.04'),
    ('INVENTORY', '1.1.3.01'),
    ('ADVANCE_SUPPLIERS', '1.1.4.01'), ('ADVANCE_EMPLOYEES', '1.1.4.02'), ('TAX_RECOVERABLE', '1.1.4.03'),
    ('SUPPLIERS', '2.1.1.01'), ('SPONSORSHIP_PAYABLE', '2.1.2.01'),
    ('SALARIES_PAYABLE', '2.1.3.01'), ('COMMISSIONS_PAYABLE', '2.1.3.02'), ('FGTS_PAYABLE', '2.1.3.03'), ('INSS_PAYABLE', '2.1.3.04'),
    ('PROV_13TH', '2.1.3.05'), ('PROV_VACATION', '2.1.3.06'), ('VACATION_PAYABLE', '2.1.3.07'), ('IRRF_PAYABLE', '2.1.3.08'),
    ('GARNISHMENTS_PAYABLE', '2.1.3.09'), ('BENEFITS_PAYABLE', '2.1.3.10'), ('THIRTEENTH_PAYABLE', '2.1.3.11'),
    ('TERMINATION_PAYABLE', '2.1.3.12'), ('PROLABORE_PAYABLE', '2.1.3.13'), ('PROV_FGTS', '2.1.3.14'),
    ('TAX_PAYABLE_DAS', '2.1.4.01'), ('TAX_WITHHELD_PAYABLE', '2.1.4.02'),
    ('STORE_CREDIT_LIABILITY', '2.1.5.01'), ('AFFILIATE_CREDIT_LIABILITY', '2.1.5.02'), ('ADVANCE_CUSTOMERS', '2.1.6.01'),
    ('LOAN_LIABILITY', '2.1.7.01'), ('EQUITY_CAPITAL', '3.1.01'), ('PROFIT_DISTRIBUTION', '3.1.03'),
    ('REV_POS', '4.1.01'), ('REV_REMOTE', '4.1.02'), ('REV_B2B', '4.1.03'), ('REV_FREIGHT', '4.1.04'), ('REV_SERVICE', '4.1.05'),
    ('UNCLASSIFIED_REVENUE', '4.1.06'),
    ('DAS_EXPENSE', '5.1.01'), ('SALES_RETURNS', '5.1.02'), ('DISCOUNT_GIVEN', '5.1.03'),
    ('CMV', '6.1.01'), ('INVENTORY_LOSS', '6.1.03'),
    ('COMMISSION_EXPENSE', '7.1.01'), ('MDR_EXPENSE', '7.1.02'), ('FREIGHT_EXPENSE', '7.1.03'), ('AFFILIATE_EXPENSE', '7.1.04'), ('GOODWILL_EXPENSE', '7.3.05'),
    ('SPONSORSHIP_EXPENSE', '7.2.01'), ('SPONSORSHIP_IN_KIND_EXPENSE', '7.2.02'), ('PROLABORE_EXPENSE', '7.2.04'),
    ('UNCLASSIFIED_EXPENSE', '7.2.99'),
    ('PAYROLL_SALARY', '7.2.03.01'), ('PAYROLL_OVERTIME', '7.2.03.02'), ('PAYROLL_VACATION', '7.2.03.03'), ('PAYROLL_13TH', '7.2.03.04'),
    ('PAYROLL_FGTS', '7.2.03.05'), ('PAYROLL_INSS_EMPLOYER', '7.2.03.06'), ('PAYROLL_VT', '7.2.03.07'), ('PAYROLL_VR', '7.2.03.08'),
    ('PAYROLL_HEALTH', '7.2.03.09'), ('PAYROLL_TERMINATION', '7.2.03.10'), ('PAYROLL_OTHER', '7.2.03.11'),
    ('ANTICIPATION_EXPENSE', '8.1.01'), ('BANK_FEES', '8.1.02'), ('INTEREST_EXPENSE', '8.1.03'), ('RECON_DIFFERENCE', '8.1.04'),
    ('INTEREST_INCOME_INVEST', '8.2.01'), ('DISCOUNT_OBTAINED', '8.2.02'), ('INTEREST_INCOME', '8.2.03')
  ) as t(role, code) loop
    insert into fin.account_roles (org_id, role, chart_account_id)
    select v_org, r.role, a.id from fin.chart_accounts a where a.org_id = v_org and a.code = r.code
    on conflict (org_id, role) do update set chart_account_id = excluded.chart_account_id;
  end loop;
end $$;
