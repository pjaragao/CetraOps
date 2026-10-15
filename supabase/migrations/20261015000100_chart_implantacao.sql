-- Plano de contas para a implantação: taxas, jurídico, pré-operacionais, telefonia,
-- escritório, manutenção, seguros, expositores e reembolsos a pagar.
-- Só cria contas (não altera nem apaga as existentes) e reclassifica itens de reembolso ainda SUBMITTED.

insert into fin.chart_accounts (org_id, parent_id, code, name, kind, nature, "group", dre_line_id, cash_flow_group)
select a.org_id, a.parent_id, v.code, v.name, a.kind, a.nature, a."group", a.dre_line_id, a.cash_flow_group
from fin.chart_accounts a
join (values
  ('7.2.99',   '7.2.10',   'Taxas, licenças e registros (DARE, Junta, alvará, Bombeiros, vigilância sanitária, certidões, IPTU)'),
  ('7.2.99',   '7.2.11',   'Serviços jurídicos e despachante (contratos, advogada, cartório, registros)'),
  ('7.2.99',   '7.2.12',   'Despesas de implantação / pré-operacionais (gastos não recorrentes para abrir a loja)'),
  ('7.2.99',   '7.2.13',   'Telefonia e dados móveis'),
  ('7.2.99',   '7.2.14',   'Material de escritório, uso e consumo'),
  ('7.2.99',   '7.2.15',   'Manutenção e reparos'),
  ('7.2.99',   '7.2.16',   'Seguros'),
  ('1.2.1.03', '1.2.1.04', 'Expositores, manequins e cabides (itens reutilizáveis de exposição)'),
  ('2.1.7.01', '2.1.8.01', 'Reembolsos a pagar a sócios e colaboradores')
) as v(sibling, code, name) on a.code = v.sibling
where not exists (
  select 1 from fin.chart_accounts x where x.org_id = a.org_id and x.code = v.code
);

-- Reclassificação dos reembolsos já lançados (ainda não aprovados).
update fin.reimbursement_items i
set chart_account_id = c.id
from fin.reimbursements r
join (values
  ('REE-2026-0001', '7.2.10'),
  ('REE-2026-0005', '1.2.1.04'),
  ('REE-2026-0006', '1.2.1.04'),
  ('REE-2026-0007', '1.2.1.04')
) as m(number, code) on m.number = r.number
join fin.chart_accounts c on c.code = m.code and c.org_id = r.org_id
where i.reimbursement_id = r.id
  and r.status in ('DRAFT', 'SUBMITTED');
