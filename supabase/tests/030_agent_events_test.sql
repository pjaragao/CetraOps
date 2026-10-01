begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

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
grant all on ids to authenticated, agent_rpc;

create or replace function pg_temp.agent_call(p_tool text, p_args jsonb default '{}') returns jsonb
language plpgsql as $f$
declare r jsonb;
begin
  set local role agent_rpc;
  begin
    r := agent.call_tool((select v::jsonb from ids where k = 'ctx'), p_tool, p_args);
  exception when others then
    reset role;
    return jsonb_build_object('__error', sqlstate, '__msg', sqlerrm);
  end;
  reset role;
  return r;
end $f$;

-- ---------- Preparação: conversa da cliente, eventos e convites ----------
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode)
values ('00000000-0000-4000-8000-0000000009aa', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PNID-EVT', 'WhatsApp (teste de eventos)', '00000000-0000-4000-8000-0000000000a1', 'AI_AUTOPILOT');
insert into ids select 'conv', (omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-EVT', 'external_id', '5548988880002',
  'phone', '5548988880002', 'display_name', 'Cliente Evento (teste)', 'provider_message_id', 'wamid.EV1', 'body', 'Vai ter evento?')))->>'conversation_id';
insert into ids select 'party', party_id::text from omni.conversations where id = (select v from ids where k = 'conv')::uuid;
insert into ai.runs (id, org_id, route_task, conversation_id, party_id) values ('00000000-0000-4000-8000-0000000009da', '00000000-0000-4000-8000-000000000001', 'conversation',
  (select v from ids where k = 'conv')::uuid, (select v from ids where k = 'party')::uuid);
insert into ids select 'ctx', jsonb_build_object('org', '00000000-0000-4000-8000-000000000001', 'conv', (select v from ids where k = 'conv'), 'party', (select v from ids where k = 'party'),
  'run', '00000000-0000-4000-8000-0000000009da', 'version', (select version from omni.conversations where id = (select v from ids where k = 'conv')::uuid),
  'caps', jsonb_build_array('list_upcoming_events', 'rsvp_event', 'propose_reply'))::text;
insert into ids select 'other', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '5548977770009', 'Outra Convidada (teste)', 'TEST')::text;

insert into mkt.events (id, org_id, kind, name, starts_at, venue, capacity, status) values
  ('00000000-0000-4000-8000-0000000009e1', '00000000-0000-4000-8000-000000000001', 'DROP', 'Drop de teste', now() + interval '10 days', 'Loja Boutique', 5, 'CONFIRMED'),
  ('00000000-0000-4000-8000-0000000009e2', '00000000-0000-4000-8000-000000000001', 'BREAKFAST_ACTIVATION', 'Café lotado (teste)', now() + interval '12 days', 'Academia', 1, 'CONFIRMED'),
  ('00000000-0000-4000-8000-0000000009e3', '00000000-0000-4000-8000-000000000001', 'DROP', 'Evento sem convite (teste)', now() + interval '14 days', 'Loja', 10, 'CONFIRMED'),
  ('00000000-0000-4000-8000-0000000009e4', '00000000-0000-4000-8000-000000000001', 'POPUP', 'Evento passado (teste)', now() - interval '2 days', 'Loja', 10, 'CONFIRMED');

-- ---------- Sem convite: a IA não oferece evento ----------
select is((pg_temp.agent_call('list_upcoming_events'))->>'code', 'NOT_FOUND', 'sem convite nenhum, não há o que oferecer');

insert into mkt.event_guests (org_id, event_id, party_id, rsvp_status) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009e1', (select v from ids where k = 'party')::uuid, 'INVITED'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009e2', (select v from ids where k = 'party')::uuid, 'INVITED'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009e2', (select v from ids where k = 'other')::uuid, 'CONFIRMED'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009e4', (select v from ids where k = 'party')::uuid, 'INVITED');

select is(jsonb_array_length((pg_temp.agent_call('list_upcoming_events'))->'events'), 2, 'lista só os eventos futuros com convite para esta cliente');
select is((pg_temp.agent_call('list_upcoming_events'))->'events'->0->>'name', 'Drop de teste', 'em ordem de data');
select is(((pg_temp.agent_call('list_upcoming_events'))->'events'->0->>'spots_left')::int, 5, 'mostra as vagas que restam');
select is((pg_temp.agent_call('list_upcoming_events'))->'events'->1->>'spots_left', '0', 'evento lotado: zero vagas');

-- ---------- Resposta ao convite ----------
select is((pg_temp.agent_call('rsvp_event', '{"event_id":"00000000-0000-4000-8000-0000000009e1","status":"CONFIRMED","plus_ones":1}'))->>'rsvp', 'CONFIRMED', 'confirma presença com 1 acompanhante');
select is((select (rsvp_status, plus_ones)::text from mkt.event_guests where event_id = '00000000-0000-4000-8000-0000000009e1' and party_id = (select v from ids where k = 'party')::uuid), '(CONFIRMED,1)', 'fica registrado no convite');
select ok(exists (select 1 from crm.timeline_events where party_id = (select v from ids where k = 'party')::uuid and kind = 'EVENT_RSVP' and summary like 'Drop de teste: confirmou%'), 'e na linha do tempo da cliente');
select is((pg_temp.agent_call('rsvp_event', '{"event_id":"00000000-0000-4000-8000-0000000009e2","status":"CONFIRMED"}'))->>'rsvp', 'WAITLIST', 'evento lotado: lista de espera');
select ok((pg_temp.agent_call('rsvp_event', '{"event_id":"00000000-0000-4000-8000-0000000009e2","status":"DECLINED"}'))->>'ok' = 'true', 'pode desistir depois');
select is((pg_temp.agent_call('rsvp_event', '{"event_id":"00000000-0000-4000-8000-0000000009e3","status":"CONFIRMED"}'))->>'code', 'NOT_INVITED', 'sem convite, não confirma (encaminha para a equipe)');
select is((pg_temp.agent_call('rsvp_event', '{"event_id":"00000000-0000-4000-8000-0000000009e4","status":"CONFIRMED"}'))->>'code', 'NOT_FOUND', 'evento que já passou');
select is((pg_temp.agent_call('rsvp_event', '{"event_id":"00000000-0000-4000-8000-0000000009e1","status":"ATTENDED"}'))->>'code', 'INVALID', 'a IA não registra presença (só confirmar ou recusar)');

-- ---------- A tela continua com a mesma regra (agora pelo núcleo compartilhado) ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((mkt.set_rsvp((select id from mkt.event_guests where event_id = '00000000-0000-4000-8000-0000000009e1' and party_id = (select v from ids where k = 'party')::uuid), 'ATTENDED')).rsvp_status, 'ATTENDED', 'a equipe registra a presença pela tela');
reset role;

select * from finish();
rollback;
