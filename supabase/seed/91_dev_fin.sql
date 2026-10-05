-- =====================================================================
-- Seed de DESENVOLVIMENTO (financeiro). Dados FICTÍCIOS. Nunca rodar em produção.
-- Contas bancárias, fornecedores, modelo de rateio e alguns títulos para exercitar baixa e conciliação.
-- =====================================================================

insert into fin.bank_accounts (id, org_id, legal_entity_id, store_id, name, kind, bank_code, agency, number, chart_account_id, opening_balance, opening_date)
select x.id::uuid, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', x.store::uuid, x.name, x.kind, x.bank, x.agency, x.num,
       (select id from fin.chart_accounts where org_id = '00000000-0000-4000-8000-000000000001' and code = x.acc), x.opening::numeric, '2026-09-01'
from (values
  ('00000000-0000-4000-8000-000000000701', null,                                   'Inter — conta PJ (dev)',        'CHECKING',         '077', '0001', '1234567-8', '1.1.1.02', '0'),
  ('00000000-0000-4000-8000-000000000702', null,                                   'BTG Pactual Empresas (dev)',    'CHECKING',         '208', '0050', '7654321-0', '1.1.1.03', '0'),
  ('00000000-0000-4000-8000-000000000703', null,                                   'Mercado Pago (dev)',            'CHECKING',         '323', '0001', '99887766-1', '1.1.1.04', '0'),
  ('00000000-0000-4000-8000-000000000704', '00000000-0000-4000-8000-0000000000a1', 'Caixa da loja piloto (gaveta)',    'CASH_DRAWER',      null,  null,   null,        '1.1.1.01', '0'),
  ('00000000-0000-4000-8000-000000000705', null,                                   'Saldo na adquirente (Stone)',   'ACQUIRER_BALANCE', null,  null,   null,        '1.1.1.05', '0')
) as x(id, store, name, kind, bank, agency, num, acc, opening)
on conflict (id) do nothing;

-- Aporte inicial de capital (dev) para o saldo do Inter
insert into fin.journal_entries (id, org_id, legal_entity_id, number, entry_date, kind, description)
values ('00000000-0000-4000-8000-000000000f01', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1',
        'LAN-SEED-000001', '2026-09-01', 'MANUAL', 'Integralização de capital (dev)')
on conflict (id) do nothing;
insert into fin.journal_lines (entry_id, org_id, line_no, account_id, debit, credit)
select '00000000-0000-4000-8000-000000000f01', '00000000-0000-4000-8000-000000000001', x.n,
       (select id from fin.chart_accounts where org_id = '00000000-0000-4000-8000-000000000001' and code = x.code), x.d, x.c
from (values (1, '1.1.1.02', 50000, 0), (2, '3.1.01', 0, 50000)) as x(n, code, d, c)
where not exists (select 1 from fin.journal_lines where entry_id = '00000000-0000-4000-8000-000000000f01');
insert into fin.cash_transactions (id, org_id, legal_entity_id, bank_account_id, occurred_on, amount, kind, chart_account_id, description, reconciled, reconciled_amount, journal_entry_id)
values ('00000000-0000-4000-8000-000000000f11', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1',
        '00000000-0000-4000-8000-000000000701', '2026-09-01', 50000, 'OWNER_CONTRIBUTION',
        (select id from fin.chart_accounts where org_id = '00000000-0000-4000-8000-000000000001' and code = '3.1.01'),
        'Integralização de capital (dev)', true, 50000, '00000000-0000-4000-8000-000000000f01')
on conflict (id) do nothing;

-- Fornecedores (pessoa única com papel SUPPLIER)
insert into crm.parties (id, org_id, kind, display_name, legal_name, cnpj, city, uf, lifecycle_stage) values
  ('00000000-0000-4000-8000-000000000711', '00000000-0000-4000-8000-000000000001', 'COMPANY', 'Confecções Aurora (dev)', 'CONFECCOES AURORA LTDA', '45723174000110', 'Blumenau', 'SC', 'CUSTOMER'),
  ('00000000-0000-4000-8000-000000000712', '00000000-0000-4000-8000-000000000001', 'COMPANY', 'Contabilidade Exemplo (dev)', 'CONTABILIDADE EXEMPLO S/S', '11444777000161', 'Florianópolis', 'SC', 'CUSTOMER'),
  ('00000000-0000-4000-8000-000000000713', '00000000-0000-4000-8000-000000000001', 'COMPANY', 'Agência Meta Ads (dev)', 'AGENCIA DE MIDIA DIGITAL LTDA', '07526557000100', 'São Paulo', 'SP', 'CUSTOMER')
on conflict (id) do nothing;
insert into crm.party_roles (party_id, org_id, role)
select id, org_id, 'SUPPLIER' from crm.parties where id in
  ('00000000-0000-4000-8000-000000000711', '00000000-0000-4000-8000-000000000712', '00000000-0000-4000-8000-000000000713')
on conflict do nothing;

-- Modelo de rateio: mídia paga 80% digital / 20% balcão
insert into fin.allocation_templates (id, org_id, name, description) values
  ('00000000-0000-4000-8000-000000000721', '00000000-0000-4000-8000-000000000001', 'Mídia paga 80/20', 'Meta Ads: 80% Piloto Digital, 20% Piloto Balcão')
on conflict (id) do nothing;
insert into fin.allocation_template_lines (org_id, template_id, cost_center_id, pct)
select '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000721', x.cc::uuid, x.pct
from (values ('00000000-0000-4000-8000-0000000000c4', 80), ('00000000-0000-4000-8000-0000000000c3', 20)) as x(cc, pct)
where not exists (select 1 from fin.allocation_template_lines where template_id = '00000000-0000-4000-8000-000000000721');

-- Regras de classificação do extrato (tarifas, IOF, rendimentos)
insert into fin.recon_rules (org_id, name, pattern, direction, action_kind, priority)
select '00000000-0000-4000-8000-000000000001', x.name, x.pattern, x.dir, x.kind, x.prio
from (values
  ('Tarifas bancárias', 'tarifa|tar\.? ?(pix|ted|doc)|manutencao de conta', 'OUT', 'BANK_FEE', 10),
  ('Rendimentos de aplicação', 'rendimento|rend\.? ?aplic', 'IN', 'INTEREST_INCOME', 20)
) as x(name, pattern, dir, kind, prio)
where not exists (select 1 from fin.recon_rules where org_id = '00000000-0000-4000-8000-000000000001');
