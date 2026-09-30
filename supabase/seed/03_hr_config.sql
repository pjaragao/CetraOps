-- =====================================================================
-- Seed de CONFIGURAÇÃO do RH (idempotente): perfis, catálogo de verbas da folha, políticas, benefícios padrão e feriados.
-- Roda em qualquer ambiente, depois de 01/02. Tudo editável nas telas de configuração.
-- =====================================================================

-- Perfil "RH / Departamento Pessoal" e permissões de folha para o contador (leitura)
insert into core.roles (org_id, key, name, is_superuser)
values ('00000000-0000-4000-8000-000000000001', 'hr', 'RH / Departamento Pessoal', false)
on conflict (org_id, key) do nothing;

insert into core.role_permissions (role_id, permission_key)
select r.id, p from core.roles r, unnest(case r.key
  when 'hr' then array['core.read', 'crm.read', 'fin.read', 'fiscal.read', 'hr.read', 'hr.write', 'hr.payroll.read', 'hr.payroll.write', 'hr.sensitive']
  when 'accountant' then array['hr.read', 'hr.payroll.read']
  else array[]::text[] end) as p
where r.org_id = '00000000-0000-4000-8000-000000000001' and r.key in ('hr', 'accountant')
on conflict do nothing;

-- Políticas de RH (parâmetros editáveis)
insert into core.settings (org_id, key, value) values
  ('00000000-0000-4000-8000-000000000001', 'hr_policies',
   '{"ot_weekday_pct": 50, "ot_holiday_pct": 100, "night_pct": 20, "tolerance_min": 10, "sunday_double": 1, "holiday_double": 1,
     "dsr_on_variable": 1, "advance_pct": 40, "bank_multiplier": 1, "irrf_reducer_13th": 1}')
on conflict (org_id, key) do nothing;

-- Catálogo de verbas (rubricas) da folha
insert into hr.payroll_events (org_id, code, name, kind, inss, irrf, fgts, vacation_avg, variable, expense_role, liability_role, esocial_code)
select '00000000-0000-4000-8000-000000000001', x.code, x.name, x.kind, x.inss, x.irrf, x.fgts, x.vavg, x.var, x.exp, x.liab, x.es
from (values
  -- proventos
  ('SALARIO',           'Salário',                                   'EARNING',  true,  true,  true,  false, false, 'PAYROLL_SALARY',      null, '1000'),
  ('HE50',              'Horas extras',                              'EARNING',  true,  true,  true,  true,  true,  'PAYROLL_OVERTIME',    null, '1003'),
  ('HE100',             'Horas em domingo/feriado',                  'EARNING',  true,  true,  true,  true,  true,  'PAYROLL_OVERTIME',    null, '1004'),
  ('ADIC_NOT',          'Adicional noturno',                         'EARNING',  true,  true,  true,  true,  true,  'PAYROLL_OVERTIME',    null, '1005'),
  ('DSR_VAR',           'DSR sobre horas extras e adicionais',       'EARNING',  true,  true,  true,  true,  false, 'PAYROLL_OVERTIME',    null, '1006'),
  ('COMISSAO',          'Comissões e bônus de vendas',               'EARNING',  true,  true,  true,  true,  true,  'COMMISSION_EXPENSE',  null, '1010'),
  ('DSR_COM',           'DSR sobre comissões',                       'EARNING',  true,  true,  true,  true,  false, 'COMMISSION_EXPENSE',  null, '1011'),
  ('BONUS',             'Bônus / gratificação',                      'EARNING',  true,  true,  true,  true,  true,  'PAYROLL_SALARY',      null, '1020'),
  ('AJUDA_CUSTO',       'Ajuda de custo / outros proventos (não integra)', 'EARNING', false, false, false, false, false, 'PAYROLL_OTHER', null, '1030'),
  ('SAL_FAMILIA',       'Salário-família',                           'EARNING',  false, false, false, false, false, 'PAYROLL_OTHER',       null, '1040'),
  ('PROLABORE',         'Pró-labore',                                'EARNING',  true,  true,  false, false, false, 'PROLABORE_EXPENSE',   null, '1050'),
  ('ADIANTAMENTO',      'Adiantamento salarial',                     'EARNING',  false, false, false, false, false, 'ADVANCE_EMPLOYEES',   null, '1060'),
  ('FERIAS',            'Férias gozadas',                            'EARNING',  true,  true,  true,  false, false, 'PAYROLL_VACATION',    null, '1200'),
  ('FERIAS_1_3',        '1/3 constitucional de férias',              'EARNING',  true,  true,  true,  false, false, 'PAYROLL_VACATION',    null, '1201'),
  ('ABONO_FERIAS',      'Abono pecuniário de férias',                'EARNING',  false, false, false, false, false, 'PAYROLL_VACATION',    null, '1202'),
  ('ABONO_1_3',         '1/3 sobre o abono pecuniário',              'EARNING',  false, false, false, false, false, 'PAYROLL_VACATION',    null, '1203'),
  ('FERIAS_DOBRA',      'Dobra legal das férias (art. 137)',         'EARNING',  false, false, false, false, false, 'PAYROLL_VACATION',    null, '1204'),
  ('ADIANT_13_FER',     'Adiantamento do 13º nas férias',            'EARNING',  false, false, false, false, false, 'PAYROLL_13TH',        null, '1300'),
  ('DEC_TERCEIRO_1',    '13º salário — 1ª parcela',                  'EARNING',  false, false, false, false, false, 'PAYROLL_13TH',        null, '1301'),
  ('DEC_TERCEIRO_2',    '13º salário — integral (2ª parcela)',       'EARNING',  true,  true,  false, false, false, 'PAYROLL_13TH',        null, '1302'),
  ('SALDO_SALARIO',     'Saldo de salário',                          'EARNING',  true,  true,  true,  false, false, 'PAYROLL_SALARY',      null, '1400'),
  ('AVISO_INDENIZADO',  'Aviso prévio indenizado',                   'EARNING',  false, false, true,  false, false, 'PAYROLL_TERMINATION', null, '1401'),
  ('DEC_TERCEIRO_PROP', '13º salário proporcional',                  'EARNING',  true,  true,  false, false, false, 'PAYROLL_13TH',        null, '1402'),
  ('FERIAS_VENC',       'Férias vencidas (indenizadas)',             'EARNING',  false, false, false, false, false, 'PAYROLL_VACATION',    null, '1403'),
  ('FERIAS_VENC_1_3',   '1/3 sobre férias vencidas',                 'EARNING',  false, false, false, false, false, 'PAYROLL_VACATION',    null, '1404'),
  ('FERIAS_PROP',       'Férias proporcionais (indenizadas)',        'EARNING',  false, false, false, false, false, 'PAYROLL_VACATION',    null, '1405'),
  ('FERIAS_PROP_1_3',   '1/3 sobre férias proporcionais',            'EARNING',  false, false, false, false, false, 'PAYROLL_VACATION',    null, '1406'),
  -- descontos
  ('INSS',              'INSS',                                      'DEDUCTION', false, false, false, false, false, null,                  'INSS_PAYABLE',          '9201'),
  ('IRRF',              'IRRF',                                      'DEDUCTION', false, false, false, false, false, null,                  'IRRF_PAYABLE',          '9203'),
  ('FALTAS',            'Faltas injustificadas',                     'DEDUCTION', false, false, false, false, false, 'PAYROLL_SALARY',      null,                    '9001'),
  ('DSR_FALTAS',        'DSR perdido por faltas',                    'DEDUCTION', false, false, false, false, false, 'PAYROLL_SALARY',      null,                    '9002'),
  ('ATRASOS',           'Atrasos',                                   'DEDUCTION', false, false, false, false, false, 'PAYROLL_SALARY',      null,                    '9003'),
  ('DESC_VT',           'Desconto de vale-transporte',               'DEDUCTION', false, false, false, false, false, 'PAYROLL_VT',          null,                    '9010'),
  ('DESC_VR',           'Desconto de vale-refeição/alimentação',     'DEDUCTION', false, false, false, false, false, 'PAYROLL_VR',          null,                    '9011'),
  ('DESC_SAUDE',        'Desconto de plano de saúde',                'DEDUCTION', false, false, false, false, false, 'PAYROLL_HEALTH',      null,                    '9012'),
  ('DESC_BEN',          'Desconto de outros benefícios',             'DEDUCTION', false, false, false, false, false, 'PAYROLL_OTHER',       null,                    '9013'),
  ('ADIANT',            'Adiantamento salarial',                     'DEDUCTION', false, false, false, false, false, null,                  'ADVANCE_EMPLOYEES',     '9020'),
  ('PENSAO',            'Pensão alimentícia',                        'DEDUCTION', false, false, false, false, false, null,                  'GARNISHMENTS_PAYABLE',  '9030'),
  ('EMPREST',           'Empréstimo consignado',                     'DEDUCTION', false, false, false, false, false, null,                  'GARNISHMENTS_PAYABLE',  '9031'),
  ('OUTROS_DESC',       'Outros descontos',                          'DEDUCTION', false, false, false, false, false, null,                  'GARNISHMENTS_PAYABLE',  '9039'),
  ('DESC_13_ANT',       '(−) 13º já adiantado',                      'DEDUCTION', false, false, false, false, false, 'PAYROLL_13TH',        null,                    '9040'),
  ('AVISO_DESC',        'Aviso prévio não cumprido',                 'DEDUCTION', false, false, false, false, false, 'PAYROLL_TERMINATION', null,                    '9041'),
  -- encargos do empregador
  ('FGTS_EMP',          'FGTS',                                      'EMPLOYER', false, false, false, false, false, 'PAYROLL_FGTS',         'FGTS_PAYABLE',          '9501'),
  ('MULTA_FGTS',        'Multa rescisória do FGTS',                  'EMPLOYER', false, false, false, false, false, 'PAYROLL_TERMINATION',  'FGTS_PAYABLE',          '9502'),
  ('INSS_PATRONAL',     'INSS patronal',                             'EMPLOYER', false, false, false, false, false, 'PAYROLL_INSS_EMPLOYER','INSS_PAYABLE',          '9503'),
  ('RAT',               'RAT / FAP',                                 'EMPLOYER', false, false, false, false, false, 'PAYROLL_INSS_EMPLOYER','INSS_PAYABLE',          '9504'),
  ('TERCEIROS',         'Contribuições a terceiros (Sistema S)',     'EMPLOYER', false, false, false, false, false, 'PAYROLL_INSS_EMPLOYER','INSS_PAYABLE',          '9505'),
  ('BEN_VT',            'Vale-transporte (custo da empresa)',        'EMPLOYER', false, false, false, false, false, 'PAYROLL_VT',           'BENEFITS_PAYABLE',      '9510'),
  ('BEN_VR',            'Vale-refeição/alimentação (custo)',         'EMPLOYER', false, false, false, false, false, 'PAYROLL_VR',           'BENEFITS_PAYABLE',      '9511'),
  ('BEN_SAUDE',         'Plano de saúde e seguros (custo)',          'EMPLOYER', false, false, false, false, false, 'PAYROLL_HEALTH',       'BENEFITS_PAYABLE',      '9512'),
  ('BEN_OUTROS',        'Outros benefícios (custo)',                 'EMPLOYER', false, false, false, false, false, 'PAYROLL_OTHER',        'BENEFITS_PAYABLE',      '9513')
) as x(code, name, kind, inss, irrf, fgts, vavg, var, exp, liab, es)
on conflict (org_id, code) do nothing;

-- Tipos de benefício padrão (fornecedor e valores são definidos por colaborador)
insert into hr.benefit_types (org_id, code, name, kind, calc, employee_share_pct, share_base, expense_role) values
  ('00000000-0000-4000-8000-000000000001', 'VT',    'Vale-transporte',              'TRANSPORT', 'DAILY',         6, 'SALARY', 'PAYROLL_VT'),
  ('00000000-0000-4000-8000-000000000001', 'VR',    'Vale-refeição',                'MEAL',      'DAILY',         0, 'COST',   'PAYROLL_VR'),
  ('00000000-0000-4000-8000-000000000001', 'VA',    'Vale-alimentação',             'FOOD',      'MONTHLY_FIXED', 0, 'COST',   'PAYROLL_VR'),
  ('00000000-0000-4000-8000-000000000001', 'SAUDE', 'Plano de saúde',               'HEALTH',    'MONTHLY_FIXED', 0, 'COST',   'PAYROLL_HEALTH'),
  ('00000000-0000-4000-8000-000000000001', 'VIDA',  'Seguro de vida em grupo',      'LIFE',      'MONTHLY_FIXED', 0, 'COST',   'PAYROLL_HEALTH')
on conflict (org_id, code) do nothing;

-- Feriados nacionais (2026–2027) e estadual de SC; municipais e pontos facultativos por loja nas configurações
insert into hr.holidays (org_id, holiday_date, name, scope, uf, optional)
select '00000000-0000-4000-8000-000000000001', x.d::date, x.n, x.s, x.uf, x.opt
from (values
  ('2026-01-01', 'Confraternização Universal', 'NATIONAL', null, false),
  ('2026-02-16', 'Carnaval (segunda)',          'NATIONAL', null, true),
  ('2026-02-17', 'Carnaval (terça)',            'NATIONAL', null, true),
  ('2026-04-03', 'Sexta-feira Santa',           'NATIONAL', null, false),
  ('2026-04-21', 'Tiradentes',                  'NATIONAL', null, false),
  ('2026-05-01', 'Dia do Trabalhador',          'NATIONAL', null, false),
  ('2026-06-04', 'Corpus Christi',              'NATIONAL', null, true),
  ('2026-08-11', 'Dia de Santa Catarina',       'STATE',    'SC', false),
  ('2026-09-07', 'Independência do Brasil',     'NATIONAL', null, false),
  ('2026-10-12', 'Nossa Senhora Aparecida',     'NATIONAL', null, false),
  ('2026-11-02', 'Finados',                     'NATIONAL', null, false),
  ('2026-11-15', 'Proclamação da República',    'NATIONAL', null, false),
  ('2026-11-20', 'Consciência Negra',           'NATIONAL', null, false),
  ('2026-12-25', 'Natal',                       'NATIONAL', null, false),
  ('2027-01-01', 'Confraternização Universal', 'NATIONAL', null, false),
  ('2027-02-08', 'Carnaval (segunda)',          'NATIONAL', null, true),
  ('2027-02-09', 'Carnaval (terça)',            'NATIONAL', null, true),
  ('2027-03-26', 'Sexta-feira Santa',           'NATIONAL', null, false),
  ('2027-04-21', 'Tiradentes',                  'NATIONAL', null, false),
  ('2027-05-01', 'Dia do Trabalhador',          'NATIONAL', null, false),
  ('2027-05-27', 'Corpus Christi',              'NATIONAL', null, true),
  ('2027-08-11', 'Dia de Santa Catarina',       'STATE',    'SC', false),
  ('2027-09-07', 'Independência do Brasil',     'NATIONAL', null, false),
  ('2027-10-12', 'Nossa Senhora Aparecida',     'NATIONAL', null, false),
  ('2027-11-02', 'Finados',                     'NATIONAL', null, false),
  ('2027-11-15', 'Proclamação da República',    'NATIONAL', null, false),
  ('2027-11-20', 'Consciência Negra',           'NATIONAL', null, false),
  ('2027-12-25', 'Natal',                       'NATIONAL', null, false)
) as x(d, n, s, uf, opt)
on conflict do nothing;
