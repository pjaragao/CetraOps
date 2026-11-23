begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

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

-- ---------- Preparação: canal de WhatsApp e duas conversas ----------
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode) values
  ('00000000-0000-4000-8000-0000000009f1', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PN-REPLY-1', 'WhatsApp reply', '00000000-0000-4000-8000-0000000000a1', 'HUMAN');
insert into ids select 'conv', r ->> 'conversation_id' from (select omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PN-REPLY-1',
  'external_id', '5548977770188', 'phone', '5548977770188', 'display_name', 'Clara Reply (teste)', 'provider_message_id', 'wamid.REPLY1', 'body', 'Tem a bermuda no M?')) as r) x;
insert into ids select 'conv2', r ->> 'conversation_id' from (select omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PN-REPLY-1',
  'external_id', '5548977770189', 'phone', '5548977770189', 'display_name', 'Outra Cliente (teste)', 'provider_message_id', 'wamid.REPLY2', 'body', 'Oi')) as r) x;
insert into ids select 'q', id::text from omni.messages where provider_message_id = 'wamid.REPLY1';
insert into ids select 'q2', id::text from omni.messages where provider_message_id = 'wamid.REPLY2';
-- mensagem da loja ainda na fila (sem id da Meta)
insert into ids select 'queued', id::text from (
  insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, body, status)
  values ('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'conv')::uuid, '00000000-0000-4000-8000-0000000009f1', 'OUT', 'HUMAN', 'enviando…', 'QUEUED') returning id) x;

-- ---------- Responder citando uma mensagem ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into ids select 'r', (omni.send_message((select v from ids where k = 'conv')::uuid, 'Tem sim! 💛', null, false, (select v from ids where k = 'q')::uuid)).id::text;
reset role;
select is((select reply_to_id::text from omni.messages where id = (select v from ids where k = 'r')::uuid), (select v from ids where k = 'q'), 'resposta guarda a mensagem citada');
select is((select payload ->> 'reply_to' from omni.messages where id = (select v from ids where k = 'r')::uuid), 'wamid.REPLY1', 'e o id da Meta que vai como context');
select is((select payload ->> 'send_mode' from omni.messages where id = (select v from ids where k = 'r')::uuid) is not null, true, 'continua com o modo de envio');
select is((select (omni.outbound_context((select v from ids where k = 'r')::uuid)) -> 'message' -> 'payload' ->> 'reply_to'), 'wamid.REPLY1', 'o worker recebe o reply_to');

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into ids select 'plain', (omni.send_message((select v from ids where k = 'conv')::uuid, 'Sem citação')).id::text;
select throws_ok(format($$ select omni.send_message(%L::uuid, 'x', null, false, %L::uuid) $$, (select v from ids where k = 'conv'), (select v from ids where k = 'q2')),
  'P0002', null, 'não cita mensagem de outra conversa');
select throws_ok(format($$ select omni.send_message(%L::uuid, 'x', null, false, %L::uuid) $$, (select v from ids where k = 'conv'), (select v from ids where k = 'queued')),
  '22023', null, 'não cita mensagem que ainda não saiu');
select throws_ok(format($$ select omni.send_message(%L::uuid, 'x', null, false, gen_random_uuid()) $$, (select v from ids where k = 'conv')),
  'P0002', null, 'não cita mensagem inexistente');
reset role;
select is((select reply_to_id from omni.messages where id = (select v from ids where k = 'plain')::uuid), null, 'sem citação, sem reply_to_id');
select is((select payload ? 'reply_to' from omni.messages where id = (select v from ids where k = 'plain')::uuid), false, 'e sem reply_to no payload');

-- ---------- Bucket da mídia do atendimento ----------
select is((select public from storage.buckets where id = 'omni-media'), false, 'bucket omni-media existe e é privado');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'omni_media_read'), 1, 'leitura restrita por política');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'omni' and p.proname = 'send_message'), 1, 'send_message sem sobrecarga ambígua');

select * from finish();
rollback;
