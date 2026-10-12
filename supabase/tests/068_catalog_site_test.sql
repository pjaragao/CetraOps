begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

select ok(not has_function_privilege('authenticated', 'catalog.upsert_site_product(jsonb)', 'execute'), 'gravar produto do site é só do worker');
select ok(not has_function_privilege('authenticated', 'catalog.apply_site_prices(uuid, jsonb, text)', 'execute'), 'mudar preço pelo site é só do worker');
select is((select count(*)::int from cron.job where jobname in ('centralops-catalog-site-full', 'centralops-catalog-site-prices')), 2, 'rotinas agendadas (completa e preços)');

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (sem catalog.write)
select throws_ok($$ select catalog.request_site_sync('FULL') $$, '42501', null, 'vendedora não dispara a sincronização');
reset role;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select lives_ok($$ select catalog.request_site_sync('PRICES') $$, 'quem cuida do catálogo pede a atualização de preços');
reset role;
select ok((select count(*) from pgmq.q_catalog_sync where message ->> 'kind' = 'PRICES') >= 1, 'e o pedido vai para a fila do worker');

select is(private.category_for('00000000-0000-4000-8000-000000000001', 'calça  de teste'), private.category_for('00000000-0000-4000-8000-000000000001', 'Calça de Teste'), 'mesma categoria, sem diferenciar maiúsculas nem espaços');
select throws_ok($$ insert into catalog.categories (org_id, name) values ('00000000-0000-4000-8000-000000000001', 'CALÇA DE TESTE') $$, '23505', null, 'o banco não aceita categoria repetida');

select * from finish();
rollback;
