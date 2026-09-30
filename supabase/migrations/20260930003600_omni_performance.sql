-- =====================================================================
-- Atendimento › Desempenho: tempo de resposta (mediana e p90, por quem respondeu primeiro), SLA, o que a IA faz sozinha x o que a equipe faz,
-- aproveitamento dos rascunhos, transferências, resolução sem pessoa, custo da IA e vendas saídas de conversa.
-- Uma função só, calculada no banco sobre as mensagens do período.
-- =====================================================================

create index if not exists messages_org_created_idx on omni.messages (org_id, created_at);

-- Quando a conversa foi encerrada (updated_at muda a qualquer edição e não serve para isso)
alter table omni.conversations add column if not exists closed_at timestamptz;
update omni.conversations set closed_at = updated_at where status = 'CLOSED' and closed_at is null;
create or replace function omni.stamp_closed_at() returns trigger
language plpgsql as $$
begin
  if new.status = 'CLOSED' and old.status is distinct from 'CLOSED' then new.closed_at := now();
  elsif new.status <> 'CLOSED' then new.closed_at := null; end if;
  return new;
end $$;
drop trigger if exists trg_closed_at on omni.conversations;
create trigger trg_closed_at before update of status on omni.conversations for each row execute function omni.stamp_closed_at();

create or replace function omni.performance(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_conv jsonb; v_resp jsonb; v_by jsonb; v_ai jsonb; v_drafts jsonb; v_sales jsonb; v_channels jsonb; v_hours jsonb; v_people jsonb; v_reasons jsonb; v_sla int;
  v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('omni.read');
  if p_from is null or p_to is null or p_to <= p_from then raise exception 'Período inválido' using errcode = '22023'; end if;

  select jsonb_build_object(
    'started', count(*) filter (where created_at >= p_from and created_at < p_to),
    'open', count(*) filter (where status = 'OPEN'),
    'waiting_human', count(*) filter (where mode = 'WAITING_HUMAN' and status = 'OPEN'),
    'closed', count(*) filter (where status = 'CLOSED' and closed_at >= p_from and closed_at < p_to)) into v_conv
  from omni.conversations where org_id = v_org;

  -- Tempo até a primeira resposta a cada "rodada" da cliente (mensagem dela logo depois de uma nossa, ou a primeira da conversa)
  with msgs as (
    select m.conversation_id, m.direction, m.created_at, m.seq, lag(m.direction) over (partition by m.conversation_id order by m.created_at, m.seq) as prev_dir
    from omni.messages m where m.org_id = v_org and m.created_at >= p_from - interval '1 day' and m.created_at < p_to),
  starts as (select conversation_id, created_at as in_at, seq from msgs where direction = 'IN' and (prev_dir is null or prev_dir = 'OUT') and created_at >= p_from and created_at < p_to),
  resp as (
    select s.conversation_id, s.in_at, r.created_at as out_at, r.author_type as author
    from starts s left join lateral (
      select m.created_at, m.author_type from omni.messages m where m.conversation_id = s.conversation_id and m.direction = 'OUT' and m.author_type <> 'SYSTEM'
        and (m.created_at, m.seq) > (s.in_at, s.seq) order by m.created_at, m.seq limit 1) r on true)
  select jsonb_build_object('rounds', count(*), 'answered', count(out_at),
           'median_s', round((percentile_cont(0.5) within group (order by extract(epoch from out_at - in_at)))::numeric, 0),
           'p90_s', round((percentile_cont(0.9) within group (order by extract(epoch from out_at - in_at)))::numeric, 0)),
         (select coalesce(jsonb_object_agg(author, jsonb_build_object('n', n, 'median_s', med)), '{}') from (
            select author, count(*) as n, round((percentile_cont(0.5) within group (order by extract(epoch from out_at - in_at)))::numeric, 0) as med from resp where out_at is not null group by author) x)
  into v_resp, v_by from resp;

  select count(distinct coalesce(payload ->> 'conversation_id', id::text)) into v_sla from core.notifications where org_id = v_org and kind = 'SLA_BREACH' and created_at >= p_from and created_at < p_to;   -- uma por conversa (o aviso vai para várias pessoas)

  select jsonb_build_object(
    'ai_replies', count(*) filter (where author_type = 'AI'),
    'human_replies', count(*) filter (where author_type = 'HUMAN'),
    'echo_replies', count(*) filter (where author_type = 'ECHO_FROM_APP'),
    'inbound', count(*) filter (where direction = 'IN')) into v_ai
  from omni.messages where org_id = v_org and created_at >= p_from and created_at < p_to and (direction = 'IN' or author_type in ('AI', 'HUMAN', 'ECHO_FROM_APP'));
  v_ai := v_ai || jsonb_build_object(
    'handoffs', (select count(*) from omni.mode_events where org_id = v_org and to_mode = 'WAITING_HUMAN' and actor_type = 'AI' and created_at >= p_from and created_at < p_to),
    'resolved_without_people', (select count(*) from omni.conversations c where c.org_id = v_org and c.status = 'CLOSED' and c.closed_at >= p_from and c.closed_at < p_to
        and exists (select 1 from omni.messages m where m.conversation_id = c.id and m.author_type = 'AI') and not exists (select 1 from omni.messages m where m.conversation_id = c.id and m.author_type in ('HUMAN', 'ECHO_FROM_APP'))),
    'cost_usd', (select coalesce(round(sum(cost_usd), 4), 0) from ai.runs where org_id = v_org and created_at >= p_from and created_at < p_to),
    'runs', (select count(*) from ai.runs where org_id = v_org and created_at >= p_from and created_at < p_to and route_task = 'conversation'));

  select jsonb_build_object('total', count(*), 'sent', count(*) filter (where status = 'SENT'), 'edited', count(*) filter (where status = 'EDITED_SENT'),
                            'discarded', count(*) filter (where status = 'DISCARDED'), 'pending', count(*) filter (where status = 'PENDING')) into v_drafts
  from omni.message_drafts where org_id = v_org and created_at >= p_from and created_at < p_to;
  select coalesce(jsonb_agg(jsonb_build_object('reason', reason, 'n', n) order by n desc), '[]') into v_reasons from (
    select coalesce(discard_reason, '—') as reason, count(*) as n from omni.message_drafts where org_id = v_org and status = 'DISCARDED' and created_at >= p_from and created_at < p_to group by 1 order by 2 desc limit 5) x;
  v_drafts := v_drafts || jsonb_build_object('discard_reasons', v_reasons);

  select jsonb_build_object('orders', count(*), 'revenue', coalesce(round(sum(total), 2), 0), 'ai_assisted_orders', count(*) filter (where assisted_by_ai), 'ai_assisted_revenue', coalesce(round(sum(total) filter (where assisted_by_ai), 2), 0)) into v_sales
  from sales.orders where org_id = v_org and origin_conversation_id is not null and status::text = any (v_paid) and created_at >= p_from and created_at < p_to;

  select coalesce(jsonb_agg(jsonb_build_object('channel', channel, 'conversations', convs, 'inbound', inb) order by inb desc), '[]') into v_channels from (
    select ca.channel::text as channel, count(distinct m.conversation_id) as convs, count(*) filter (where m.direction = 'IN') as inb
    from omni.messages m join omni.channel_accounts ca on ca.id = m.channel_account_id where m.org_id = v_org and m.created_at >= p_from and m.created_at < p_to group by 1) x;
  select coalesce(jsonb_object_agg(h::text, n), '{}') into v_hours from (
    select extract(hour from created_at at time zone 'America/Sao_Paulo')::int as h, count(*) as n from omni.messages where org_id = v_org and direction = 'IN' and created_at >= p_from and created_at < p_to group by 1) x;
  select coalesce(jsonb_agg(jsonb_build_object('member_id', member_id, 'name', name, 'replies', n) order by n desc), '[]') into v_people from (
    select m.author_member_id as member_id, mb.display_name as name, count(*) as n from omni.messages m join core.members mb on mb.id = m.author_member_id
    where m.org_id = v_org and m.author_type = 'HUMAN' and m.created_at >= p_from and m.created_at < p_to group by 1, 2 order by 3 desc limit 10) x;

  return jsonb_build_object('conversations', v_conv, 'response', v_resp || jsonb_build_object('by_author', v_by), 'sla_breaches', v_sla, 'volume', v_ai, 'drafts', v_drafts, 'sales', v_sales,
                            'channels', v_channels, 'hours', v_hours, 'people', v_people);
end $$;

select private.lock_functions();
