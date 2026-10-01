-- =====================================================================
-- pg_cron: rotinas de manutenção do dia a dia. Cada job só chama UMA função idempotente — a lógica mora no banco, onde é testada (pgTAP).
-- Horários em UTC (o Brasil não tem horário de verão desde 2019: 06:00 BRT = 09:00 UTC).
-- Jobs que dependem de integrações ainda não conectadas (extratos, adquirente, MDe, briefing) entram junto com as respectivas integrações.
-- =====================================================================

-- Controle de alertas: nada é avisado duas vezes pelo mesmo motivo (um novo SLA/nova mensagem "rearma" sozinho)
alter table omni.conversations add column if not exists sla_alerted_at timestamptz;
alter table omni.conversations add column if not exists window_alerted_at timestamptz;

-- ---------------------------------------------------------------------
-- 1) SLA de atendimento humano estourado (a cada minuto)
-- ---------------------------------------------------------------------
create or replace function omni.sweep_sla() returns int
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in
    select cv.id, cv.org_id, cv.assignee_member_id, p.display_name, greatest(1, round(extract(epoch from now() - cv.sla_due_at) / 60))::int as late_min
    from omni.conversations cv join crm.parties p on p.id = cv.party_id
    where cv.status = 'OPEN' and cv.mode = 'WAITING_HUMAN' and cv.sla_due_at is not null and cv.sla_due_at < now()
      and (cv.sla_alerted_at is null or cv.sla_alerted_at < cv.sla_due_at)
  loop
    perform core.notify(r.org_id, 'SLA_BREACH', 'SLA estourado: ' || r.display_name || ' espera há ' || r.late_min || ' min além do prazo',
                        jsonb_build_object('conversation_id', r.id), case when r.assignee_member_id is null then 'omni.write' end, r.assignee_member_id);
    update omni.conversations set sla_alerted_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 2) Janela de 24 h fechando (WhatsApp/Instagram): avisa quando faltam ~2 h e a cliente está esperando resposta de uma pessoa
-- ---------------------------------------------------------------------
create or replace function omni.sweep_windows() returns int
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in
    select cv.id, cv.org_id, cv.assignee_member_id, p.display_name,
           greatest(1, round(extract(epoch from cv.last_inbound_at + interval '24 hours' - now()) / 60))::int as left_min
    from omni.conversations cv
      join crm.parties p on p.id = cv.party_id
      join omni.channel_accounts ca on ca.id = cv.channel_account_id
    where cv.status = 'OPEN' and cv.mode in ('HUMAN', 'WAITING_HUMAN') and ca.channel in ('WHATSAPP', 'INSTAGRAM')
      and cv.last_inbound_at between now() - interval '24 hours' and now() - interval '22 hours'
      and (cv.window_alerted_at is null or cv.window_alerted_at < cv.last_inbound_at)
      and (select m.direction from omni.messages m where m.conversation_id = cv.id order by m.created_at desc, m.seq desc limit 1) = 'IN'
  loop
    perform core.notify(r.org_id, 'WINDOW_EXPIRING', 'Janela de resposta fecha em ' || r.left_min || ' min: ' || r.display_name,
                        jsonb_build_object('conversation_id', r.id), case when r.assignee_member_id is null then 'omni.write' end, r.assignee_member_id);
    update omni.conversations set window_alerted_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 3) Execuções de IA "penduradas" (o worker caiu no meio): viram ERRO para não poluir custos e painéis
-- ---------------------------------------------------------------------
create or replace function private.sweep_ai_runs() returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update ai.runs set status = 'ERROR', error = coalesce(error, 'sem resposta do agente (execução interrompida)')
  where status = 'RUNNING' and created_at < now() - interval '15 minutes';
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 4) Filas mortas (DLQ) com mensagens: alerta o administrador (no máximo 1 vez por dia e por fila)
-- ---------------------------------------------------------------------
create or replace function private.check_queues() returns int
language plpgsql security definer set search_path = '' as $$
declare q record; o record; n int := 0; v_depth bigint;
begin
  for q in select queue_name from pgmq.list_queues() where right(queue_name, 4) = '_dlq' loop
    select queue_length into v_depth from pgmq.metrics(q.queue_name);
    continue when coalesce(v_depth, 0) = 0;
    for o in select id from core.orgs loop
      if not exists (select 1 from core.notifications where org_id = o.id and kind = 'DLQ_ALERT' and payload ->> 'queue' = q.queue_name and created_at > now() - interval '1 day') then
        perform core.notify(o.id, 'DLQ_ALERT', 'Fila ' || q.queue_name || ' com ' || v_depth || ' mensagem(ns) que falharam de vez', jsonb_build_object('queue', q.queue_name, 'depth', v_depth), 'core.admin');
        n := n + 1;
      end if;
    end loop;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 5) Retenção (LGPD): payload bruto de webhook por 90 dias
-- ---------------------------------------------------------------------
create or replace function private.purge_old_data() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_webhooks int;
begin
  delete from omni.webhook_events where received_at < now() - interval '90 days';
  get diagnostics v_webhooks = row_count;
  return jsonb_build_object('webhook_events', v_webhooks);
end $$;

insert into private.internal_functions (fqname) values
  ('omni.sweep_sla'), ('omni.sweep_windows'), ('private.sweep_ai_runs'), ('private.check_queues'), ('private.purge_old_data')
on conflict do nothing;
select private.lock_functions();

-- ---------------------------------------------------------------------
-- Agenda (nome fixo = reaplicar a migration não duplica)
-- ---------------------------------------------------------------------
select cron.schedule('sie-sweep-sla',              '* * * * *',   $$ select omni.sweep_sla() $$);
select cron.schedule('sie-sweep-windows',          '*/5 * * * *', $$ select omni.sweep_windows() $$);
select cron.schedule('sie-expire-reservations',    '*/5 * * * *', $$ select inv.expire_reservations() $$);
select cron.schedule('sie-expire-locker-drops',    '*/5 * * * *', $$ select sales.expire_locker_drops() $$);
select cron.schedule('sie-expire-pending-orders',  '*/5 * * * *', $$ select sales.expire_pending_orders() $$);
select cron.schedule('sie-sweep-ai-runs',          '*/10 * * * *', $$ select private.sweep_ai_runs() $$);
select cron.schedule('sie-check-queues',           '*/15 * * * *', $$ select private.check_queues() $$);
select cron.schedule('sie-hr-roll-vacations',      '0 9 * * *',   $$ select hr.roll_vacation_status() $$);      -- 06:00 BRT
select cron.schedule('sie-purge-old-data',         '30 6 * * 0',  $$ select private.purge_old_data() $$);      -- domingo 03:30 BRT
