-- Corrige o "um passo por dia" do funil de prospecção: o dia é o de São Paulo (antes comparava a data em UTC e, depois das 21h em Brasília, tratava o passo de ontem como de hoje).
create or replace function crm.generate_outreach(p_limit integer default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_me uuid := private.member_id(); v_today date := private.today_sp();
  v_cfg jsonb := coalesce((select value from core.settings where org_id = private.org_id() and key = 'outreach'), '{}');
  v_daily int := coalesce((v_cfg ->> 'daily_limit')::int, 15); v_cool int := coalesce((v_cfg ->> 'cooldown_days')::int, 30);
  v_have int; v_room int; v_n int := 0; r record; v_step text; v_ids uuid[] := '{}'; v_id uuid;
begin
  perform private.require_perm('crm.write');
  if v_me is null then raise exception 'Só membros da equipe geram a lista' using errcode = 'P0171'; end if;
  select count(*) into v_have from crm.outreach_items where assigned_member_id = v_me and due_on = v_today and status <> 'SKIPPED';
  v_room := least(coalesce(p_limit, v_daily), v_daily) - v_have;
  if v_room <= 0 then raise exception 'A meta do dia (%) já está na sua lista', v_daily using errcode = 'P0171'; end if;

  for r in
    select p.id as party_id, p.instagram_handle, last.playbook_step as last_step, last.status as last_status, last.done_at as last_done, last.created_at as last_created
    from crm.parties p
    left join lateral (select o.playbook_step, o.status, o.done_at, o.created_at from crm.outreach_items o where o.party_id = p.id and o.channel = 'INSTAGRAM' order by o.created_at desc limit 1) last on true
    where p.org_id = v_org and p.instagram_handle is not null and trim(p.instagram_handle) <> '' and p.merged_into_id is null and p.anonymized_at is null
      and p.lifecycle_stage in ('LEAD', 'PROSPECT')
      and not exists (select 1 from crm.party_roles rl where rl.party_id = p.id and rl.role in ('EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK'))
      and not exists (select 1 from crm.v_current_consents c where c.party_id = p.id and c.purpose = 'MARKETING_IG' and c.granted = false)
      and (last.status is null or last.status in ('SENT_MANUALLY', 'SKIPPED'))
    order by p.lead_score desc, p.created_at
    limit 400
  loop
    if r.last_status is null then
      v_step := 'STORY';
    elsif r.last_status = 'SKIPPED' then
      continue when r.last_created > now() - make_interval(days => v_cool);   -- recusou/pulou: só volta depois do intervalo
      v_step := 'STORY';
    elsif r.last_step = 'DM' then
      continue when coalesce(r.last_done, r.last_created) > now() - make_interval(days => v_cool);
      v_step := 'STORY';
    else
      continue when (coalesce(r.last_done, r.last_created) at time zone 'America/Sao_Paulo')::date >= v_today;       -- um passo por dia
      v_step := private.outreach_next_step(r.last_step);
    end if;
    insert into crm.outreach_items (org_id, party_id, channel, playbook_step, assigned_member_id, due_on)
    values (v_org, r.party_id, 'INSTAGRAM', v_step, v_me, v_today) returning id into v_id;
    v_n := v_n + 1;
    if v_step = 'DM' then v_ids := v_ids || v_id; end if;
    exit when v_n >= v_room;
  end loop;
  if cardinality(v_ids) > 0 then
    perform private.enqueue('ai_tasks', jsonb_build_object('action', 'OUTREACH_DRAFT', 'org_id', v_org, 'item_ids', to_jsonb(v_ids)));
  end if;
  return v_n;
end $$;

select private.lock_functions();
