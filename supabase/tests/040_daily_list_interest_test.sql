begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

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
grant all on ids to authenticated;

insert into ids select 'ana', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 92222-0001', 'Ana Lista', 'TEST');
insert into ids select 'vip', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 92222-0002', 'Vera Lista', 'TEST');
update crm.parties set tier = 'VIP', tier_manual = true where id = (select v from ids where k = 'vip');
-- tarefas da vendedora (102): uma comum para hoje, uma de retomada atrasada da VIP, uma de amanhã e uma de prospecção
insert into crm.tasks (org_id, party_id, assignee_member_id, type, title, suggested_message, due_at) values
  ('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'ana'), '00000000-0000-4000-8000-000000000102', 'FOLLOW_UP', 'Falar com Ana', 'Oi, Ana!', least(now() + interval '1 hour', (private.today_sp() + time '23:59') at time zone 'America/Sao_Paulo')),   -- sempre hoje, mesmo rodando às 23h
  ('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'vip'), '00000000-0000-4000-8000-000000000102', 'RECOVERY', 'Retomar com Vera', 'Oi, Vera!', now() - interval '3 hours'),
  ('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'ana'), '00000000-0000-4000-8000-000000000102', 'FOLLOW_UP', 'Amanhã', null, now() + interval '3 days'),
  ('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'ana'), '00000000-0000-4000-8000-000000000102', 'OUTREACH', 'Prospecção', null, now());

-- ---------- Lista do dia ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select is((select title from crm.daily_actions(10) limit 1), 'Retomar com Vera', 'VIP com retomada atrasada vem primeiro');
select ok((select reason from crm.daily_actions(10) where title = 'Retomar com Vera') like '%VIP%atrasada%', 'motivo explica a prioridade');
select ok(not exists (select 1 from crm.daily_actions(10) where title in ('Amanhã', 'Prospecção')), 'só o de hoje; prospecção tem tela própria');
select is((select count(*)::int from crm.daily_actions(1)), 1, 'limite da lista respeitado');
select throws_ok($$ select crm.finish_task((select task_id from crm.daily_actions(10) where title = 'Falar com Ana'), 'CANCELLED', '') $$, 'P0360', null, 'pular exige motivo');
select lives_ok($$ select crm.finish_task((select task_id from crm.daily_actions(10) where title = 'Falar com Ana'), 'CANCELLED', 'já comprou na loja') $$, 'pula com motivo');
select is((select outcome_note from crm.tasks where title = 'Falar com Ana'), 'já comprou na loja', 'motivo gravado');
select ok(exists (select 1 from crm.timeline_events where party_id = (select v from ids where k = 'ana') and summary like 'Pulado: Falar com Ana%'), 'na linha do tempo');
select ok((select omni.open_conversation_for((select v from ids where k = 'vip'))) is not null, 'abre a conversa de WhatsApp da cliente');
select is((select mode::text from omni.conversations where party_id = (select v from ids where k = 'vip') and status <> 'CLOSED'), 'HUMAN', 'conversa aberta pela equipe fica com humano');

-- ---------- Avise-me ----------
reset role;
update inv.stock_levels set on_hand = reserved where location_id = '00000000-0000-4000-8000-0000000000b1'
  and variant_id in (select id from catalog.variants where product_id = '00000000-0000-4000-8000-000000000401' and size = 'G');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select crm.add_interest((select v from ids where k = 'ana'), '00000000-0000-4000-8000-000000000401', 'ZZ') $$, 'P0360', null, 'tamanho que o produto não tem é recusado');
select lives_ok($$ insert into ids select 'alert', (crm.add_interest((select v from ids where k = 'ana'), '00000000-0000-4000-8000-000000000401', 'g', null, 'cor preta')).id $$, 'registra o avise-me');
select is((crm.add_interest((select v from ids where k = 'ana'), '00000000-0000-4000-8000-000000000401', 'G')).id, (select v from ids where k = 'alert'), 'pedir de novo não duplica');
reset role;
-- o tamanho chega
update inv.stock_levels set on_hand = reserved + 3 where location_id = '00000000-0000-4000-8000-0000000000b1'
  and variant_id = (select id from catalog.variants where product_id = '00000000-0000-4000-8000-000000000401' and size = 'G' order by sku limit 1);
select is((select status from crm.interest_alerts where id = (select v from ids where k = 'alert')), 'NOTIFIED', 'chegou: pedido avisado');
select ok((select reservation_id is not null from crm.interest_alerts where id = (select v from ids where k = 'alert')), 'peça reservada para ela (24 h)');
select is((select reason from inv.reservations where id = (select reservation_id from crm.interest_alerts where id = (select v from ids where k = 'alert'))), 'DROP_WAITLIST', 'reserva de lista de espera');
select ok(exists (select 1 from crm.tasks where source_rule = 'interest:' || (select v from ids where k = 'alert') and suggested_message like '%Separei para você até%'), 'sem aviso automático ligado: tarefa com mensagem pronta');

-- ---------- Ferramenta da IA ----------
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode) values
  ('00000000-0000-4000-8000-0000000009c7', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PNID-INTEREST', 'WhatsApp (avise-me)', '00000000-0000-4000-8000-0000000000a1', 'AI_AUTOPILOT');
insert into ids select 'conv', ((omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-INTEREST',
  'external_id', '5548922220009', 'phone', '5548922220009', 'display_name', 'Iara Tool', 'provider_message_id', 'wamid.I1', 'type', 'TEXT', 'body', 'Tem a legging no M?')))->>'conversation_id')::uuid;
insert into ids select 'iara', party_id from omni.conversations where id = (select v from ids where k = 'conv');
select is((agent.call_tool(jsonb_build_object('org', '00000000-0000-4000-8000-000000000001', 'conv', (select v from ids where k = 'conv'), 'party', (select v from ids where k = 'iara'), 'caps', jsonb_build_array('register_interest')),
  'register_interest', '{"product_id":"00000000-0000-4000-8000-000000000401","size":"M"}')) ->> 'ok', 'true', 'a IA registra o avise-me da cliente da conversa');
select is((select created_via from crm.interest_alerts where party_id = (select party_id from omni.conversations where id = (select v from ids where k = 'conv'))), 'AI', 'registrado como vindo da IA');
select throws_ok($$ select agent.call_tool(jsonb_build_object('org', '00000000-0000-4000-8000-000000000001', 'conv', (select v from ids where k = 'conv'), 'party', (select v from ids where k = 'iara'), 'caps', jsonb_build_array('propose_reply')),
  'register_interest', '{"product_id":"00000000-0000-4000-8000-000000000401","size":"M"}') $$, '42501', null, 'sem a ferramenta no contexto: bloqueada');

select * from finish();
rollback;
