begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

create temp table ids (k text primary key, v text);

insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode)
values ('00000000-0000-4000-8000-0000000009c1', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PNID-CRON', 'WhatsApp (teste do cron)', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT');

create or replace function pg_temp.new_conv(p_key text, p_phone text) returns void language plpgsql as $$
begin
  insert into ids select p_key, (omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-CRON', 'external_id', p_phone,
    'phone', p_phone, 'display_name', 'Cliente ' || p_key || ' (teste)', 'provider_message_id', 'wamid.CRON-' || p_key, 'body', 'Oi')))->>'conversation_id';
end $$;
create or replace function pg_temp.notified(p_kind text, p_key text) returns int language sql as $$
  select count(*)::int from core.notifications where kind = p_kind and payload ->> 'conversation_id' = (select v from ids where k = p_key);
$$;

-- ---------- Agenda ----------
select is((select count(*)::int from cron.job where active and jobname = any(array['sie-sweep-sla', 'sie-sweep-windows', 'sie-expire-reservations', 'sie-expire-locker-drops', 'sie-expire-pending-orders',
  'sie-sweep-ai-runs', 'sie-check-queues', 'sie-hr-roll-vacations', 'sie-purge-old-data'])), 9, 'as nove rotinas de manutenção estão agendadas no pg_cron');
select ok((select bool_and(btrim(command) like 'select %') from cron.job where jobname like 'sie-%'), 'cada rotina só chama uma função');

-- ---------- SLA ----------
select pg_temp.new_conv('sla', '5548930000001');
select pg_temp.new_conv('ai', '5548930000002');
update omni.conversations set mode = 'WAITING_HUMAN', sla_due_at = now() - interval '20 minutes' where id = (select v from ids where k = 'sla')::uuid;
update omni.conversations set mode = 'AI_AUTOPILOT', sla_due_at = now() - interval '20 minutes' where id = (select v from ids where k = 'ai')::uuid;
select ok(omni.sweep_sla() >= 1, 'SLA vencido é detectado');
select ok(pg_temp.notified('SLA_BREACH', 'sla') >= 1, 'quem tem permissão de atendimento é avisado');
select ok((select sla_alerted_at is not null from omni.conversations where id = (select v from ids where k = 'sla')::uuid), 'alerta registrado na conversa');
select is(pg_temp.notified('SLA_BREACH', 'ai'), 0, 'conversa com a IA (sem SLA humano) não gera alerta');
select lives_ok($$ select omni.sweep_sla() $$, 'reexecutar é seguro');
create temp table sla_before as select pg_temp.notified('SLA_BREACH', 'sla') as n;
select omni.sweep_sla();
select is(pg_temp.notified('SLA_BREACH', 'sla'), (select n from sla_before), 'o mesmo SLA não é avisado de novo');
update omni.conversations set sla_alerted_at = now() - interval '1 hour', sla_due_at = now() - interval '5 minutes' where id = (select v from ids where k = 'sla')::uuid;
select omni.sweep_sla();
select ok(pg_temp.notified('SLA_BREACH', 'sla') > (select n from sla_before), 'novo prazo vencido rearma o alerta');

-- ---------- Janela de 24 h ----------
select pg_temp.new_conv('w23', '5548930000011');   -- 23 h sem resposta, cliente esperando
select pg_temp.new_conv('w21', '5548930000012');   -- 21 h: ainda cedo
select pg_temp.new_conv('w25', '5548930000013');   -- 25 h: já fechou
select pg_temp.new_conv('wout', '5548930000014');  -- 23 h, mas a última mensagem é nossa
select pg_temp.new_conv('wai', '5548930000015');   -- 23 h, mas com a IA (ela não depende de alerta)
update omni.conversations set mode = 'HUMAN', last_inbound_at = now() - interval '23 hours' where id = (select v from ids where k = 'w23')::uuid;
update omni.conversations set mode = 'HUMAN', last_inbound_at = now() - interval '21 hours' where id = (select v from ids where k = 'w21')::uuid;
update omni.conversations set mode = 'HUMAN', last_inbound_at = now() - interval '25 hours' where id = (select v from ids where k = 'w25')::uuid;
update omni.conversations set mode = 'HUMAN', last_inbound_at = now() - interval '23 hours' where id = (select v from ids where k = 'wout')::uuid;
update omni.conversations set mode = 'AI_COPILOT', last_inbound_at = now() - interval '23 hours' where id = (select v from ids where k = 'wai')::uuid;
insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, body, status)
select org_id, id, channel_account_id, 'OUT', 'HUMAN', 'Já te respondo!', 'SENT' from omni.conversations where id = (select v from ids where k = 'wout')::uuid;
select ok(omni.sweep_windows() >= 1, 'janela fechando é detectada');
select ok(pg_temp.notified('WINDOW_EXPIRING', 'w23') >= 1, 'aviso: faltam ~1 h e a cliente espera resposta');
select is(pg_temp.notified('WINDOW_EXPIRING', 'w21') + pg_temp.notified('WINDOW_EXPIRING', 'w25') + pg_temp.notified('WINDOW_EXPIRING', 'wout') + pg_temp.notified('WINDOW_EXPIRING', 'wai'), 0,
          'sem aviso: ainda cedo, já fechada, última mensagem nossa ou atendimento por IA');
create temp table win_before as select pg_temp.notified('WINDOW_EXPIRING', 'w23') as n;
select omni.sweep_windows();
select is(pg_temp.notified('WINDOW_EXPIRING', 'w23'), (select n from win_before), 'não avisa duas vezes pela mesma mensagem');

-- ---------- Execuções de IA penduradas ----------
insert into ai.runs (id, org_id, route_task, status, created_at) values
  ('00000000-0000-4000-8000-0000000009e1', '00000000-0000-4000-8000-000000000001', 'conversation', 'RUNNING', now() - interval '30 minutes'),
  ('00000000-0000-4000-8000-0000000009e2', '00000000-0000-4000-8000-000000000001', 'conversation', 'RUNNING', now() - interval '1 minute');
select ok(private.sweep_ai_runs() >= 1, 'execução parada há 30 min é encerrada');
select is((select status from ai.runs where id = '00000000-0000-4000-8000-0000000009e1'), 'ERROR', 'marcada como erro');
select is((select status from ai.runs where id = '00000000-0000-4000-8000-0000000009e2'), 'RUNNING', 'execução recente continua em andamento');

-- ---------- Fila morta ----------
delete from core.notifications where kind = 'DLQ_ALERT' and payload ->> 'queue' = 'notifications_dlq';   -- (o pg_cron de verdade pode já ter avisado antes deste teste)
select pgmq.send('notifications_dlq', '{"teste": true}'::jsonb);
select ok(private.check_queues() >= 1, 'DLQ com mensagem gera alerta');
select ok((select count(*)::int from core.notifications where kind = 'DLQ_ALERT' and payload ->> 'queue' = 'notifications_dlq' and created_at > now() - interval '1 day') >= 1, 'os administradores são avisados da fila morta');
create temp table dlq_before as select count(*)::int as n from core.notifications where kind = 'DLQ_ALERT' and payload ->> 'queue' = 'notifications_dlq';
select private.check_queues();
select is((select count(*)::int from core.notifications where kind = 'DLQ_ALERT' and payload ->> 'queue' = 'notifications_dlq'), (select n from dlq_before), 'reexecutar no mesmo dia não repete o alerta');

-- ---------- Retenção ----------
insert into omni.webhook_events (provider, event_key, payload, signature_valid, received_at) values
  ('META_WA', 'cron-old', '{}', true, now() - interval '100 days'), ('META_WA', 'cron-new', '{}', true, now() - interval '1 day');
select is((select count(*)::int from omni.webhook_events where event_key in ('cron-old', 'cron-new')), 2, 'preparação: um antigo e um recente');
select ok((private.purge_old_data() ->> 'webhook_events')::int >= 1, 'retenção apaga o payload bruto com mais de 90 dias');
select is((select array_agg(event_key order by event_key) from omni.webhook_events where event_key in ('cron-old', 'cron-new')), array['cron-new'], 'só o recente permanece');

-- ---------- Privilégios: rotinas internas nunca ficam ao alcance do app ----------
select ok(not has_function_privilege('authenticated', 'omni.sweep_sla()', 'execute') and not has_function_privilege('authenticated', 'omni.sweep_windows()', 'execute')
      and not has_function_privilege('authenticated', 'private.purge_old_data()', 'execute') and not has_function_privilege('anon', 'private.check_queues()', 'execute'), 'rotinas do cron não são chamáveis pelo app');

select * from finish();
rollback;
