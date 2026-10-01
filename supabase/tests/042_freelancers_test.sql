begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

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
create temp table ids (k text primary key, v jsonb);
grant all on ids to authenticated;

select ok(private.valid_cnpj('11222333000181'), 'CNPJ de teste é válido');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora: sem hr.write/fin.write
select throws_ok($$ select hr.engage_freelancer('{}') $$, '42501', null, 'vendedora não contrata freelancer');

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select hr.engage_freelancer('{"legal_entity_id":"00000000-0000-4000-8000-0000000000e1","kind":"PJ","name":"Ana Foto","cnpj":"11111111111111","service":"Fotos","work_dates":["2030-05-10"],"amount":300}') $$, 'P0380', null, 'CNPJ inválido é recusado');
select throws_ok($$ select hr.engage_freelancer('{"legal_entity_id":"00000000-0000-4000-8000-0000000000e1","kind":"CLT","name":"Ana Foto","cnpj":"11222333000181","service":"Fotos","work_dates":["2030-05-10"],"amount":300}') $$, 'P0380', null, 'só PJ ou MEI');
select throws_ok($$ select hr.engage_freelancer('{"legal_entity_id":"00000000-0000-4000-8000-0000000000e1","kind":"MEI","name":"Ana Foto","cnpj":"11222333000181","service":"Fotos","work_dates":[],"amount":300}') $$, 'P0380', null, 'precisa de ao menos um dia');
select lives_ok($$ insert into ids select 'j1', hr.engage_freelancer('{"legal_entity_id":"00000000-0000-4000-8000-0000000000e1","store_id":"00000000-0000-4000-8000-0000000000a1","kind":"MEI","name":"Ana Foto MEI","cnpj":"11.222.333/0001-81","service":"Reforço no Drop 02","work_dates":["2030-05-10","2030-05-11"],"amount":600,"phone":"48 99999-0101"}') $$, 'contrata freelancer MEI para dois dias');
select is((select (v ->> 'days_last_90')::int from ids where k = 'j1'), 2, 'conta as diárias');
select ok((select v ->> 'risk' from ids where k = 'j1') is null, 'sem alerta com poucas diárias');
select is((select count(*)::int from crm.parties p join crm.party_roles r on r.party_id = p.id where p.cnpj = '11222333000181' and r.role = 'SERVICE_PROVIDER'), 1, 'cadastro único: prestador com papel próprio');
select is((select t.approval_status || '/' || t.total_amount || '/' || t.document_kind from fin.titles t where t.id = (select (v ->> 'title_id')::uuid from ids where k = 'j1')), 'DRAFT/600.00/NF_MEI', 'conta a pagar em rascunho, aguardando aprovação');
select is((select a.code from fin.titles t join fin.chart_accounts a on a.id = t.chart_account_id where t.id = (select (v ->> 'title_id')::uuid from ids where k = 'j1')), '7.2.09', 'classificada em freelancers');
select is((select count(*)::int from hr.employees e join crm.parties p on p.id = e.party_id where p.cnpj = '11222333000181'), 0, 'não vira colaborador (sem folha nem encargos)');
-- mesmo prestador de novo: soma e alerta
select lives_ok($$ insert into ids select 'j2', hr.engage_freelancer('{"legal_entity_id":"00000000-0000-4000-8000-0000000000e1","kind":"MEI","name":"Ana Foto MEI","cnpj":"11222333000181","service":"Evento","work_dates":["2030-06-01","2030-06-02","2030-06-03","2030-06-04"],"amount":800}') $$, 'chama de novo');
select ok((select v ->> 'risk' from ids where k = 'j2') like 'ATENÇÃO%', 'seis diárias em 90 dias: alerta de risco trabalhista');

select * from finish();
rollback;
