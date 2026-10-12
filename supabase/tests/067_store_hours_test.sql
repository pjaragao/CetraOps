begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;
create or replace function pg_temp.v(p text) returns uuid language sql as $$ select v from ids where k = p $$;
grant execute on function pg_temp.v(text) to authenticated;

insert into ids values ('store', '00000000-0000-4000-8000-0000000000a1'), ('ch', '00000000-0000-4000-8000-000000000601');
insert into ids select 'emp', e.id from hr.employees e where e.store_id = '00000000-0000-4000-8000-0000000000a1' and e.status = 'ACTIVE' and e.contract_type <> 'PRO_LABORE' order by e.hire_date limit 1;
-- uma segunda-feira qualquer do futuro, sem escala
create temp table dd as select (date '2031-03-03') as mon;   -- 03/03/2031 é segunda
grant select on dd to authenticated;
delete from hr.roster where store_id = pg_temp.v('store') and work_date between (select mon from dd) and (select mon from dd) + 6;
update omni.channel_accounts set business_hours = '{}' where id = pg_temp.v('ch');

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select throws_ok($$ select core.set_store_hours(pg_temp.v('store'), '{"days":{"1":[["10:00","19:00"]]}}') $$, '42501', null, 'só administrador define o horário');
select ok(jsonb_array_length(core.store_calendar(pg_temp.v('store'), (select mon from dd), (select mon from dd) + 6)) = 7, 'a vendedora vê o calendário da loja');
reset role;

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócia
select throws_ok($$ select core.set_store_hours(pg_temp.v('store'), '{"days":{"1":[["19:00","10:00"]]}}') $$, 'P0330', null, 'faixa invertida recusada');
select lives_ok($$ select core.set_store_hours(pg_temp.v('store'), '{"days":{"1":[["10:00","19:00"]],"2":[["10:00","19:00"]],"3":[["10:00","19:00"]],"4":[["10:00","19:00"]],"5":[["10:00","19:00"]],"6":[["09:00","14:00"]]}}') $$, 'grava seg a sáb');
select is((core.store_calendar(pg_temp.v('store'), (select mon from dd), (select mon from dd)) -> 0 -> 'hours')::text, '[["10:00", "19:00"]]', 'segunda abre 10h–19h');
select is(jsonb_array_length(core.store_calendar(pg_temp.v('store'), (select mon from dd) + 6, (select mon from dd) + 6) -> 0 -> 'hours'), 0, 'domingo fechado');

-- exceção: terça fechada (feriado) e quarta horário especial
select lives_ok($$ select core.save_store_hours_exception(jsonb_build_object('store_id', pg_temp.v('store'), 'day', (select mon from dd) + 1, 'closed', true, 'note', 'Feriado')) $$, 'feriado fechado');
select lives_ok($$ select core.save_store_hours_exception(jsonb_build_object('store_id', pg_temp.v('store'), 'day', (select mon from dd) + 2, 'closed', false, 'hours', '[["10:00","22:00"]]'::jsonb, 'note', 'Evento')) $$, 'horário especial');
select is(jsonb_array_length(core.store_calendar(pg_temp.v('store'), (select mon from dd) + 1, (select mon from dd) + 1) -> 0 -> 'hours'), 0, 'feriado vale sobre o horário da semana');
select is((core.store_calendar(pg_temp.v('store'), (select mon from dd) + 2, (select mon from dd) + 2) -> 0 -> 'hours' -> 0 ->> 1), '22:00', 'evento estende até 22h');
select throws_ok($$ select core.save_store_hours_exception(jsonb_build_object('store_id', pg_temp.v('store'), 'day', (select mon from dd) + 3, 'closed', false, 'hours', '[]'::jsonb)) $$, 'P0330', null, 'horário especial sem faixa recusado');
reset role;

-- escala × horário
insert into hr.roster (org_id, employee_id, store_id, work_date, kind, start_time, end_time, break_minutes, status)
values ('00000000-0000-4000-8000-000000000001', pg_temp.v('emp'), pg_temp.v('store'), (select mon from dd), 'WORK', '12:00', '18:00', 30, 'DRAFT'),
       ('00000000-0000-4000-8000-000000000001', pg_temp.v('emp'), pg_temp.v('store'), (select mon from dd) + 1, 'WORK', '10:00', '16:00', 30, 'DRAFT');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((select message from hr.validate_roster(pg_temp.v('store'), (select mon from dd), (select mon from dd)) where code = 'STORE_UNCOVERED'),
  'Loja aberta sem ninguém escalado a partir das 10:00', 'segunda: loja abre às 10h e a primeira pessoa chega às 12h');
select is((select message from hr.validate_roster(pg_temp.v('store'), (select mon from dd) + 1, (select mon from dd) + 1) where code = 'OUTSIDE_STORE_HOURS'),
  'Escalado num dia em que a loja está fechada', 'terça (feriado): escala acusa o dia fechado');
select ok((select count(*) from hr.validate_roster(pg_temp.v('store'), (select mon from dd) + 6, (select mon from dd) + 6) where code = 'STORE_UNCOVERED') = 0, 'domingo fechado não cobra ninguém');
reset role;

-- atendimento: canal sem horário próprio usa o da loja
select is(private.channel_is_open(pg_temp.v('ch'), ((select mon from dd) + time '11:00')::timestamp at time zone 'America/Sao_Paulo'), true, 'canal aberto no horário da loja');
select is(private.channel_is_open(pg_temp.v('ch'), ((select mon from dd) + time '21:00')::timestamp at time zone 'America/Sao_Paulo'), false, 'e fechado depois que a loja fecha');

select * from finish();
rollback;
