begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

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
create temp table kv (k text primary key, v jsonb);
grant all on kv to authenticated;

-- uma conta que vence hoje e uma vencida (sócio lança)
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select fin.create_title(jsonb_build_object('direction', 'PAYABLE', 'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'description', 'Luz (teste do resumo)',
  'installments', jsonb_build_array(jsonb_build_object('due_date', private.today_sp(), 'amount', 320))));
select fin.create_title(jsonb_build_object('direction', 'PAYABLE', 'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'description', 'Aluguel atrasado (teste)',
  'installments', jsonb_build_array(jsonb_build_object('due_date', private.today_sp() - 2, 'amount', 1000))));
insert into kv select 'socio', ai.daily_briefing();
select is((select (v ->> 'date')::date from kv where k = 'socio'), private.today_sp(), 'resumo do dia de São Paulo');
select ok((select jsonb_path_exists(v, '$.items[*] ? (@.key == "vendas_ontem")') from kv where k = 'socio'), 'vendas de ontem para quem vê vendas');
select ok((select (x ->> 'amount')::numeric >= 320 and (x ->> 'count')::int >= 1 from kv, jsonb_array_elements(v -> 'items') x where k = 'socio' and x ->> 'key' = 'pagar_hoje'), 'contas que vencem hoje, com o total');
select ok((select (x ->> 'amount')::numeric >= 1000 from kv, jsonb_array_elements(v -> 'items') x where k = 'socio' and x ->> 'key' = 'pagar_vencidas'), 'contas vencidas separadas');
select ok((select jsonb_path_exists(v, '$.items[*] ? (@.key == "sem_aprovacao")') from kv where k = 'socio'), 'contas sem aprovação perto do vencimento');

-- a vendedora não vê o financeiro: o resumo dela não traz contas
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
insert into kv select 'vend', ai.daily_briefing();
select ok((select not jsonb_path_exists(v, '$.items[*] ? (@.key like_regex "^pagar")') from kv where k = 'vend'), 'resumo da vendedora sem o financeiro');

-- aviso das 08:00: uma notificação por pessoa, uma vez por dia
reset role;
select ok(private.notify_daily_briefing() > 0, 'avisa quem usa a Central');
select is(private.notify_daily_briefing(), 0, 'não repete no mesmo dia');

select * from finish();
rollback;
