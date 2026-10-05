begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
create temp table ids (k text primary key, v text);
grant all on ids to authenticated;

insert into ids select 'ent', id::text from core.legal_entities order by cnpj limit 1;

-- ---------- Gravação pelo servidor ----------
select is(fiscal.dfe_upsert('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'ent')::uuid,
  '[{"access_key":"35260912345678000190550010000009991000009990","nsu":"5","issuer_cnpj":"12345678000190","issuer_name":"Fornecedor A","amount":250.00,"issue_at":"2026-09-10T10:00:00-03:00"},
    {"access_key":"curta","nsu":"6"}]'::jsonb), 1, 'só a nota com chave de 44 dígitos entra');
select is(fiscal.dfe_upsert('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'ent')::uuid,
  '[{"access_key":"35260912345678000190550010000009991000009990","nsu":"5","issuer_name":"Fornecedor A","amount":250.00}]'::jsonb), 0, 'a mesma nota de novo não duplica nem avisa');
select ok(exists (select 1 from core.notifications where kind = 'DFE' and title like '1 nota(s) nova(s)%'), 'a equipe fiscal é avisada das notas novas');
insert into ids select 'dfe', id::text from fiscal.inbound_dfe where access_key = '35260912345678000190550010000009991000009990';
select fiscal.dfe_set_state('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'ent')::uuid, 5, 1, null);
select fiscal.dfe_set_state('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'ent')::uuid, 3, 0, null);
select is((select last_version from fiscal.dfe_sync_state where legal_entity_id = (select v from ids where k = 'ent')::uuid), 5::bigint, 'o cursor nunca anda para trás');

-- ---------- Permissões ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora: sem permissão fiscal
select throws_ok($$ select fiscal.request_manifest((select v from ids where k = 'dfe')::uuid, 'CIENCIA') $$, '42501', null, 'quem não é do fiscal não manifesta');
select throws_ok($$ select fiscal.request_dfe_sync() $$, '42501', null, 'nem pede a busca');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio

-- ---------- Manifestação ----------
select throws_ok($$ select fiscal.request_manifest((select v from ids where k = 'dfe')::uuid, 'TALVEZ') $$, 'P0250', null, 'tipo inválido');
select throws_ok($$ select fiscal.request_manifest((select v from ids where k = 'dfe')::uuid, 'DESCONHECIDA', 'curto') $$, 'P0250', null, 'desconhecimento exige justificativa de 15 a 255 caracteres');
select throws_ok($$ select fiscal.request_manifest('00000000-0000-4000-8000-0000000000ee', 'CIENCIA') $$, 'P0252', null, 'nota inexistente');
select is((fiscal.request_manifest((select v from ids where k = 'dfe')::uuid, 'CIENCIA')).manifest_requested, 'CIENCIA', 'ciência pedida');
reset role;
select is((select count(*)::int from pgmq.q_fiscal_emission where message ->> 'action' = 'DFE_MANIFEST' and message ->> 'dfe_id' = (select v from ids where k = 'dfe')), 1, 'o worker recebe o pedido');
select fiscal.dfe_mark((select v from ids where k = 'dfe')::uuid, 'CIENCIA', null, '<xml/>');
select ok((select xml = '<xml/>' and xml_downloaded and manifest_status = 'CIENCIA' from fiscal.inbound_dfe where id = (select v from ids where k = 'dfe')::uuid), 'o worker grava a situação e o XML');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select fiscal.request_manifest((select v from ids where k = 'dfe')::uuid, 'CIENCIA') $$, 'P0251', null, 'a ciência já foi registrada');
select is((fiscal.request_manifest((select v from ids where k = 'dfe')::uuid, 'CONFIRMADA')).manifest_requested, 'CONFIRMADA', 'depois da ciência, vale a confirmação');
reset role;
select fiscal.dfe_mark((select v from ids where k = 'dfe')::uuid, 'CONFIRMADA');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select fiscal.request_manifest((select v from ids where k = 'dfe')::uuid, 'DESCONHECIDA', 'Mudei de ideia sobre esta nota fiscal') $$, 'P0251', null, 'manifestação conclusiva não muda');

-- ---------- Varredura agendada ----------
reset role;
select is((select count(*)::int from cron.job where jobname = 'centralops-dfe-sync'), 1, 'varredura agendada a cada 2 horas');
select ok(not has_function_privilege('authenticated', 'fiscal.dfe_upsert(uuid,uuid,jsonb)', 'execute') and has_function_privilege('authenticated', 'fiscal.request_manifest(uuid,text,text)', 'execute'), 'privilégios');

select * from finish();
rollback;
