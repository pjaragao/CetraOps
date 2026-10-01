-- =====================================================================
-- Seed de DESENVOLVIMENTO (RH). Pessoas e CPFs FICTÍCIOS (CPFs de teste válidos). Nunca rodar em produção.
-- =====================================================================

insert into hr.shift_templates (org_id, code, name, start_time, end_time, break_minutes, color) values
  ('00000000-0000-4000-8000-000000000001', 'AB', 'Abertura',       '06:45', '15:00', 60, '#c98a4b'),
  ('00000000-0000-4000-8000-000000000001', 'IN', 'Intermediário',   '09:30', '18:30', 60, '#5b8a72'),
  ('00000000-0000-4000-8000-000000000001', 'FE', 'Fechamento',      '12:45', '21:15', 60, '#7a6aa8'),
  ('00000000-0000-4000-8000-000000000001', 'SB', 'Sábado',          '07:45', '14:15', 15, '#b0607a')
on conflict (org_id, code) do nothing;

-- Picos da loja na academia: 07:00–09:30 e 17:30–20:00, de segunda a sexta
insert into hr.coverage_rules (org_id, store_id, weekday, label, start_time, end_time, min_staff)
select '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', w, x.label, x.s::time, x.e::time, 2
from generate_series(1, 5) w, (values ('Pico da manhã', '07:00', '09:30'), ('Pico da tarde', '17:30', '20:00')) as x(label, s, e)
where not exists (select 1 from hr.coverage_rules where store_id = '00000000-0000-4000-8000-0000000000a1');

select hr.create_employee(jsonb_build_object(
  'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'name', 'Vendedora Teste (dev)', 'cpf', '529.982.247-25', 'birth_date', '1996-05-14', 'phone', '48 99999-0002',
  'contract_type', 'CLT', 'job_title', 'Consultora de moda', 'cbo', '521110', 'hire_date', '2026-08-03', 'salary', 2200,
  'commissioned', true, 'member_id', '00000000-0000-4000-8000-000000000102', 'experience_days', jsonb_build_array(45, 45),
  'pix_key', 'vendedora@sie.test', 'dependents', jsonb_build_array(jsonb_build_object('name', 'Filha Teste', 'birth_date', '2019-03-10', 'irrf', true, 'family_allowance', true))))
where not exists (select 1 from hr.employee_private where cpf = '52998224725');

select hr.create_employee(jsonb_build_object(
  'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'name', 'Gerente Teste (dev)', 'cpf', '111.444.777-35', 'birth_date', '1990-11-02',
  'contract_type', 'CLT', 'job_title', 'Gerente de loja', 'cbo', '141410', 'hire_date', '2026-07-01', 'salary', 4500, 'pix_key', '11144477735'))
where not exists (select 1 from hr.employee_private where cpf = '11144477735');

select hr.create_employee(jsonb_build_object(
  'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'name', 'Auxiliar Teste (dev)', 'cpf', '123.456.789-09', 'birth_date', '2001-01-20',
  'contract_type', 'CLT', 'job_title', 'Auxiliar de loja', 'cbo', '521125', 'hire_date', '2026-09-14', 'salary', 1800, 'pix_key', '12345678909'))
where not exists (select 1 from hr.employee_private where cpf = '12345678909');

select hr.create_employee(jsonb_build_object(
  'legal_entity_id', '00000000-0000-4000-8000-0000000000e1',
  'name', 'Sócio Pró-labore (dev)', 'cpf', '987.654.321-00', 'contract_type', 'PRO_LABORE', 'job_title', 'Sócio-administrador',
  'hire_date', '2026-06-01', 'salary', 4500, 'fgts', false))
where not exists (select 1 from hr.employee_private where cpf = '98765432100');

-- Benefícios: VT (por dia) e VR (por dia) para a equipe; plano de saúde para a gerente
insert into hr.employee_benefits (org_id, employee_id, benefit_type_id, value)
select '00000000-0000-4000-8000-000000000001', e.id, bt.id, x.v
from (values ('529.982.247-25', 'VT', 12.00), ('529.982.247-25', 'VR', 25.00), ('123.456.789-09', 'VT', 12.00), ('123.456.789-09', 'VR', 25.00),
             ('111.444.777-35', 'VR', 25.00), ('111.444.777-35', 'SAUDE', 350.00)) as x(cpf, code, v)
join hr.employee_private ep on ep.cpf = regexp_replace(x.cpf, '\D', '', 'g')
join hr.employees e on e.id = ep.employee_id
join hr.benefit_types bt on bt.org_id = e.org_id and bt.code = x.code
where not exists (select 1 from hr.employee_benefits b where b.employee_id = e.id and b.benefit_type_id = bt.id);
