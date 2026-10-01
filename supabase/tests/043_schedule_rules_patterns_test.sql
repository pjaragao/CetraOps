begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

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
insert into ids select 'emp', e.id from hr.employees e where e.store_id = '00000000-0000-4000-8000-0000000000a1' and e.status = 'ACTIVE' and e.contract_type <> 'PRO_LABORE' order by e.hire_date limit 1;
-- um mês distante e vazio
delete from hr.roster where work_date >= date '2031-03-01' and work_date < date '2031-05-01';

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
-- ---------- Regras ----------
select is((hr.schedule_rules() ->> 'min_break_minutes')::int, 60, 'padrão: intervalo mínimo de 60 min');
select throws_ok($$ select hr.save_schedule_rules('{"qualquer":true}') $$, 'P0290', null, 'regra desconhecida é recusada');
select throws_ok($$ select hr.save_schedule_rules('{"rest_11h":"sim"}') $$, 'P0290', null, 'liga/desliga precisa ser verdadeiro ou falso');
select throws_ok($$ select hr.save_schedule_rules('{"daily_warn_minutes":600,"daily_error_minutes":500}') $$, 'P0290', null, 'limite de erro menor que o de alerta é recusado');
-- turno sem o intervalo mínimo
select throws_ok($$ select hr.save_shift_template('{"code":"Q1","start_time":"09:00","end_time":"16:00","break_minutes":30}') $$, 'P0290', null, 'turno de 7h com 30 min de intervalo viola o mínimo');
select lives_ok($$ select hr.save_shift_template('{"code":"Q1","start_time":"09:00","end_time":"16:00","break_minutes":60}') $$, 'com o intervalo mínimo é aceito');
select lives_ok($$ select hr.save_shift_template('{"code":"Q2","start_time":"09:00","end_time":"14:00","break_minutes":0}') $$, 'turno curto (até 6 h) não exige o intervalo longo');
select throws_ok($$ select hr.set_roster_hours((select v from ids where k = 'emp'), date '2031-03-03', '08:00', '16:00', 30) $$, 'P0290', null, 'horário livre também respeita o mínimo');
-- desligando a regra e baixando o mínimo
select lives_ok($$ select hr.save_schedule_rules('{"min_break_minutes":30}') $$, 'sócio baixa o mínimo para 30 min');
select lives_ok($$ select hr.save_shift_template('{"code":"Q3","start_time":"09:00","end_time":"16:00","break_minutes":30}') $$, 'agora 30 min é aceito');
select lives_ok($$ select hr.save_schedule_rules('{"break_rule":false}') $$, 'desliga a regra do intervalo');
select lives_ok($$ select hr.save_shift_template('{"code":"Q4","start_time":"09:00","end_time":"16:00","break_minutes":0}') $$, 'com a regra desligada qualquer intervalo passa');
select hr.save_schedule_rules('{"break_rule":true,"min_break_minutes":60}');

-- ---------- Validação com liga/desliga ----------
select hr.set_roster_hours((select v from ids where k = 'emp'), date '2031-03-04', '08:00', '12:00', 0);                 -- manhã
select hr.set_roster_hours((select v from ids where k = 'emp'), date '2031-03-05', '08:00', '12:00', 0);
select hr.save_schedule_rules('{"coverage":true}');
select ok(exists (select 1 from hr.validate_roster('00000000-0000-4000-8000-0000000000a1', date '2031-03-03', date '2031-03-09') where code = 'COVERAGE'), 'cobertura dos picos ligada: avisa falta de gente');
select hr.save_schedule_rules('{"coverage":false}');
select ok(not exists (select 1 from hr.validate_roster('00000000-0000-4000-8000-0000000000a1', date '2031-03-03', date '2031-03-09') where code = 'COVERAGE'), 'desligada: não avisa');
select hr.save_schedule_rules('{"coverage":true}');
update hr.coverage_rules set active = false where store_id = '00000000-0000-4000-8000-0000000000a1';
select ok(not exists (select 1 from hr.validate_roster('00000000-0000-4000-8000-0000000000a1', date '2031-03-03', date '2031-03-09') where code = 'COVERAGE'), 'picos desligados um a um também não avisam');
update hr.coverage_rules set active = true where store_id = '00000000-0000-4000-8000-0000000000a1';

-- ---------- Escala semanal padrão ----------
select lives_ok($$ select hr.save_weekly_pattern((select v from ids where k = 'emp'),
  jsonb_build_object('1', (select id from hr.shift_templates where code = 'IN'), '2', (select id from hr.shift_templates where code = 'IN'), '3', 'OFF', '0', 'OFF'), false) $$, 'salva o padrão da semana (sem aplicar)');
select throws_ok($$ select hr.save_weekly_pattern((select v from ids where k = 'emp'), '{"1":"não-é-turno"}', false) $$, 'P0290', null, 'turno inválido no padrão');
select hr.save_weekly_pattern((select v from ids where k = 'emp'), jsonb_build_object('1', (select id from hr.shift_templates where code = 'IN'), '2', (select id from hr.shift_templates where code = 'IN'), '3', 'OFF', '0', 'OFF'), false);
delete from hr.roster where employee_id = (select v from ids where k = 'emp') and work_date >= date '2031-03-01' and work_date < date '2031-05-01';
select ok(hr.apply_weekly_patterns('00000000-0000-4000-8000-0000000000a1', date '2031-03-01', date '2031-03-31') >= 8, 'aplica o padrão ao mês (segundas e terças)');
select is((select kind::text || '/' || status from hr.roster where employee_id = (select v from ids where k = 'emp') and work_date = date '2031-03-03'), 'WORK/DRAFT', 'terça: turno em rascunho');
select is((select kind::text from hr.roster where employee_id = (select v from ids where k = 'emp') and work_date = date '2031-03-05'), 'DAY_OFF', 'quarta: folga do padrão');
update hr.roster set status = 'PUBLISHED' where employee_id = (select v from ids where k = 'emp') and work_date = date '2031-03-03';
update hr.shift_templates set start_time = '10:00', end_time = '19:00' where code = 'IN';
select hr.apply_weekly_patterns('00000000-0000-4000-8000-0000000000a1', date '2031-03-01', date '2031-03-31', true);
select is((select to_char(start_time, 'HH24:MI') from hr.roster where employee_id = (select v from ids where k = 'emp') and work_date = date '2031-03-03'), '09:30', 'o publicado nunca muda');
select is((select to_char(start_time, 'HH24:MI') from hr.roster where employee_id = (select v from ids where k = 'emp') and work_date = date '2031-03-04'), '10:00', 'mas os rascunhos seguem o turno editado');

select * from finish();
rollback;
