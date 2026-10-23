begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
create temp table kv (k text primary key, v jsonb);
grant all on kv to authenticated;

-- ---------- Preparação (dono do banco): 3 pedidos pagos (2 no PDV, 1 no WhatsApp) e 1 cancelado ----------
insert into sales.orders (id, org_id, legal_entity_id, store_id, location_id, number, channel, status, subtotal, discount_total, total, cost_total, idempotency_key, created_at) values
  ('00000000-0000-4000-8000-0000000076a1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'R-1', 'POS', 'PAID', 220, 20, 200, 80, 'r-1', '2026-09-10 15:00-03'),
  ('00000000-0000-4000-8000-0000000076a2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'R-2', 'POS', 'COMPLETED', 100, 0, 100, 40, 'r-2', '2026-09-11 10:00-03'),
  ('00000000-0000-4000-8000-0000000076a3', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'R-3', 'WHATSAPP', 'PAID', 300, 0, 300, 100, 'r-3', '2026-10-02 18:00-03'),
  ('00000000-0000-4000-8000-0000000076a4', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'R-4', 'POS', 'CANCELLED', 999, 0, 999, 1, 'r-4', '2026-09-12 10:00-03');

-- ---------- Sócio ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select ok(jsonb_array_length(core.report_catalog()) >= 7, 'o sócio vê todas as fontes de dados');
select ok(not (core.report_catalog()::text like '%sql%'), 'o catálogo não expõe as expressões SQL');

insert into kv values ('canal', core.report_run('{"dataset":"pedidos","dimensions":["canal"],"measures":["pedidos","receita","margem_pct"]}', '2026-09-01', '2026-10-31'));
select is(jsonb_array_length((select v -> 'rows' from kv where k = 'canal')), 2, 'agrupa por canal (o pedido cancelado não entra)');
select is((select v #>> '{rows,0,canal}' from kv where k = 'canal'), 'Loja (PDV)', 'ordena pelo 1º valor (pedidos), do maior para o menor');
select is((select (v #>> '{rows,0,receita}')::numeric from kv where k = 'canal'), 300::numeric, 'PDV soma 200 + 100');
select is((select (v #>> '{rows,0,margem_pct}')::numeric from kv where k = 'canal'), 60.0, 'margem % do PDV = 180/300');
select is((select v #>> '{columns,0,label}' from kv where k = 'canal'), 'Canal', 'as colunas vêm com o rótulo em português');

select is((core.report_run('{"dataset":"pedidos","dimensions":["mes"],"measures":["receita"]}', '2026-09-01', '2026-10-31') #>> '{rows,0,mes}'), '2026-09',
          'agrupado por mês, a data vem em ordem');
select is((core.report_run('{"dataset":"pedidos","measures":["pedidos"]}', '2026-09-01', '2026-09-30') #>> '{rows,0,pedidos}'), '2', 'o período filtra a data do pedido');
select is((core.report_run('{"dataset":"pedidos","measures":["pedidos"],"use_period":false}', '2026-09-01', '2026-09-30') #>> '{rows,0,pedidos}'), '3',
          'use_period=false ignora o período');
select is((core.report_run('{"dataset":"pedidos","measures":["pedidos"],"filters":[{"field":"canal","op":"eq","value":"loja (pdv)"}]}', '2026-09-01', '2026-10-31') #>> '{rows,0,pedidos}'), '2',
          'filtro de texto sem diferenciar maiúsculas');
select is(jsonb_array_length(core.report_run('{"dataset":"pedidos","dimensions":["pedido"],"measures":["receita"],"filters":[{"field":"receita","op":"gte","value":"200"}]}', '2026-09-01', '2026-10-31') -> 'rows'), 2,
          'filtro em valor vira HAVING (pedidos de 200 ou mais)');
select is(core.report_run('{"dataset":"pedidos","dimensions":["pedido"],"measures":["receita"],"limit":1}', '2026-09-01', '2026-10-31') -> 'truncated', 'true'::jsonb,
          'avisa quando o limite de linhas corta o resultado');
select is(core.report_run('{"dataset":"pedidos","dimensions":["canal"],"filters":[{"field":"canal","op":"eq","value":"x'' or 1=1 --"}]}', '2026-09-01', '2026-10-31') -> 'rows', '[]'::jsonb,
          'o valor do filtro é literal, nunca SQL');

select throws_ok($$ select core.report_run('{"dataset":"pedidos","measures":["sum(1)"]}') $$, 'P0280', null, 'campo fora do catálogo é recusado');
select throws_ok($$ select core.report_run('{"dataset":"pedidos","dimensions":["canal"],"filters":[{"field":"receita","op":"gt","value":"1; select 1"}]}') $$, 'P0280', null,
                 'número inválido no filtro é recusado');
select throws_ok($$ select core.report_run('{"dataset":"pedidos","dimensions":["canal"],"sort":{"field":"o.total"}}') $$, 'P0280', null, 'só ordena por campo do relatório');

insert into kv values ('id', to_jsonb(core.report_save('{"title":"Receita por canal","spec":{"dataset":"pedidos","dimensions":["canal"],"measures":["receita"],"x":"lixo"},"prompt":"receita por canal"}')));
select is((select spec from core.saved_reports where id = (select (v #>> '{}')::uuid from kv where k = 'id')), '{"dataset":"pedidos","dimensions":["canal"],"measures":["receita"]}'::jsonb,
          'salva só as chaves conhecidas do relatório');
select throws_ok($$ select core.report_save('{"title":"Quebrado","spec":{"dataset":"pedidos","measures":["nada"]}}') $$, 'P0280', null, 'não salva relatório que não roda');

-- ---------- Vendedora: sem financeiro; não mexe no relatório do sócio ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select ok(not (core.report_catalog() @> '[{"key":"contas"}]'), 'a vendedora não vê a fonte do financeiro');
select throws_ok($$ select core.report_run('{"dataset":"contas","measures":["valor"]}') $$, '42501', null, 'nem consegue rodar o financeiro');
select throws_ok(format($$ select core.report_archive(%L) $$, (select v #>> '{}' from kv where k = 'id')), 'P0281', null, 'só quem criou (ou o admin) exclui o relatório');

select * from finish();
rollback;
