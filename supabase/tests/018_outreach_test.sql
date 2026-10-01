begin;
create extension if not exists pgtap with schema extensions;
select plan(35);

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

-- ---------- Preparação (dono do banco): só os leads do teste têm @ do Instagram ----------
update crm.parties set instagram_handle = null where org_id = '00000000-0000-4000-8000-000000000001';
insert into crm.parties (id, org_id, kind, display_name, instagram_handle, lifecycle_stage, lead_score) values
  ('00000000-0000-4000-8000-0000000009b1', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Lead Um (teste)', 'lead_um', 'LEAD', 80),
  ('00000000-0000-4000-8000-0000000009b2', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Lead Dois (teste)', 'lead_dois', 'PROSPECT', 50),
  ('00000000-0000-4000-8000-0000000009b3', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Cliente (teste)', 'cliente_tres', 'CUSTOMER', 99),
  ('00000000-0000-4000-8000-0000000009b4', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Sem perfil (teste)', null, 'LEAD', 90),
  ('00000000-0000-4000-8000-0000000009b5', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Recusou (teste)', 'recusou_cinco', 'LEAD', 95);
insert into crm.consents (org_id, party_id, purpose, granted, legal_basis) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009b5', 'MARKETING_IG', false, 'CONSENT');
insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009b1', 'INSTAGRAM', 'lead_um', '@lead_um', true);
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode) values
  ('00000000-0000-4000-8000-0000000009e9', '00000000-0000-4000-8000-000000000001', 'INSTAGRAM', 'IG-OUT-1', 'Instagram prospecção', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT');
create temp table q0 as select (select queue_length from pgmq.metrics('ai_tasks')) as t;

-- ---------- Sem permissão ----------
set local role anon;
select throws_ok($$ select crm.generate_outreach() $$, '42501', null, 'anônimo não gera lista');
reset role;

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
-- ---------- Lista do dia ----------
select is(crm.generate_outreach(), 2, 'entram só os leads com @, sem recusa e que ainda não são clientes');
select is((select string_agg(p.display_name, ', ' order by p.lead_score desc) from crm.outreach_items o join crm.parties p on p.id = o.party_id where o.assigned_member_id = '00000000-0000-4000-8000-000000000102'), 'Lead Um (teste), Lead Dois (teste)', 'ordem pelo score');
select is((select string_agg(distinct playbook_step || '/' || channel::text || '/' || status, ',') from crm.outreach_items), 'STORY/INSTAGRAM/SUGGESTED', 'começa pelo story, no Instagram');
select is((select count(*)::int from crm.outreach_items where due_on = private.today_sp() and assigned_member_id = '00000000-0000-4000-8000-000000000102'), 2, 'para hoje e para quem pediu');
select is(crm.generate_outreach(), 0, 'pedir de novo não repete quem já está na lista');
select throws_ok($$ select crm.generate_outreach(0) $$, 'P0171', null, 'meta do dia zerada');

-- ---------- Andamento ----------
insert into ids select 'i1', id::text from crm.outreach_items where party_id = '00000000-0000-4000-8000-0000000009b1';
insert into ids select 'i2', id::text from crm.outreach_items where party_id = '00000000-0000-4000-8000-0000000009b2';
select throws_ok($$ select crm.set_outreach_status((select v from ids where k = 'i1')::uuid, 'VOANDO') $$, 'P0170', null, 'situação inválida');
select throws_ok($$ select crm.set_outreach_status((select v from ids where k = 'i2')::uuid, 'SKIPPED') $$, 'P0170', null, 'pular exige motivo');
select throws_ok($$ select crm.set_outreach_status(gen_random_uuid(), 'APPROVED') $$, 'P0172', null, 'item inexistente');
select is((crm.set_outreach_status((select v from ids where k = 'i1')::uuid, 'SENT_MANUALLY')).done_at is not null, true, 'marcar como feito registra a hora');
select ok(exists (select 1 from crm.timeline_events where source_id = (select v from ids where k = 'i1')::uuid and kind = 'OUTREACH_DONE'), 'vai para a linha do tempo');
select throws_ok($$ select crm.set_outreach_status((select v from ids where k = 'i1')::uuid, 'SKIPPED', 'desisti') $$, 'P0171', null, 'item feito não muda');
select is(crm.generate_outreach(), 0, 'um passo por pessoa por dia');

-- passa um dia: o passo seguinte entra (curtir → seguir → DM)
reset role;
update crm.outreach_items set created_at = now() - interval '3 days', done_at = now() - interval '3 days' where id = (select v from ids where k = 'i1')::uuid;
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is(crm.generate_outreach(), 1, 'no dia seguinte entra o passo seguinte de quem já fez o story (quem tem pendência não entra)');
select is((select playbook_step from crm.outreach_items where party_id = '00000000-0000-4000-8000-0000000009b1' order by created_at desc limit 1), 'LIKE', 'curtir');
reset role;
update crm.outreach_items set status = 'SENT_MANUALLY', created_at = now() - interval '2 days', done_at = now() - interval '2 days' where party_id = '00000000-0000-4000-8000-0000000009b1' and playbook_step = 'LIKE';
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select crm.generate_outreach();
select is((select playbook_step from crm.outreach_items where party_id = '00000000-0000-4000-8000-0000000009b1' order by created_at desc limit 1), 'FOLLOW', 'seguir');
reset role;
update crm.outreach_items set status = 'SENT_MANUALLY', created_at = now() - interval '1 day', done_at = now() - interval '1 day' where party_id = '00000000-0000-4000-8000-0000000009b1' and playbook_step = 'FOLLOW';
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select crm.generate_outreach();
select is((select playbook_step from crm.outreach_items where party_id = '00000000-0000-4000-8000-0000000009b1' order by created_at desc limit 1), 'DM', 'por fim, a DM');
insert into ids select 'dm', id::text from crm.outreach_items where party_id = '00000000-0000-4000-8000-0000000009b1' and playbook_step = 'DM';
reset role;
select is((select queue_length from pgmq.metrics('ai_tasks')) - (select t from q0), 1::bigint, 'a DM pede a redação da abordagem ao worker');
select is((select message ->> 'action' || '/' || jsonb_array_length(message -> 'item_ids') from pgmq.q_ai_tasks order by msg_id desc limit 1), 'OUTREACH_DRAFT/1', 'tarefa OUTREACH_DRAFT com o item da DM');
select lives_ok($$ select crm.outreach_set_draft((select v from ids where k = 'dm')::uuid, 'Oi, Lead! Vi seu perfil e adorei. Quer conhecer a loja?') $$, 'worker grava o rascunho da mensagem');
select lives_ok($$ select crm.outreach_set_draft((select v from ids where k = 'dm')::uuid, 'Outro texto qualquer que não deve entrar') $$, 'e não sobrescreve um texto já existente');
select is((select suggested_message from crm.outreach_items where id = (select v from ids where k = 'dm')::uuid), 'Oi, Lead! Vi seu perfil e adorei. Quer conhecer a loja?', 'ficou o primeiro');

-- ---------- Mensagem ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select crm.save_outreach_message((select v from ids where k = 'dm')::uuid, 'oi') $$, 'P0170', null, 'mensagem curta demais');
select is((crm.save_outreach_message((select v from ids where k = 'dm')::uuid, 'Oi! Vi seu perfil e adorei o seu movimento. Quer conhecer a loja?')).suggested_message, 'Oi! Vi seu perfil e adorei o seu movimento. Quer conhecer a loja?', 'a vendedora edita o texto');
select is((crm.set_outreach_status((select v from ids where k = 'dm')::uuid, 'APPROVED')).status, 'APPROVED', 'aprova a mensagem');

-- ---------- Eco do app oficial vincula a DM ----------
reset role;
select is((omni.ingest_event(jsonb_build_object('kind', 'ECHO', 'channel', 'INSTAGRAM', 'provider_account_id', 'IG-OUT-1', 'external_id', 'igsid-um', 'handle', 'lead_um', 'display_name', 'Lead Um',
  'provider_message_id', 'mid.echo.1', 'body', 'Oi! Vi seu perfil e adorei o seu movimento. Quer conhecer a loja?')) ->> 'kind'), 'ECHO', 'DM enviada pelo app chega como eco');
select is((select status || '/' || (evidence_message_id is not null) from crm.outreach_items where id = (select v from ids where k = 'dm')::uuid), 'SENT_MANUALLY/true', 'o eco fecha o item e guarda a prova');
select ok(exists (select 1 from crm.timeline_events where source_id = (select v from ids where k = 'dm')::uuid and kind = 'OUTREACH_DONE' and summary like '%eco%'), 'e registra na linha do tempo');
select throws_ok($$ select crm.save_outreach_message((select v from ids where k = 'dm')::uuid, 'Nova mensagem depois de enviada') $$, 'P0172', null, 'item encerrado não edita texto');

-- ---------- Recusa ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is((crm.set_outreach_status((select v from ids where k = 'i2')::uuid, 'SKIPPED', 'Perfil privado')).skip_reason, 'Perfil privado', 'pular guarda o motivo');
select is((select count(*)::int from crm.consents where party_id = '00000000-0000-4000-8000-0000000009b2' and purpose = 'MARKETING_IG' and granted = false), 0, 'pular por perfil privado não é recusa de contato');
reset role;
insert into crm.outreach_items (org_id, party_id, channel, playbook_step, assigned_member_id) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009b4', 'INSTAGRAM', 'STORY', '00000000-0000-4000-8000-000000000102');
insert into ids select 'i4', id::text from crm.outreach_items where party_id = '00000000-0000-4000-8000-0000000009b4';
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select crm.set_outreach_status((select v from ids where k = 'i4')::uuid, 'SKIPPED', 'Ela pediu para parar de receber mensagens');
select is((select count(*)::int from crm.consents where party_id = '00000000-0000-4000-8000-0000000009b4' and purpose = 'MARKETING_IG' and granted = false), 1, 'pedido para parar vira recusa registrada');

-- ---------- Privilégios ----------
select ok(not has_function_privilege('authenticated', 'crm.outreach_set_draft(uuid,text)', 'execute') and not has_function_privilege('authenticated', 'crm.link_outreach_echo()', 'execute'), 'funções do worker e do gatilho não são chamáveis pela tela');
select ok(has_function_privilege('authenticated', 'crm.generate_outreach(integer)', 'execute'), 'a lista do dia é chamável pela tela');

select * from finish();
rollback;
