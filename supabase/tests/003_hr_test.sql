begin;
create extension if not exists pgtap with schema extensions;
select plan(103);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;

-- ---------- Impostos: INSS, IRRF (Lei 15.270), CPF ----------
select is(hr.calc_inss(3000, date '2026-10-01'), 248.60, 'INSS progressivo: R$ 3.000 → 248,60');
select is(hr.calc_inss(5900, date '2026-10-01'), 627.51, 'INSS progressivo: R$ 5.900 → 627,51');
select is(hr.calc_inss(20000, date '2026-10-01'), 988.09, 'INSS limitado ao teto (R$ 988,09)');
select is(hr.calc_inss_prolabore(4500, date '2026-10-01'), 495.00, 'INSS do pró-labore: 11%');
select is(hr.calc_irrf(3000, 248.60, 0, date '2026-10-01'), 0.00, 'IRRF: até R$ 5.000 o redutor zera o imposto');
select is(hr.calc_irrf(6000, 641.51, 0, date '2026-10-01'), 385.10, 'IRRF: R$ 6.000 com redutor da faixa intermediária');
select is(hr.calc_irrf(8000, 921.51, 0, date '2026-10-01'), 1037.85, 'IRRF: acima de R$ 7.350 sem redutor');
select is(hr.calc_irrf(6000, 641.51, 2, date '2026-10-01'), 280.83, 'IRRF: dependentes reduzem a base (2 × R$ 189,59)');
select ok(private.valid_cpf('529.982.247-25') and not private.valid_cpf('111.111.111-11') and not private.valid_cpf('123.456.789-00'), 'validação de CPF');

-- ---------- Admissão (cadastro único + dados sensíveis + salário) ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio

select lives_ok($$ insert into ids select 'e1', (hr.create_employee(jsonb_build_object(
  'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'name', 'Colaboradora Um (teste)', 'cpf', '390.533.447-05', 'contract_type', 'CLT', 'job_title', 'Consultora', 'hire_date', '2025-01-10',
  'salary', 2400, 'dependents', jsonb_build_array(jsonb_build_object('name', 'Filho', 'birth_date', '2018-05-01', 'irrf', true, 'family_allowance', true))))).id $$,
  'admite colaboradora com dependente');
select lives_ok($$ insert into ids select 'e2', (hr.create_employee(jsonb_build_object(
  'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'name', 'Colaborador Dois (teste)', 'cpf', '168.995.350-09', 'contract_type', 'CLT', 'job_title', 'Consultor', 'hire_date', '2025-03-01', 'salary', 2640))).id $$, 'admite colaborador 2');
select lives_ok($$ insert into ids select 'e3', (hr.create_employee(jsonb_build_object(
  'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'name', 'Colaboradora Três (teste)', 'cpf', '453.178.287-91', 'contract_type', 'CLT', 'job_title', 'Coordenadora', 'hire_date', '2025-06-02', 'salary', 6000))).id $$, 'admite colaboradora 3');
select lives_ok($$ insert into ids select 'e4', (hr.create_employee(jsonb_build_object(
  'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'store_id', '00000000-0000-4000-8000-0000000000a1',
  'name', 'Colaboradora Quatro (teste)', 'cpf', '712.345.678-57', 'contract_type', 'CLT', 'job_title', 'Auxiliar', 'hire_date', '2026-08-03', 'salary', 2200))).id $$, 'admite colaboradora 4');
select throws_ok($$ select hr.create_employee(jsonb_build_object('legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'name', 'Repetida', 'cpf', '390.533.447-05',
  'contract_type', 'CLT', 'job_title', 'X', 'hire_date', '2026-01-01', 'salary', 2000)) $$, 'P0061', null, 'CPF repetido é recusado');
select throws_ok($$ select hr.create_employee(jsonb_build_object('legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'name', 'Inválida', 'cpf', '111.111.111-11',
  'contract_type', 'CLT', 'job_title', 'X', 'hire_date', '2026-01-01', 'salary', 2000)) $$, 'P0060', null, 'CPF inválido é recusado');
select is((select count(*)::int from crm.party_roles pr join hr.employees e on e.party_id = pr.party_id where e.id = (select v from ids where k = 'e1') and pr.role = 'EMPLOYEE'), 1,
          'cadastro único: a pessoa ganha o papel EMPLOYEE');
select is((select amount from hr.salary_history where employee_id = (select v from ids where k = 'e1')), 2400.00, 'salário inicial no histórico imutável');
select ok((select count(*) from fiscal.esocial_events where event = 'S-2200' and reference_id = (select v from ids where k = 'e1')) = 1, 'admissão enfileira o evento S-2200 do eSocial');
select ok((select count(*) from hr.vacation_periods where employee_id = (select v from ids where k = 'e1')) >= 1, 'períodos aquisitivos gerados');
select throws_ok($$ update hr.salary_history set amount = 1 $$, '42501', null, 'histórico de salário não aceita UPDATE (só nova vigência)');

-- ---------- Escala: validações da CLT ----------
insert into hr.shift_templates (org_id, code, name, start_time, end_time, break_minutes) values
  ('00000000-0000-4000-8000-000000000001', 'TX1', 'Teste dom', '09:00', '15:00', 60),
  ('00000000-0000-4000-8000-000000000001', 'TX2', 'Teste longo', '08:00', '18:30', 60),
  ('00000000-0000-4000-8000-000000000001', 'TX3', 'Teste noite', '20:00', '23:30', 0);

select lives_ok($$ select hr.set_roster_cell((select v from ids where k = 'e1'), date '2026-10-05', 'WORK', (select id from hr.shift_templates where code = 'FE')) $$, 'escala: fechamento na segunda');
select lives_ok($$ select hr.set_roster_cell((select v from ids where k = 'e1'), date '2026-10-06', 'WORK', (select id from hr.shift_templates where code = 'AB')) $$, 'escala: abertura na terça');
select is((select count(*)::int from hr.validate_roster('00000000-0000-4000-8000-0000000000a1', date '2026-10-05', date '2026-10-11') v where v.code = 'REST_11H'), 1,
          'valida descanso de 11h entre fechar e abrir');
select ok((select count(*) from hr.validate_roster('00000000-0000-4000-8000-0000000000a1', date '2026-10-05', date '2026-10-11') v where v.code = 'COVERAGE') >= 1,
          'alerta de cobertura do pico da manhã (mínimo de 2 pessoas)');
select lives_ok($$ select hr.set_roster_cell((select v from ids where k = 'e1'), d::date, 'WORK', (select id from hr.shift_templates where code = 'IN'))
                   from generate_series(timestamp '2026-10-12', timestamp '2026-10-18', interval '1 day') d $$, 'escala: 7 dias seguidos');
select is((select count(*)::int from hr.validate_roster('00000000-0000-4000-8000-0000000000a1', date '2026-10-12', date '2026-10-18') v where v.code = 'DSR'), 1,
          'valida o 7º dia seguido sem folga');
select throws_ok($$ select hr.publish_roster('00000000-0000-4000-8000-0000000000a1', date '2026-10-05', date '2026-10-18') $$, 'P0047', null,
                 'escala com erros de conformidade não é publicada');
delete from hr.roster where employee_id = (select v from ids where k = 'e1');

-- ---------- Espelho de ponto: extras, adicional noturno, faltas e DSR ----------
select lives_ok($$ select hr.set_roster_cell((select v from ids where k = 'e2'), date '2026-10-04', 'WORK', (select id from hr.shift_templates where code = 'TX1')) $$, 'domingo trabalhado');
select lives_ok($$ select hr.set_roster_cell((select v from ids where k = 'e2'), date '2026-10-06', 'WORK', (select id from hr.shift_templates where code = 'TX2')) $$, 'jornada longa na terça');
select lives_ok($$ select hr.set_roster_cell((select v from ids where k = 'e2'), date '2026-10-07', 'WORK', (select id from hr.shift_templates where code = 'TX3')) $$, 'turno noturno na quarta');
select lives_ok($$ select hr.close_timesheet((select v from ids where k = 'e2'), date '2026-10-01') $$, 'fecha o espelho de outubro');
select is((select ot100_min from hr.timesheets where employee_id = (select v from ids where k = 'e2')), 300, 'domingo: 5h a 100%');
select is((select ot50_min from hr.timesheets where employee_id = (select v from ids where k = 'e2')), 130, 'terça: 2h10 acima da jornada a 50%');
select is((select night_min from hr.timesheets where employee_id = (select v from ids where k = 'e2')), 103, 'noturno: 90 min viram 103 pela hora reduzida de 52''30''');
select lives_ok($$ select hr.add_leave(jsonb_build_object('employee_id', (select v from ids where k = 'e2'), 'kind', 'UNJUSTIFIED_ABSENCE', 'start_date', '2026-10-20', 'end_date', '2026-10-20')) $$, 'registra falta injustificada');
select lives_ok($$ select hr.close_timesheet((select v from ids where k = 'e2'), date '2026-10-01', true) $$, 'refaz o espelho');
select is((select absence_days from hr.timesheets where employee_id = (select v from ids where k = 'e2')), 1, 'falta contada');
select is((select dsr_lost_days from hr.timesheets where employee_id = (select v from ids where k = 'e2')), 1, 'DSR perdido na semana da falta');

-- ---------- Férias ----------
select throws_ok($$ select hr.schedule_vacation(jsonb_build_object('employee_id', (select v from ids where k = 'e1'), 'start_date', '2026-11-06', 'days', 14)) $$,
                 'P0044', null, 'não inicia férias nos 2 dias que antecedem o repouso semanal');
select throws_ok($$ select hr.schedule_vacation(jsonb_build_object('employee_id', (select v from ids where k = 'e1'), 'start_date', '2026-11-09', 'days', 4)) $$,
                 'P0041', null, 'fração mínima de 5 dias');
select lives_ok($$ insert into ids select 'v1', (hr.schedule_vacation(jsonb_build_object('employee_id', (select v from ids where k = 'e1'), 'start_date', '2026-11-09', 'days', 14))).id $$, 'programa 14 dias');
select lives_ok($$ select hr.schedule_vacation(jsonb_build_object('employee_id', (select v from ids where k = 'e1'), 'start_date', '2026-12-07', 'days', 6)) $$, 'programa mais 6 dias');
select throws_ok($$ select hr.schedule_vacation(jsonb_build_object('employee_id', (select v from ids where k = 'e1'), 'start_date', '2026-11-16', 'days', 5)) $$,
                 'P0045', null, 'férias não podem se sobrepor');
select lives_ok($$ select hr.schedule_vacation(jsonb_build_object('employee_id', (select v from ids where k = 'e1'), 'start_date', '2026-12-21', 'days', 10)) $$, 'fecha os 30 dias (uma parte tem 14+)');
select throws_ok($$ select hr.schedule_vacation(jsonb_build_object('employee_id', (select v from ids where k = 'e1'), 'start_date', '2027-01-04', 'days', 5)) $$,
                 'P0040', null, 'sem saldo no período');
select lives_ok($$ select hr.approve_vacation((select v from ids where k = 'v1')) $$, 'aprova as férias');
select throws_ok($$ select hr.set_roster_cell((select v from ids where k = 'e1'), date '2026-11-10', 'WORK', (select id from hr.shift_templates where code = 'IN')) $$,
                 'P0045', null, 'não escala quem está de férias');
select lives_ok($$ insert into ids select 'run_vac', (hr.pay_vacation((select v from ids where k = 'v1'))).id $$, 'gera o recibo de férias');
select is((select l.amount from hr.payslip_lines l join hr.payslips p on p.id = l.payslip_id where p.run_id = (select v from ids where k = 'run_vac') and l.event_code = 'FERIAS'), 1120.00, 'férias: 14 dias de R$ 2.400');
select is((select l.amount from hr.payslip_lines l join hr.payslips p on p.id = l.payslip_id where p.run_id = (select v from ids where k = 'run_vac') and l.event_code = 'FERIAS_1_3'), 373.33, '1/3 constitucional');
select is((select p.net from hr.payslips p where p.run_id = (select v from ids where k = 'run_vac')), 1381.33, 'líquido das férias = bruto − INSS (112,00)');

-- ---------- Provisões (setembro fecha antes das férias; a de outubro alimenta o consumo) ----------
select lives_ok($$ select hr.accrue_provisions('00000000-0000-4000-8000-0000000000e1', date '2026-10-01') $$, 'provisiona 13º, férias e FGTS de outubro');
select is((select sum(amount) from hr.provisions where employee_id = (select v from ids where k = 'e2') and kind = 'THIRTEENTH'), 220.00, 'provisão de 13º = salário/12');
select is((select sum(amount) from hr.provisions where employee_id = (select v from ids where k = 'e2') and kind = 'VACATION'), 293.33, 'provisão de férias + 1/3');
select is((select sum(amount) from hr.provisions where employee_id = (select v from ids where k = 'e2') and kind = 'FGTS'), 41.07, 'FGTS sobre as provisões');
select is((select sum(l.debit) - sum(l.credit) from fin.journal_lines l join fin.journal_entries en on en.id = l.entry_id where en.kind = 'PROVISION' and en.source_type = 'hr.provision_runs'), 0.00,
          'lançamento das provisões fecha');
select throws_ok($$ select hr.accrue_provisions('00000000-0000-4000-8000-0000000000e1', date '2026-10-01') $$, 'P0056', null, 'provisão do mês não duplica');

select lives_ok($$ select hr.approve_run((select v from ids where k = 'run_vac')) $$, 'aprova o recibo de férias');
select is((select status from hr.vacations where id = (select v from ids where k = 'v1')), 'PAID', 'férias marcadas como pagas');
select is(private.provision_balance((select v from ids where k = 'e1'), 'VACATION'), 0.00, 'pagamento das férias consome a provisão do colaborador');
select is((select count(*)::int from fin.titles where origin_type = 'PAYROLL' and origin_id = (select id from hr.payslips where run_id = (select v from ids where k = 'run_vac'))), 1, 'título a pagar das férias no financeiro');

-- ---------- Rescisão sem justa causa (aviso indenizado) ----------
select lives_ok($$ insert into ids select 't4', (hr.create_termination(jsonb_build_object('employee_id', (select v from ids where k = 'e4'), 'kind', 'WITHOUT_CAUSE',
  'notice_kind', 'INDEMNIFIED', 'termination_date', '2026-10-15'))).id $$, 'cria a rescisão');
select is((select l.amount from hr.payslip_lines l join hr.payslips p on p.id = l.payslip_id join hr.terminations t on t.run_id = p.run_id where t.id = (select v from ids where k = 't4') and l.event_code = 'SALDO_SALARIO'), 1100.00, 'saldo de salário: 15 dias');
select is((select l.amount from hr.payslip_lines l join hr.payslips p on p.id = l.payslip_id join hr.terminations t on t.run_id = p.run_id where t.id = (select v from ids where k = 't4') and l.event_code = 'AVISO_INDENIZADO'), 2200.00, 'aviso prévio indenizado: 30 dias');
select is((select l.amount from hr.payslip_lines l join hr.payslips p on p.id = l.payslip_id join hr.terminations t on t.run_id = p.run_id where t.id = (select v from ids where k = 't4') and l.event_code = 'DEC_TERCEIRO_PROP'), 550.00, '13º proporcional com projeção do aviso: 3/12');
select is((select l.amount from hr.payslip_lines l join hr.payslips p on p.id = l.payslip_id join hr.terminations t on t.run_id = p.run_id where t.id = (select v from ids where k = 't4') and l.event_code = 'FERIAS_PROP'), 550.00, 'férias proporcionais: 3/12');
select is((select l.amount from hr.payslip_lines l join hr.payslips p on p.id = l.payslip_id join hr.terminations t on t.run_id = p.run_id where t.id = (select v from ids where k = 't4') and l.event_code = 'FERIAS_PROP_1_3'), 183.33, '1/3 sobre as férias proporcionais');
select is((select l.amount from hr.payslip_lines l join hr.payslips p on p.id = l.payslip_id join hr.terminations t on t.run_id = p.run_id where t.id = (select v from ids where k = 't4') and l.event_code = 'MULTA_FGTS'), 123.20, 'multa de 40% sobre o FGTS rescisório');
select is((select p.inss from hr.payslips p join hr.terminations t on t.run_id = p.run_id where t.id = (select v from ids where k = 't4')), 123.75, 'INSS só sobre saldo (82,50) e 13º (41,25) — aviso e férias indenizados não incidem');
select is((select p.net from hr.payslips p join hr.terminations t on t.run_id = p.run_id where t.id = (select v from ids where k = 't4')), 4459.58, 'líquido da rescisão');
select lives_ok($$ select hr.approve_termination((select v from ids where k = 't4')) $$, 'aprova a rescisão');
select is((select status from hr.employees where id = (select v from ids where k = 'e4')), 'TERMINATED', 'colaborador desligado');
select is(private.provision_balance((select v from ids where k = 'e4'), 'VACATION') + private.provision_balance((select v from ids where k = 'e4'), 'THIRTEENTH') + private.provision_balance((select v from ids where k = 'e4'), 'FGTS'), 0.00,
          'provisões do desligado baixadas');
select is((select i.due_date from fin.title_installments i join fin.titles t on t.id = i.title_id join hr.payslips p on p.id = t.origin_id join hr.terminations tt on tt.run_id = p.run_id
           where tt.id = (select v from ids where k = 't4') and t.document_kind = 'FOLHA'), date '2026-10-25', 'pagamento em 10 dias (art. 477)');
select ok((select count(*) from fiscal.esocial_events where event = 'S-2299' and reference_id = (select v from ids where k = 't4')) = 1, 'evento S-2299 enfileirado');
select is((select count(*)::int from fiscal.obligations o where o.source_type = 'hr.payroll_runs' and o.source_id = (select run_id from hr.terminations where id = (select v from ids where k = 't4')) and o.kind in ('FGTS', 'INSS_DAE')), 2,
          'obrigações de FGTS/GRRF e INSS geradas no calendário fiscal');

-- ---------- Folha mensal ----------
select lives_ok($$ insert into ids select 'run', (hr.create_run(jsonb_build_object('legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'kind', 'MONTHLY', 'competence', '2026-10-01'))).id $$, 'cria a folha de outubro');
select throws_ok($$ select hr.create_run(jsonb_build_object('legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'kind', 'MONTHLY', 'competence', '2026-10-01')) $$, 'P0052', null, 'não duplica a folha do mês');
select lives_ok($$ select hr.calc_run((select v from ids where k = 'run')) $$, 'calcula a folha');
select is((select count(*)::int from hr.payslips where run_id = (select v from ids where k = 'run') and employee_id = (select v from ids where k = 'e4')), 0, 'desligado no mês não entra na folha mensal');

create temp table pl (code text, amt numeric);
grant all on pl to authenticated;
insert into pl select l.event_code, l.amount from hr.payslip_lines l join hr.payslips p on p.id = l.payslip_id where p.run_id = (select v from ids where k = 'run') and p.employee_id = (select v from ids where k = 'e2');
select is((select amt from pl where code = 'HE50'), 39.00, 'horas extras 50%: 2h10 × R$ 12 × 1,5');
select is((select amt from pl where code = 'HE100'), 120.00, 'domingo a 100%: 5h × R$ 12 × 2');
select is((select amt from pl where code = 'ADIC_NOT'), 4.12, 'adicional noturno de 20%');
select is((select amt from pl where code = 'DSR_VAR'), 31.37, 'DSR sobre variáveis: (39 + 120 + 4,12) ÷ 26 dias úteis × 5 repousos');
select is((select amt from pl where code = 'FALTAS'), 88.00, 'falta: 1/30 do salário');
select is((select amt from pl where code = 'DSR_FALTAS'), 88.00, 'DSR perdido: 1/30 do salário');
select is((select amt from pl where code = 'INSS'), 230.79, 'INSS sobre o bruto de R$ 2.834,49');
select is((select p.net from hr.payslips p where p.run_id = (select v from ids where k = 'run') and p.employee_id = (select v from ids where k = 'e2')), 2427.70, 'líquido = 2.834,49 − 230,79 − 88 − 88');
select is((select p.irrf from hr.payslips p where p.run_id = (select v from ids where k = 'run') and p.employee_id = (select v from ids where k = 'e3')), 385.10, 'IRRF do salário de R$ 6.000 com redutor');
select is((select p.inss from hr.payslips p where p.run_id = (select v from ids where k = 'run') and p.employee_id = (select v from ids where k = 'e3')), 641.51, 'INSS do salário de R$ 6.000');

select lives_ok($$ select hr.approve_run((select v from ids where k = 'run')) $$, 'aprova a folha');
select is((select sum(l.debit) - sum(l.credit) from fin.journal_lines l where l.entry_id = (select journal_entry_id from hr.payroll_runs where id = (select v from ids where k = 'run'))), 0.00, 'lançamento contábil da folha fecha');
select is((select count(*)::int from fin.titles t join hr.payslips p on p.id = t.origin_id where t.origin_type = 'PAYROLL' and p.run_id = (select v from ids where k = 'run')), (select count(*)::int from hr.payslips where run_id = (select v from ids where k = 'run') and net > 0),
          'um título a pagar por recibo');
select ok((select count(*) from fiscal.obligations where source_id = (select v from ids where k = 'run') and kind = 'IRRF_DARF') = 1, 'DARF do IRRF no calendário fiscal');
select is((select count(*)::int from fiscal.esocial_events where event = 'S-1200' and reference_id in (select id from hr.payslips where run_id = (select v from ids where k = 'run'))), (select count(*)::int from hr.payslips where run_id = (select v from ids where k = 'run')),
          'S-1200 por recibo');

-- Um único Pix paga a folha de dois colaboradores (rateio na baixa) — recibos viram PAGOS
select lives_ok($$ select fin.settle(jsonb_build_object('bank_account_id', '00000000-0000-4000-8000-000000000701', 'direction', 'PAYABLE', 'method', 'PIX', 'description', 'Pix da folha (2 colaboradores)',
  'lines', (select jsonb_agg(jsonb_build_object('kind', 'PRINCIPAL', 'amount', i.amount, 'installment_id', i.id))
            from fin.title_installments i join fin.titles t on t.id = i.title_id join hr.payslips p on p.id = t.origin_id
            where p.run_id = (select v from ids where k = 'run') and p.employee_id in ((select v from ids where k = 'e2'), (select v from ids where k = 'e3'))))) $$,
  'um movimento no banco quita a folha de dois colaboradores');
select is((select count(*)::int from hr.payslips where run_id = (select v from ids where k = 'run') and status = 'PAID'), 2, 'os dois recibos ficam pagos');
select throws_ok($$ select hr.cancel_run((select v from ids where k = 'run')) $$, 'P0055', null, 'folha com pagamento não pode ser cancelada sem estornar as baixas');

-- ---------- Segurança ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select is((select count(*)::int from hr.employees), 0, 'vendedora não vê o cadastro de colaboradores');
select is((select count(*)::int from hr.salary_history), 0, 'vendedora não vê salários');
select is((select count(*)::int from hr.payslips), 0, 'vendedora não vê holerites');
select throws_ok($$ select hr.create_run(jsonb_build_object('legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'kind', 'MONTHLY', 'competence', '2026-11-01')) $$, '42501', null, 'vendedora não cria folha');
select throws_ok($$ select hr.approve_run(gen_random_uuid()) $$, '42501', null, 'vendedora não aprova folha');

select * from finish();
rollback;
