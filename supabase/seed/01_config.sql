-- =====================================================================
-- Seed de CONFIGURAÇÃO (idempotente). Roda em qualquer ambiente.
-- Org fixa da instalação; CNPJ/lojas reais são cadastrados pela tela de Configurações.
-- =====================================================================

insert into core.orgs (id, name, slug)
values ('00000000-0000-4000-8000-000000000001', 'Minha empresa', 'principal')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Papéis e permissões
-- ---------------------------------------------------------------------
insert into core.roles (org_id, key, name, is_superuser) values
  ('00000000-0000-4000-8000-000000000001', 'owner', 'Administrador(a) — acesso total', true),
  ('00000000-0000-4000-8000-000000000001', 'seller', 'Vendedora', false),
  ('00000000-0000-4000-8000-000000000001', 'finance', 'Financeiro', false),
  ('00000000-0000-4000-8000-000000000001', 'accountant', 'Contador (leitura)', false)
on conflict (org_id, key) do nothing;

insert into core.role_permissions (role_id, permission_key)
select r.id, p from core.roles r, unnest(case r.key
  when 'seller' then array['crm.read', 'crm.write', 'catalog.read', 'inv.read', 'sales.read', 'sales.write',
                           'omni.read', 'omni.write', 'ai.read', 'fin.reimburse', 'ai.assistant']
  when 'finance' then array['core.read', 'crm.read', 'catalog.read', 'inv.read', 'sales.read', 'fin.read', 'fin.write',
                            'fiscal.read', 'fiscal.write', 'ai.read', 'fin.reimburse', 'ai.assistant']
  when 'accountant' then array['core.read', 'catalog.read', 'inv.read', 'sales.read', 'fin.read', 'fiscal.read', 'ai.assistant']
  else array[]::text[] end) as p
where r.org_id = '00000000-0000-4000-8000-000000000001'
on conflict do nothing;

-- ---------------------------------------------------------------------
-- DRE gerencial
-- ---------------------------------------------------------------------
insert into fin.dre_lines (org_id, code, name, position, sign, is_subtotal, formula) values
  ('00000000-0000-4000-8000-000000000001', 'RB',  'Receita bruta',                 10,  1, false, null),
  ('00000000-0000-4000-8000-000000000001', 'DED', '(−) Deduções (DAS, devoluções)', 20, -1, false, null),
  ('00000000-0000-4000-8000-000000000001', 'RL',  'Receita líquida',               30,  1, true,  'RB-DED'),
  ('00000000-0000-4000-8000-000000000001', 'CMV', '(−) CMV',                        40, -1, false, null),
  ('00000000-0000-4000-8000-000000000001', 'LB',  'Lucro bruto',                   50,  1, true,  'RL-CMV'),
  ('00000000-0000-4000-8000-000000000001', 'DV',  '(−) Despesas variáveis de venda', 60, -1, false, null),
  ('00000000-0000-4000-8000-000000000001', 'MC',  'Margem de contribuição',        70,  1, true,  'LB-DV'),
  ('00000000-0000-4000-8000-000000000001', 'DF',  '(−) Despesas fixas',             80, -1, false, null),
  ('00000000-0000-4000-8000-000000000001', 'MKT', '(−) Marketing e eventos',        90, -1, false, null),
  ('00000000-0000-4000-8000-000000000001', 'RO',  'Resultado operacional',        100,  1, true,  'MC-DF-MKT'),
  ('00000000-0000-4000-8000-000000000001', 'RF',  '(±) Resultado financeiro',      110,  1, false, null),
  ('00000000-0000-4000-8000-000000000001', 'RLQ', 'Resultado líquido',            120,  1, true,  'RO+RF')
on conflict (org_id, code) do nothing;

-- ---------------------------------------------------------------------
-- Plano de contas (reclassificado: licença de espaço do parceiro anfitrião = patrocínio; MDR ≠ antecipação)
-- colunas: code, name, kind, nature, group, dre_line, accountant_code (código legado quando existe)
-- ---------------------------------------------------------------------
do $$
declare
  v_org uuid := '00000000-0000-4000-8000-000000000001';
  r record;
begin
  for r in select * from (values
    ('1',        'ATIVO',                                          'SYNTHETIC', 'DEBIT',  'ASSET',     null,  null),
    ('1.1',      'Ativo circulante',                               'SYNTHETIC', 'DEBIT',  'ASSET',     null,  '1.1.0.00'),
    ('1.1.1',    'Disponível',                                     'SYNTHETIC', 'DEBIT',  'ASSET',     null,  null),
    ('1.1.1.01', 'Caixa (gaveta da loja)',                         'ANALYTIC',  'DEBIT',  'ASSET',     null,  '1.1.1.01'),
    ('1.1.1.02', 'Banco Inter — conta corrente',                   'ANALYTIC',  'DEBIT',  'ASSET',     null,  '1.1.1.02'),
    ('1.1.1.03', 'Banco BTG Pactual — conta corrente',             'ANALYTIC',  'DEBIT',  'ASSET',     null,  null),
    ('1.1.1.04', 'Mercado Pago — conta',                           'ANALYTIC',  'DEBIT',  'ASSET',     null,  null),
    ('1.1.1.05', 'Saldo em adquirente (Stone/SIPAG)',              'ANALYTIC',  'DEBIT',  'ASSET',     null,  null),
    ('1.1.2',    'Contas a receber',                               'SYNTHETIC', 'DEBIT',  'ASSET',     null,  null),
    ('1.1.2.01', 'Recebíveis de cartão (adquirente)',              'ANALYTIC',  'DEBIT',  'ASSET',     null,  '1.1.2.01'),
    ('1.1.2.02', 'Clientes B2B (boleto)',                          'ANALYTIC',  'DEBIT',  'ASSET',     null,  '1.1.2.02'),
    ('1.1.2.03', 'Pix a compensar',                                'ANALYTIC',  'DEBIT',  'ASSET',     null,  null),
    ('1.1.3',    'Estoques',                                       'SYNTHETIC', 'DEBIT',  'ASSET',     null,  null),
    ('1.1.3.01', 'Mercadorias para revenda',                       'ANALYTIC',  'DEBIT',  'ASSET',     null,  '1.1.3.01'),
    ('1.1.3.02', 'Embalagens e materiais de consumo',              'ANALYTIC',  'DEBIT',  'ASSET',     null,  '1.1.3.02'),
    ('1.1.3.03', 'Mercadorias em consignação com parceiros',       'ANALYTIC',  'DEBIT',  'ASSET',     null,  null),
    ('1.2',      'Ativo não circulante',                           'SYNTHETIC', 'DEBIT',  'ASSET',     null,  '1.2.0.00'),
    ('1.2.1.01', 'Instalações e benfeitorias',                     'ANALYTIC',  'DEBIT',  'ASSET',     null,  '1.2.1.01'),
    ('1.2.1.02', 'Móveis, araras e armários',                      'ANALYTIC',  'DEBIT',  'ASSET',     null,  '1.2.1.02'),
    ('1.2.1.03', 'Equipamentos (POS, tablets, leitores)',          'ANALYTIC',  'DEBIT',  'ASSET',     null,  '1.2.1.03'),
    ('1.2.1.09', '(−) Depreciação acumulada',                      'ANALYTIC',  'CREDIT', 'ASSET',     null,  null),
    ('2',        'PASSIVO',                                        'SYNTHETIC', 'CREDIT', 'LIABILITY', null,  null),
    ('2.1.1.01', 'Fornecedores de mercadorias (30/60/90)',         'ANALYTIC',  'CREDIT', 'LIABILITY', null,  '2.1.1.01'),
    ('2.1.2.01', 'Patrocínio a pagar — parceiro anfitrião',                       'ANALYTIC',  'CREDIT', 'LIABILITY', null,  '2.1.2.01'),
    ('2.1.3.01', 'Salários a pagar',                               'ANALYTIC',  'CREDIT', 'LIABILITY', null,  '2.1.3.01'),
    ('2.1.3.02', 'Comissões a pagar',                              'ANALYTIC',  'CREDIT', 'LIABILITY', null,  '2.1.3.02'),
    ('2.1.3.03', 'FGTS a recolher',                                'ANALYTIC',  'CREDIT', 'LIABILITY', null,  '2.1.3.03'),
    ('2.1.3.04', 'INSS a recolher',                                'ANALYTIC',  'CREDIT', 'LIABILITY', null,  '2.1.3.04'),
    ('2.1.3.05', 'Provisão de 13º salário',                        'ANALYTIC',  'CREDIT', 'LIABILITY', null,  '2.1.3.05'),
    ('2.1.3.06', 'Provisão de férias + 1/3',                       'ANALYTIC',  'CREDIT', 'LIABILITY', null,  '2.1.3.06'),
    ('2.1.4.01', 'DAS — Simples Nacional a recolher',              'ANALYTIC',  'CREDIT', 'LIABILITY', null,  '2.1.4.01'),
    ('2.1.5.01', 'Vale-troca a honrar (clientes)',                 'ANALYTIC',  'CREDIT', 'LIABILITY', null,  null),
    ('2.1.5.02', 'Crédito de afiliados (trainers parceiros)',            'ANALYTIC',  'CREDIT', 'LIABILITY', null,  null),
    ('3',        'PATRIMÔNIO LÍQUIDO',                             'SYNTHETIC', 'CREDIT', 'EQUITY',    null,  '2.2.0.00'),
    ('3.1.01',   'Capital social',                                 'ANALYTIC',  'CREDIT', 'EQUITY',    null,  '2.2.1.01'),
    ('3.1.02',   'Lucros acumulados',                              'ANALYTIC',  'CREDIT', 'EQUITY',    null,  '2.2.2.01'),
    ('3.1.03',   '(−) Distribuição de lucros',                     'ANALYTIC',  'DEBIT',  'EQUITY',    null,  null),
    ('4',        'RECEITAS',                                       'SYNTHETIC', 'CREDIT', 'REVENUE',   'RB',  '5.1.0.00'),
    ('4.1.01',   'Vendas no balcão (PDV)',                         'ANALYTIC',  'CREDIT', 'REVENUE',   'RB',  '5.1.1.01'),
    ('4.1.02',   'Vendas remotas (WhatsApp, Instagram, links)',    'ANALYTIC',  'CREDIT', 'REVENUE',   'RB',  '5.1.1.02'),
    ('4.1.03',   'Vendas B2B / corporativo',                       'ANALYTIC',  'CREDIT', 'REVENUE',   'RB',  '5.1.1.03'),
    ('4.1.04',   'Receita de frete cobrado',                       'ANALYTIC',  'CREDIT', 'REVENUE',   'RB',  null),
    ('4.1.05',   'Receita de serviços (Anexo III: promoção, eventos)', 'ANALYTIC', 'CREDIT', 'REVENUE', 'RB',  null),
    ('5',        'DEDUÇÕES DA RECEITA',                            'SYNTHETIC', 'DEBIT',  'DEDUCTION', 'DED', '5.2.0.00'),
    ('5.1.01',   'DAS — Simples Nacional',                         'ANALYTIC',  'DEBIT',  'DEDUCTION', 'DED', '5.2.1.01'),
    ('5.1.02',   'Devoluções de vendas',                           'ANALYTIC',  'DEBIT',  'DEDUCTION', 'DED', '5.2.2.01'),
    ('5.1.03',   'Descontos concedidos',                           'ANALYTIC',  'DEBIT',  'DEDUCTION', 'DED', null),
    ('6',        'CUSTO DAS MERCADORIAS VENDIDAS',                 'SYNTHETIC', 'DEBIT',  'COGS',      'CMV', '3.0.0.00'),
    ('6.1.01',   'CMV — peças',                                    'ANALYTIC',  'DEBIT',  'COGS',      'CMV', '3.1.1.01'),
    ('6.1.02',   'Embalagens, sacolas e tags aromáticas',          'ANALYTIC',  'DEBIT',  'COGS',      'CMV', '3.1.1.02'),
    ('6.1.03',   'Perdas e avarias de estoque',                    'ANALYTIC',  'DEBIT',  'COGS',      'CMV', null),
    ('7',        'DESPESAS OPERACIONAIS',                          'SYNTHETIC', 'DEBIT',  'EXPENSE',   null,  '4.0.0.00'),
    ('7.1',      'Despesas variáveis de venda',                    'SYNTHETIC', 'DEBIT',  'EXPENSE',   'DV',  '4.1.0.00'),
    ('7.1.01',   'Comissões de vendedoras',                        'ANALYTIC',  'DEBIT',  'EXPENSE',   'DV',  '4.1.1.01'),
    ('7.1.02',   'MDR — taxa de cartão da adquirente',             'ANALYTIC',  'DEBIT',  'EXPENSE',   'DV',  '4.1.2.01'),
    ('7.1.03',   'Fretes e entregas',                              'ANALYTIC',  'DEBIT',  'EXPENSE',   'DV',  '4.1.3.01'),
    ('7.1.04',   'Comissões de afiliados (trainers parceiros)',          'ANALYTIC',  'DEBIT',  'EXPENSE',   'DV',  '4.1.4.01'),
    ('7.2',      'Despesas fixas',                                 'SYNTHETIC', 'DEBIT',  'EXPENSE',   'DF',  '4.3.0.00'),
    ('7.2.01',   'Patrocínio & licença de espaço — parceiro anfitrião',           'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  '4.3.1.01'),
    ('7.2.02',   'Patrocínio pago em peças (meses em espécie)',    'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.03',   'Salários e encargos',                            'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.04',   'Pró-labore dos sócios',                          'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  '4.3.3.01'),
    ('7.2.05',   'Honorários contábeis',                           'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  '4.3.2.01'),
    ('7.2.06',   'Software e assinaturas (Supabase, OpenRouter, Meta, VPS)', 'ANALYTIC', 'DEBIT', 'EXPENSE', 'DF', '4.2.3.01'),
    ('7.2.07',   'Energia, internet e limpeza',                    'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  '4.3.4.01'),
    ('7.2.08',   'Depreciação',                                    'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.2.09',   'Freelancers e prestadores pontuais (PJ/MEI)',    'ANALYTIC',  'DEBIT',  'EXPENSE',   'DF',  null),
    ('7.3',      'Marketing e eventos',                            'SYNTHETIC', 'DEBIT',  'EXPENSE',   'MKT', '4.2.0.00'),
    ('7.3.01',   'Eventos e Drops',                                'ANALYTIC',  'DEBIT',  'EXPENSE',   'MKT', '4.2.1.01'),
    ('7.3.02',   'Mídia paga (Meta Ads)',                          'ANALYTIC',  'DEBIT',  'EXPENSE',   'MKT', '4.2.2.01'),
    ('7.3.03',   'Brindes e influenciadores',                      'ANALYTIC',  'DEBIT',  'EXPENSE',   'MKT', null),
    ('7.3.04',   'Mensagens WhatsApp (templates Meta)',            'ANALYTIC',  'DEBIT',  'EXPENSE',   'MKT', null),
    ('7.3.05',   'Cortesias e indicações (vales-troca)',           'ANALYTIC',  'DEBIT',  'EXPENSE',   'MKT', null),
    ('8',        'RESULTADO FINANCEIRO',                           'SYNTHETIC', 'DEBIT',  'FINANCIAL', 'RF',  null),
    ('8.1.01',   'Taxa de antecipação de recebíveis',              'ANALYTIC',  'DEBIT',  'FINANCIAL', 'RF',  null),
    ('8.1.02',   'Tarifas bancárias',                              'ANALYTIC',  'DEBIT',  'FINANCIAL', 'RF',  null),
    ('8.1.03',   'Juros e multas pagos',                           'ANALYTIC',  'DEBIT',  'FINANCIAL', 'RF',  null),
    ('8.1.05',   'Outras despesas financeiras',                    'ANALYTIC',  'DEBIT',  'FINANCIAL', 'RF',  null),
    ('8.1.06',   'IOF e encargos sobre operações financeiras',     'ANALYTIC',  'DEBIT',  'FINANCIAL', 'RF',  null),
    ('8.2.01',   'Rendimentos de aplicações',                      'ANALYTIC',  'CREDIT', 'FINANCIAL', 'RF',  null)
  ) as t(code, name, kind, nature, grp, dre, acc) loop
    insert into fin.chart_accounts (org_id, parent_id, code, name, kind, nature, "group", dre_line_id, accountant_code)
    values (
      v_org,
      (select id from fin.chart_accounts p where p.org_id = v_org
         and r.code like p.code || '.%' order by length(p.code) desc limit 1),
      r.code, r.name, r.kind, r.nature, r.grp::fin.account_group,
      (select id from fin.dre_lines d where d.org_id = v_org and d.code = r.dre),
      r.acc)
    on conflict (org_id, code) do nothing;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Simples Nacional (LC 123/2006, vigência 2018): Anexo I (comércio) e Anexo III (serviços)
-- ---------------------------------------------------------------------
insert into fiscal.simples_brackets (annex, bracket, max_rbt12, nominal_rate, deduction, icms_share) values
  ('I',   1,  180000.00,  4.00,      0.00, 34.00),
  ('I',   2,  360000.00,  7.30,   5940.00, 34.00),
  ('I',   3,  720000.00,  9.50,  13860.00, 33.50),
  ('I',   4, 1800000.00, 10.70,  22500.00, 33.50),
  ('I',   5, 3600000.00, 14.30,  87300.00, 33.50),
  ('I',   6, 4800000.00, 19.00, 378000.00, null),
  ('III', 1,  180000.00,  6.00,      0.00, null),
  ('III', 2,  360000.00, 11.20,   9360.00, null),
  ('III', 3,  720000.00, 13.50,  17640.00, null),
  ('III', 4, 1800000.00, 16.00,  35640.00, null),
  ('III', 5, 3600000.00, 21.00, 125640.00, null),
  ('III', 6, 4800000.00, 33.00, 648000.00, null)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- Tabela de taxas (proposta Stone do plano de negócios). Ajustar quando a adquirente for definida.
-- ---------------------------------------------------------------------
insert into fin.acquirer_fee_plans (org_id, acquirer, method, inst_from, inst_to, anticipation_mode, rate, settlement_days)
select '00000000-0000-4000-8000-000000000001', 'STONE', m, f, t, mode, rate, d
from (values
  ('PIX',    1,  1, 'NATURAL', 0.0000, 0),
  ('DEBIT',  1,  1, 'NATURAL', 0.8900, 1),
  ('CREDIT', 1,  1, 'NATURAL', 1.2900, 30),
  ('CREDIT', 2,  6, 'NATURAL', 1.5500, 30),
  ('CREDIT', 7, 12, 'NATURAL', 1.8900, 30),
  ('CREDIT', 1,  1, 'D1',      2.8500, 1),
  ('CREDIT', 2,  2, 'D1',      3.9000, 1),
  ('CREDIT', 3,  3, 'D1',      4.7100, 1),
  ('CREDIT', 4,  4, 'D1',      5.5200, 1),
  ('CREDIT', 5,  5, 'D1',      6.3400, 1),
  ('CREDIT', 6,  6, 'D1',      7.1000, 1),
  ('DEBIT',  1,  1, 'D1',      0.8900, 1)
) as x(m, f, t, mode, rate, d)
where not exists (select 1 from fin.acquirer_fee_plans where org_id = '00000000-0000-4000-8000-000000000001' and acquirer = 'STONE');

-- ---------------------------------------------------------------------
-- Catálogo: lista de preço padrão e grades
-- ---------------------------------------------------------------------
insert into catalog.price_lists (org_id, name, kind, is_default)
select '00000000-0000-4000-8000-000000000001', 'Varejo', 'RETAIL', true
where not exists (select 1 from catalog.price_lists where org_id = '00000000-0000-4000-8000-000000000001' and is_default);

insert into catalog.size_grids (org_id, name, sizes) values
  ('00000000-0000-4000-8000-000000000001', 'Feminino PP-GG', array['PP', 'P', 'M', 'G', 'GG']),
  ('00000000-0000-4000-8000-000000000001', 'Masculino P-GG', array['P', 'M', 'G', 'GG', 'XGG']),
  ('00000000-0000-4000-8000-000000000001', 'Tamanho único',  array['U'])
on conflict (org_id, name) do nothing;

-- ---------------------------------------------------------------------
-- CRM: funis e regras de score (migradas do legado)
-- ---------------------------------------------------------------------
insert into crm.pipelines (org_id, kind, name)
select '00000000-0000-4000-8000-000000000001', k, n from (values
  ('B2C', 'Vendas varejo'), ('B2B_CORPORATE', 'Corporativo / uniformes'),
  ('AFFILIATE_RECRUIT', 'Recrutamento de afiliados'), ('EVENT', 'Convidados de eventos')) as x(k, n)
where not exists (select 1 from crm.pipelines where org_id = '00000000-0000-4000-8000-000000000001');

insert into crm.pipeline_stages (org_id, pipeline_id, name, position, probability, sla_hours, is_won, is_lost)
select p.org_id, p.id, s.name, s.pos, s.prob, s.sla, s.won, s.lost
from crm.pipelines p
cross join (values
  ('Novo contato', 1, 10, 24, false, false),
  ('Qualificado', 2, 25, 48, false, false),
  ('Em atendimento', 3, 50, 24, false, false),
  ('Reserva / Armário VIP', 4, 75, 24, false, false),
  ('Ganho', 5, 100, null, true, false),
  ('Perdido', 6, 0, null, false, true)) as s(name, pos, prob, sla, won, lost)
where p.org_id = '00000000-0000-4000-8000-000000000001' and p.kind = 'B2C'
on conflict (pipeline_id, position) do nothing;

insert into crm.lead_scoring_rules (org_id, version, active, rules) values
('00000000-0000-4000-8000-000000000001', 1, true, '{
  "professions": ["médica", "dermato", "cirurgiã", "arquiteta", "advogada", "empresária", "nutróloga", "nutricionista",
                  "dentista", "juíza", "investidora", "diretora", "founder", "ceo", "médico", "advogado", "empresário"],
  "sports": ["pilates", "reformer", "beach tennis", "triatlo", "triathlon", "maratona", "ironman", "musculação",
             "wellness", "yoga", "corrida", "crossfit"],
  "target_cities": ["Florianópolis", "Balneário Camboriú", "Itapema", "Joinville", "Blumenau", "Porto Alegre", "Caxias do Sul"],
  "weights": {"profession": 20, "sports": 20, "has_contact": 10, "target_city": 10, "engaged_conversation": 20, "purchased": 20},
  "tiers": {"hot": 70, "warm": 40}
}')
on conflict (org_id, version) do nothing;

-- ---------------------------------------------------------------------
-- IA: rotas do OpenRouter. Os modelos são placeholders — escolha na tela Inteligência › Qualidade & custos
-- depois do spike/avaliações. Rotas que recebem dado de cliente exigem ZDR.
-- ---------------------------------------------------------------------
insert into ai.model_routes (org_id, task, primary_model, fallback_models, params, requires_tools, requires_json_schema, daily_budget_usd) values
  ('00000000-0000-4000-8000-000000000001', 'conversation',  'anthropic/claude-sonnet-4.5', '{openai/gpt-4.1}',        '{"temperature": 0.6, "max_tokens": 800}', true,  false, 10),
  ('00000000-0000-4000-8000-000000000001', 'classify',      'google/gemini-2.5-flash',     '{openai/gpt-4.1-mini}',   '{"temperature": 0}',                      false, true,  2),
  ('00000000-0000-4000-8000-000000000001', 'extract',       'google/gemini-2.5-flash',     '{openai/gpt-4.1-mini}',   '{"temperature": 0}',                      false, true,  2),
  ('00000000-0000-4000-8000-000000000001', 'summarize',     'google/gemini-2.5-flash',     '{}',                      '{"temperature": 0.2}',                    false, false, 2),
  ('00000000-0000-4000-8000-000000000001', 'persona_style', 'anthropic/claude-opus-4.1',   '{}',                      '{"temperature": 0.3, "max_tokens": 8000}', false, true, 5),
  ('00000000-0000-4000-8000-000000000001', 'judge',         'openai/gpt-4.1',              '{}',                      '{"temperature": 0}',                      false, true,  3),
  ('00000000-0000-4000-8000-000000000001', 'ops_copilot',   'anthropic/claude-sonnet-4.5', '{}',                      '{"temperature": 0.3}',                    true,  false, 3),
  ('00000000-0000-4000-8000-000000000001', 'embeddings',    'openai/text-embedding-3-small', '{}',                    '{"dimensions": 1024}',                    false, false, 1),
  ('00000000-0000-4000-8000-000000000001', 'assistant',     'anthropic/claude-sonnet-4.5', '{}',                      '{"temperature": 0.2, "max_tokens": 1200}', true,  false, 5),
  ('00000000-0000-4000-8000-000000000001', 'vision_extract', 'google/gemini-2.5-flash',    '{}',                      '{"temperature": 0}',                      false, true,  3)
on conflict (org_id, task) do nothing;

-- Feature flags de domínio
insert into core.feature_flags (org_id, key, enabled) values
  ('00000000-0000-4000-8000-000000000001', 'channel.whatsapp', true),
  ('00000000-0000-4000-8000-000000000001', 'channel.instagram', true),
  ('00000000-0000-4000-8000-000000000001', 'channel.telegram', true),
  ('00000000-0000-4000-8000-000000000001', 'channel.tiktok', false),
  ('00000000-0000-4000-8000-000000000001', 'ai.autopilot.whatsapp', false),
  ('00000000-0000-4000-8000-000000000001', 'ai.autopilot.instagram', false),
  ('00000000-0000-4000-8000-000000000001', 'enrichment.apify', false),
  ('00000000-0000-4000-8000-000000000001', 'ai.assistant', true)
on conflict (org_id, key) do nothing;

insert into core.settings (org_id, key, value) values
  ('00000000-0000-4000-8000-000000000001', 'revenue_attribution', '{"pos": "STORE_COUNTER", "remote": "HOME_STORE_DIGITAL", "fallback": "CORP-DIGITAL", "fulfillment_fee_pct": 0}'),
  ('00000000-0000-4000-8000-000000000001', 'assistant_policies', '{"action_ttl_minutes": 15, "max_settle_amount": 5000, "max_messages_per_day": 300, "keep_threads_days": 90, "daily_briefing_notify": true}'),
  ('00000000-0000-4000-8000-000000000001', 'ai_policies', '{"max_discount_pct": 0, "handoff_cart_value": 1500, "reservation_max_hours": 48, "max_ai_reserved_items": 3, "sla_minutes": {"VIP": 5, "STANDARD": 15}}'),
  ('00000000-0000-4000-8000-000000000001', 'commission_plan_default', '{"base": "STORE_REVENUE", "rates_by_channel": {"POS": 3, "WHATSAPP": 3, "INSTAGRAM": 3}, "tiers": [{"from": 35000, "to": 60000, "bonus": 200}, {"from": 60000, "pct_over": 1}]}')
on conflict (org_id, key) do nothing;
