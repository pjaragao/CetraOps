begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

-- Nenhuma função dos schemas expostos pode ter EXECUTE para PUBLIC (o padrão do PostgreSQL) nem ACL nula (= padrão)
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('core', 'crm', 'catalog', 'inv', 'sales', 'fin', 'fiscal', 'omni', 'ai', 'hr', 'comm', 'purch')
             and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))), 0,
          'nenhuma função dos schemas expostos executável por PUBLIC (rode private.lock_functions() ao final da migration)');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('core', 'crm', 'catalog', 'inv', 'sales', 'fin', 'fiscal', 'omni', 'ai', 'hr', 'comm', 'purch')
             and has_function_privilege('anon', p.oid, 'execute')), 0, 'anon não executa nenhuma função');

-- Internas: só service_role
select is(has_function_privilege('authenticated', 'sales.finalize_order(uuid)', 'execute'), false, 'usuário não finaliza pedido direto');
select is(has_function_privilege('authenticated', 'core.next_number(uuid,text)', 'execute'), false, 'usuário não mexe na numeração');
select is(has_function_privilege('authenticated', 'crm.resolve_identity(uuid,crm.contact_type,text,text,text)', 'execute'), false, 'usuário não resolve identidade direto');
select is(has_function_privilege('authenticated', 'sales.expire_pending_orders()', 'execute'), false, 'jobs de expiração só para o servidor');
select is(has_function_privilege('service_role', 'sales.finalize_order(uuid)', 'execute'), true, 'service_role continua executando');

-- RPCs de tela continuam disponíveis
select is(has_function_privilege('authenticated', 'sales.create_pos_order(jsonb)', 'execute'), true, 'PDV continua funcionando');
select is(has_function_privilege('authenticated', 'purch.import_nfe(text,uuid,uuid)', 'execute'), true, 'importação de NF-e continua disponível');
select is(has_function_privilege('authenticated', 'fin.settle(jsonb)', 'execute'), true, 'baixa continua disponível');

-- Chamada direta a função interna é negada de fato
create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select sales.finalize_order('00000000-0000-4000-8000-000000000000') $$, '42501', null, 'chamada direta a finalize_order é negada');
select throws_ok($$ select core.next_number('00000000-0000-4000-8000-000000000001', 'HACK') $$, '42501', null, 'chamada direta a next_number é negada');

select * from finish();
rollback;
