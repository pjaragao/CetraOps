begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

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
create temp table kv (k text primary key, v text);
grant all on ids, kv to authenticated;

-- chave de NFC-e válida (o último dígito é o verificador)
insert into kv select 'key', b || d from (select '4226107318452900018665001000000123112345678' as b) x, generate_series(0, 9) d where private.valid_nf_key(b || d);
insert into kv values ('acc', (select id::text from fin.chart_accounts where code = '7.2.07' and org_id = '00000000-0000-4000-8000-000000000001'));
select is((select count(*)::int from kv where k = 'key'), 1, 'uma única chave válida para o dígito verificador');
select ok(not private.valid_nf_key('4226107318452900018665001000000123112345670') or (select v from kv where k = 'key') like '%0', 'dígito errado é recusado');

-- ---------- Pedir ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (fin.reimburse)
select throws_ok($$ select fin.save_reimbursement(jsonb_build_object('purpose', 'Almoço', 'items', jsonb_build_array(jsonb_build_object(
  'spent_on', (now() at time zone 'America/Sao_Paulo')::date + 2, 'description', 'Almoço', 'document_kind', 'NFCE', 'amount', 50)))) $$, 'P0450', null, 'despesa no futuro é recusada');
select throws_ok($$ select fin.save_reimbursement(jsonb_build_object('purpose', 'Almoço', 'items', jsonb_build_array(jsonb_build_object(
  'spent_on', (now() at time zone 'America/Sao_Paulo')::date, 'description', 'Almoço', 'document_kind', 'NFCE', 'amount', 50, 'access_key', '4226107318452900018665001000000123112345679')))) $$, 'P0450', null, 'chave de nota inválida é recusada');
select lives_ok($$ insert into ids select 'r', (fin.save_reimbursement(jsonb_build_object('purpose', 'Almoço com fornecedor e material da loja', 'items', jsonb_build_array(
  jsonb_build_object('spent_on', (now() at time zone 'America/Sao_Paulo')::date - 1, 'description', 'Almoço', 'document_kind', 'NFCE', 'amount', 82.5, 'access_key', (select v from kv where k = 'key'), 'supplier_name', 'Restaurante X'),
  jsonb_build_object('spent_on', (now() at time zone 'America/Sao_Paulo')::date, 'description', 'Fita adesiva', 'document_kind', 'RECIBO', 'amount', 17.5, 'chart_account_id', (select v from kv where k = 'acc')))))).id $$, 'cria o reembolso com duas despesas');
select is((select status || '/' || total from fin.reimbursements where id = (select v from ids where k = 'r')), 'DRAFT/100.00', 'rascunho com o total');
select is((select supplier_doc from fin.reimbursement_items where reimbursement_id = (select v from ids where k = 'r') and access_key is not null), '73184529000186', 'CNPJ do fornecedor tirado da chave da nota');
select ok((select number from fin.reimbursements where id = (select v from ids where k = 'r')) like 'REE-%', 'número legível');
select ok((select party_id = (select party_id from core.members where user_id = '00000000-0000-4000-8000-0000000000f2') from fin.reimbursements where id = (select v from ids where k = 'r')), 'reembolso para a pessoa do usuário');
select throws_ok($$ select fin.submit_reimbursement((select v from ids where k = 'r')) $$, 'P0451', null, 'sem comprovante não envia');
select lives_ok($$ select fin.set_reimbursement_attachment((select id from fin.reimbursement_items where reimbursement_id = (select v from ids where k = 'r') and position = 1),
  '00000000-0000-4000-8000-000000000001/reembolsos/teste/nota.jpg', 'nota.jpg') $$, 'anexa a foto da nota');
select throws_ok($$ select fin.set_reimbursement_attachment((select id from fin.reimbursement_items where reimbursement_id = (select v from ids where k = 'r') and position = 1),
  'outra-empresa/nota.jpg', 'nota.jpg') $$, 'P0450', null, 'arquivo fora da pasta da empresa é recusado');
-- segunda despesa sem comprovante: com justificativa
select fin.save_reimbursement(jsonb_build_object('id', (select v from ids where k = 'r'), 'purpose', 'Almoço com fornecedor e material da loja', 'items', (
  select jsonb_agg(jsonb_build_object('id', id, 'spent_on', spent_on, 'description', description, 'document_kind', document_kind, 'amount', amount, 'access_key', access_key,
    'supplier_name', supplier_name, 'chart_account_id', chart_account_id, 'no_document_reason', case when position = 2 then 'Comprado na feira, o vendedor não emite recibo' end) order by position)
  from fin.reimbursement_items where reimbursement_id = (select v from ids where k = 'r'))));
select is((select count(*)::int from fin.reimbursement_items where reimbursement_id = (select v from ids where k = 'r') and attachment_path is not null), 1, 'editar mantém o anexo das despesas');
select lives_ok($$ select fin.submit_reimbursement((select v from ids where k = 'r')) $$, 'envia para aprovação');
reset role;
select ok((select count(*) from core.notifications where kind = 'REIMBURSEMENT_SUBMITTED' and payload ->> 'reimbursement_id' = (select v from ids where k = 'r')::text) > 0, 'quem aprova é avisado');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select fin.decide_reimbursement((select v from ids where k = 'r'), true) $$, '42501', null, 'vendedora não aprova');

-- ---------- Decidir ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
select throws_ok($$ select fin.decide_reimbursement((select v from ids where k = 'r'), false, 'x') $$, 'P0450', null, 'recusa precisa de motivo');
select lives_ok($$ select fin.decide_reimbursement((select v from ids where k = 'r'), true, null, (now() at time zone 'America/Sao_Paulo')::date + 3) $$, 'aprova');
select is((select status from fin.reimbursements where id = (select v from ids where k = 'r')), 'APPROVED', 'reembolso aprovado');
select is((select direction::text || '/' || approval_status || '/' || origin_type || '/' || total_amount from fin.titles where id = (select title_id from fin.reimbursements where id = (select v from ids where k = 'r'))),
  'PAYABLE/APPROVED/REIMBURSEMENT/100.00', 'vira conta a pagar aprovada');
select is((select count(*)::int from fin.title_lines where title_id = (select title_id from fin.reimbursements where id = (select v from ids where k = 'r'))), 2, 'uma linha por categoria (energia e a classificar)');
select ok((select accrual_entry_id is not null from fin.titles where id = (select title_id from fin.reimbursements where id = (select v from ids where k = 'r'))), 'contabilizado na aprovação');

-- mesma nota em outro reembolso
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select fin.save_reimbursement(jsonb_build_object('purpose', 'De novo', 'items', jsonb_build_array(jsonb_build_object(
  'spent_on', (now() at time zone 'America/Sao_Paulo')::date, 'description', 'Almoço', 'document_kind', 'NFCE', 'amount', 82.5, 'access_key', (select v from kv where k = 'key'))))) $$, 'P0451', null, 'a mesma nota não entra duas vezes');

-- pago quando a conta é baixada
reset role;
update fin.titles set status = 'SETTLED' where id = (select title_id from fin.reimbursements where id = (select v from ids where k = 'r'));
select is((select status from fin.reimbursements where id = (select v from ids where k = 'r')), 'PAID', 'reembolso pago quando a conta é baixada');

select * from finish();
rollback;
