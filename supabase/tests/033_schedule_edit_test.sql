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
insert into ids select 'emp', e.id from hr.employees e
where e.store_id = '00000000-0000-4000-8000-0000000000a1' and e.status = 'ACTIVE' and e.hire_date <= date '2026-11-01' and e.contract_type <> 'PRO_LABORE'
order by e.hire_date limit 1;

-- ---------- Turnos ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora: sem hr.write
select throws_ok($$ select hr.save_shift_template('{"code":"T1","start_time":"09:00","end_time":"15:00","break_minutes":15}') $$, '42501', null, 'vendedora não cria turno');

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
select lives_ok($$ insert into ids select 'sh', (hr.save_shift_template('{"code":"t1","name":"Manhã curta","start_time":"09:00","end_time":"15:00","break_minutes":15,"color":"#336699"}')).id $$, 'sócio cria turno');
select is((select code || '|' || name || '|' || break_minutes from hr.shift_templates where id = (select v from ids where k = 'sh')), 'T1|Manhã curta|15', 'sigla em maiúsculas, nome e intervalo gravados');
select throws_ok($$ select hr.save_shift_template('{"code":"T1","start_time":"10:00","end_time":"16:00"}') $$, 'P0290', null, 'sigla repetida é recusada');
select throws_ok($$ select hr.save_shift_template('{"code":"XX","start_time":"10:00","end_time":"10:00"}') $$, 'P0290', null, 'início igual ao fim é recusado');
select throws_ok($$ select hr.save_shift_template('{"code":"XX","start_time":"10:00","end_time":"11:00","break_minutes":60}') $$, 'P0290', null, 'intervalo maior que a jornada é recusado');
select throws_ok($$ select hr.save_shift_template('{"code":"TOOLONG","start_time":"10:00","end_time":"16:00"}') $$, 'P0290', null, 'sigla com mais de 4 caracteres é recusada');
select lives_ok($$ select hr.save_shift_template('{"code":"NT","start_time":"22:00","end_time":"02:00","break_minutes":0}') $$, 'turno que vira a meia-noite é aceito');

-- célula em rascunho com o turno acompanha a mudança de horário; a publicada não
select lives_ok($$ select hr.set_roster_cell((select v from ids where k = 'emp'), date '2030-03-04', 'WORK', (select v from ids where k = 'sh')) $$, 'escala com o turno novo (rascunho)');
select lives_ok($$ select hr.set_roster_cell((select v from ids where k = 'emp'), date '2030-03-05', 'WORK', (select v from ids where k = 'sh')) $$, 'segundo dia com o turno novo');
update hr.roster set status = 'PUBLISHED' where employee_id = (select v from ids where k = 'emp') and work_date = date '2030-03-05';
select lives_ok($$ select hr.save_shift_template(jsonb_build_object('id', (select v from ids where k = 'sh'), 'code', 'T1', 'name', 'Manhã curta', 'start_time', '08:30', 'end_time', '14:30', 'break_minutes', 15)) $$, 'edita o horário do turno');
select is((select to_char(start_time, 'HH24:MI') from hr.roster where employee_id = (select v from ids where k = 'emp') and work_date = date '2030-03-04'), '08:30', 'rascunho segue o novo horário');
select is((select to_char(start_time, 'HH24:MI') from hr.roster where employee_id = (select v from ids where k = 'emp') and work_date = date '2030-03-05'), '09:00', 'escala publicada não muda');
select throws_ok($$ select hr.delete_shift_template((select v from ids where k = 'sh')) $$, 'P0291', null, 'turno já usado não se exclui');
select lives_ok($$ select hr.delete_shift_template((select id from hr.shift_templates where code = 'NT')) $$, 'turno nunca usado se exclui');
select lives_ok($$ select hr.set_shift_active((select v from ids where k = 'sh'), false) $$, 'desativa o turno');
select throws_ok($$ select hr.set_roster_cell((select v from ids where k = 'emp'), date '2030-03-06', 'WORK', (select v from ids where k = 'sh')) $$, null, null, 'turno desativado não entra mais na escala');

-- ---------- Horário livre ----------
select is((select to_char(start_time, 'HH24:MI') || '-' || to_char(end_time, 'HH24:MI') || '/' || break_minutes || '/' || coalesce(notes, '')
           from hr.set_roster_hours((select v from ids where k = 'emp'), date '2030-03-07', '10:15', '16:45', 30, 'cobre inventário')),
          '10:15-16:45/30/cobre inventário', 'horário livre num dia, com observação');
select is((select shift_id from hr.roster where employee_id = (select v from ids where k = 'emp') and work_date = date '2030-03-07'), null::uuid, 'horário livre não depende de turno');
select throws_ok($$ select hr.set_roster_hours((select v from ids where k = 'emp'), date '2030-03-08', '10:00', '10:30', 60) $$, 'P0290', null, 'horário livre também é conferido');

-- ---------- Cobertura ----------
select is(hr.save_coverage_rule('{"store_id":"00000000-0000-4000-8000-0000000000a1","weekdays":[6],"label":"Pico de sábado","start_time":"08:00","end_time":"11:00","min_staff":2}'), 1, 'cria a janela de pico do sábado');
select throws_ok($$ select hr.save_coverage_rule('{"store_id":"00000000-0000-4000-8000-0000000000a1","weekdays":[1],"label":"Errada","start_time":"11:00","end_time":"08:00"}') $$, 'P0290', null, 'janela com fim antes do início é recusada');

select * from finish();
rollback;
