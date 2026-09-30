begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

-- ---------- Preparação: um dia de conversas com horários controlados (janela de teste isolada, em 2031) ----------
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode) values
  ('00000000-0000-4000-8000-0000000009f7', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PN-PERF', 'WhatsApp desempenho', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT');
insert into crm.parties (id, org_id, kind, display_name) values
  ('00000000-0000-4000-8000-0000000009a1', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Cliente Perf 1'), ('00000000-0000-4000-8000-0000000009a2', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Cliente Perf 2'),
  ('00000000-0000-4000-8000-0000000009a3', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Cliente Perf 3'), ('00000000-0000-4000-8000-0000000009a4', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Cliente Perf 4');
insert into omni.channel_identities (id, org_id, channel_account_id, external_id, party_id)
  select ('00000000-0000-4000-8000-0000000009b' || n)::uuid, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009f7', 'perf' || n, ('00000000-0000-4000-8000-0000000009a' || n)::uuid from generate_series(1, 4) n;
insert into omni.conversations (id, org_id, party_id, channel_account_id, channel_identity_id, mode, status, created_at, updated_at)
  select ('00000000-0000-4000-8000-0000000009c' || n)::uuid, '00000000-0000-4000-8000-000000000001', ('00000000-0000-4000-8000-0000000009a' || n)::uuid, '00000000-0000-4000-8000-0000000009f7',
         ('00000000-0000-4000-8000-0000000009b' || n)::uuid, 'AI_COPILOT', case when n = 4 then 'CLOSED' else 'OPEN' end, '2031-03-10 13:00:00+00', '2031-03-10 15:00:00+00' from generate_series(1, 4) n;
create function pg_temp.msg(p_conv int, p_dir text, p_author text, p_at text, p_member uuid default null) returns void language sql as $$
  insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, author_member_id, type, body, status, created_at)
  values ('00000000-0000-4000-8000-000000000001', ('00000000-0000-4000-8000-0000000009c' || p_conv)::uuid, '00000000-0000-4000-8000-0000000009f7', p_dir, p_author, p_member, 'TEXT', 'x', case when p_dir = 'IN' then 'RECEIVED' else 'SENT' end, p_at::timestamptz)
$$;
-- conv 1: duas rodadas (a IA responde em 30 s; a segunda, uma pessoa em 120 s)
select pg_temp.msg(1, 'IN', 'CUSTOMER', '2031-03-10 13:00:00+00');
select pg_temp.msg(1, 'OUT', 'AI', '2031-03-10 13:00:30+00');
select pg_temp.msg(1, 'IN', 'CUSTOMER', '2031-03-10 13:10:00+00');
select pg_temp.msg(1, 'OUT', 'HUMAN', '2031-03-10 13:12:00+00', '00000000-0000-4000-8000-000000000101');
-- conv 2: resposta pelo app do celular (eco) em 5 min
select pg_temp.msg(2, 'IN', 'CUSTOMER', '2031-03-10 14:00:00+00');
select pg_temp.msg(2, 'OUT', 'ECHO_FROM_APP', '2031-03-10 14:05:00+00');
-- conv 3: sem resposta
select pg_temp.msg(3, 'IN', 'CUSTOMER', '2031-03-10 15:00:00+00');
-- conv 4: encerrada só com a IA
select pg_temp.msg(4, 'IN', 'CUSTOMER', '2031-03-10 16:00:00+00');
select pg_temp.msg(4, 'OUT', 'AI', '2031-03-10 16:00:20+00');
select pg_temp.msg(4, 'OUT', 'SYSTEM', '2031-03-10 16:00:25+00');
update omni.conversations set status = 'CLOSED' where id = '00000000-0000-4000-8000-0000000009c4';                      -- encerra depois das mensagens (nova mensagem reabre)
update omni.conversations set closed_at = '2031-03-10 16:30:00+00' where id = '00000000-0000-4000-8000-0000000009c4';
insert into omni.message_drafts (org_id, conversation_id, variants, status, discard_reason, created_at) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c1', '[]', 'SENT', null, '2031-03-10 13:05:00+00'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c1', '[]', 'EDITED_SENT', null, '2031-03-10 13:06:00+00'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c2', '[]', 'DISCARDED', 'tom errado', '2031-03-10 14:01:00+00'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c3', '[]', 'PENDING', null, '2031-03-10 15:01:00+00');
insert into omni.mode_events (org_id, conversation_id, from_mode, to_mode, trigger, actor_type, created_at) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c1', 'AI_AUTOPILOT', 'WAITING_HUMAN', 'LOW_CONFIDENCE', 'SYSTEM', '2031-03-10 13:08:00+00'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009c2', 'AI_COPILOT', 'HUMAN', 'MANUAL', 'USER', '2031-03-10 14:04:00+00');
insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, origin_conversation_id, assisted_by_ai, subtotal, total, idempotency_key, created_at) values
  ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'PERF-1', 'WHATSAPP', 'PAID', '00000000-0000-4000-8000-0000000009a1', '00000000-0000-4000-8000-0000000009c1', true, 400, 400, 'perf-1', '2031-03-10 13:30:00+00'),
  ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'PERF-2', 'WHATSAPP', 'PAID', '00000000-0000-4000-8000-0000000009a2', '00000000-0000-4000-8000-0000000009c2', false, 300, 300, 'perf-2', '2031-03-10 14:30:00+00'),
  ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'PERF-3', 'WHATSAPP', 'CANCELLED', '00000000-0000-4000-8000-0000000009a3', '00000000-0000-4000-8000-0000000009c3', false, 900, 900, 'perf-3', '2031-03-10 15:30:00+00');
insert into ai.runs (org_id, route_task, status, cost_usd, created_at) values ('00000000-0000-4000-8000-000000000001', 'conversation', 'OK', 0.25, '2031-03-10 13:00:10+00');
select core.notify('00000000-0000-4000-8000-000000000001', 'SLA_BREACH', 'SLA estourado', jsonb_build_object('conversation_id', '00000000-0000-4000-8000-0000000009c3'), 'omni.write', null);
update core.notifications set created_at = '2031-03-10 15:30:00+00' where kind = 'SLA_BREACH' and title = 'SLA estourado' and created_at > now() - interval '1 minute';

-- ---------- Sem permissão e período inválido ----------
set local role anon;
select throws_ok($$ select omni.performance('2031-03-10'::timestamptz, '2031-03-11'::timestamptz) $$, '42501', null, 'anônimo não vê o desempenho');
reset role;
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (omni.read)
select throws_ok($$ select omni.performance('2031-03-11'::timestamptz, '2031-03-10'::timestamptz) $$, '22023', null, 'período invertido');

-- ---------- Resultados ----------
create temp table perf as select omni.performance('2031-03-10 00:00:00+00', '2031-03-11 00:00:00+00') as r;
grant select on perf to authenticated;
select is((select r -> 'response' ->> 'rounds' from perf), '5', 'rodadas da cliente (conv1 x2, conv2, conv3, conv4)');
select is((select r -> 'response' ->> 'answered' from perf), '4', 'quatro respondidas (a mensagem de sistema não conta)');
select is((select (r -> 'response' ->> 'median_s')::int from perf), 75, 'mediana do tempo de resposta (20, 30, 120, 300 s)');
select is((select r -> 'response' -> 'by_author' -> 'AI' ->> 'n' from perf), '2', 'respostas da IA');
select is((select (r -> 'response' -> 'by_author' -> 'HUMAN' ->> 'median_s')::int from perf), 120, 'tempo da equipe');
select is((select (r -> 'response' -> 'by_author' -> 'ECHO_FROM_APP' ->> 'median_s')::int from perf), 300, 'tempo pelo app do celular');
select is((select r -> 'volume' ->> 'ai_replies' || '/' || (r -> 'volume' ->> 'human_replies') || '/' || (r -> 'volume' ->> 'echo_replies') from perf), '2/1/1', 'quem respondeu: IA / equipe / celular');
select is((select r -> 'volume' ->> 'handoffs' from perf), '1', 'transferências automáticas (a troca feita por pessoa não conta)');
select is((select r -> 'volume' ->> 'resolved_without_people' from perf), '1', 'resolvida só pela IA');
select is((select (r -> 'volume' ->> 'cost_usd')::numeric from perf), 0.25, 'custo da IA');
select is((select r -> 'drafts' ->> 'total' || '/' || (r -> 'drafts' ->> 'sent') || '/' || (r -> 'drafts' ->> 'edited') || '/' || (r -> 'drafts' ->> 'discarded') || '/' || (r -> 'drafts' ->> 'pending') from perf), '4/1/1/1/1', 'aproveitamento dos rascunhos');
select is((select r -> 'drafts' -> 'discard_reasons' -> 0 ->> 'reason' from perf), 'tom errado', 'motivo de descarte');
select is((select r -> 'sales' ->> 'orders' || '/' || (r -> 'sales' ->> 'revenue') || '/' || (r -> 'sales' ->> 'ai_assisted_orders') || '/' || (r -> 'sales' ->> 'ai_assisted_revenue') from perf), '2/700.00/1/400.00', 'vendas saídas de conversa (cancelada fora) e as assistidas pela IA');
select is((select (r -> 'conversations' ->> 'started')::int from perf), 4, 'conversas iniciadas');
select is((select r ->> 'sla_breaches' from perf), '1', 'avisos de SLA estourado');
select is((select sum(v::int)::int from perf, jsonb_each_text(r -> 'hours') e(k, v)), 5, 'mensagens da cliente por hora somam o total');
select is((select r -> 'people' -> 0 ->> 'name' from perf), 'Sócio (teste)', 'respostas por pessoa');
select is((select jsonb_array_length(r -> 'channels') from perf), 1, 'por canal');
select ok(has_function_privilege('authenticated', 'omni.performance(timestamptz,timestamptz)', 'execute'), 'chamável pela tela');

select * from finish();
rollback;
