-- =====================================================================
-- IA de atendimento: ferramentas list_upcoming_events e rsvp_event (convites da própria cliente; o RSVP respeita a capacidade e a lista de espera).
-- Para a IA confirmar presença sem passar pelas permissões de quem usa a tela, a regra de RSVP e a de mover oportunidade viraram núcleos
-- internos (organização como parâmetro); as funções da tela continuam exigindo a permissão e chamam o mesmo núcleo.
-- =====================================================================

create or replace function private.move_deal_core(p_org uuid, p_deal uuid, p_stage uuid, p_reason text default null) returns crm.deals
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := p_org; d crm.deals; s crm.pipeline_stages; v_status text; v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into d from crm.deals where id = p_deal and org_id = v_org for update;
  if d.id is null then raise exception 'Oportunidade não encontrada' using errcode = 'P0152'; end if;
  select * into s from crm.pipeline_stages where id = p_stage and pipeline_id = d.pipeline_id and org_id = v_org;
  if s.id is null then raise exception 'Essa etapa não pertence ao funil da oportunidade' using errcode = 'P0150'; end if;
  if s.id = d.stage_id then return d; end if;
  v_status := case when s.is_won then 'WON' when s.is_lost then 'LOST' else 'OPEN' end;
  if v_status = 'LOST' and (v_reason is null or length(v_reason) < 3) then raise exception 'Informe o motivo da perda' using errcode = 'P0150'; end if;
  update crm.deals set stage_id = s.id, status = v_status, lost_reason = case when v_status = 'LOST' then v_reason end where id = d.id returning * into d;
  perform private.timeline(v_org, d.party_id, case v_status when 'WON' then 'DEAL_WON' when 'LOST' then 'DEAL_LOST' else 'DEAL_MOVED' end, 'deal', d.id,
    case v_status when 'WON' then 'Oportunidade ganha: ' when 'LOST' then 'Oportunidade perdida: ' else 'Oportunidade movida para ' || s.name || ': ' end || d.title
      || case when v_status = 'LOST' then ' (' || v_reason || ')' else '' end, jsonb_build_object('stage', s.name));
  if v_status = 'WON' then
    update crm.parties set lifecycle_stage = 'CUSTOMER' where id = d.party_id and lifecycle_stage in ('LEAD', 'PROSPECT');
  end if;
  return d;
end $$;

create or replace function crm.move_deal(p_deal uuid, p_stage uuid, p_reason text default null) returns crm.deals
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.write');
  return private.move_deal_core(private.org_id(), p_deal, p_stage, p_reason);
end $$;

create or replace function private.apply_rsvp(p_org uuid, p_guest uuid, p_status text, p_plus_ones integer default null) returns mkt.event_guests
language plpgsql security definer set search_path = '' as $$
declare
  g mkt.event_guests; e mkt.events; v_status text := upper(coalesce(p_status, '')); v_pos int; v_stage uuid; v_used int; v_plus int;
begin
  if v_status not in ('INVITED', 'CONFIRMED', 'DECLINED', 'WAITLIST', 'ATTENDED', 'NO_SHOW') then raise exception 'Situação inválida' using errcode = 'P0180'; end if;
  select * into g from mkt.event_guests where id = p_guest and org_id = p_org for update;
  if g.id is null then raise exception 'Convidada não encontrada' using errcode = 'P0182'; end if;
  select * into e from mkt.events where id = g.event_id for update;
  if e.status = 'CANCELLED' then raise exception 'Evento cancelado' using errcode = 'P0181'; end if;
  v_plus := coalesce(p_plus_ones, g.plus_ones);
  if v_plus not between 0 and 5 then raise exception 'Acompanhantes: de 0 a 5' using errcode = 'P0180'; end if;
  if v_status in ('CONFIRMED', 'ATTENDED') and g.rsvp_status not in ('CONFIRMED', 'ATTENDED') and e.capacity is not null then
    v_used := private.event_headcount(e.id);
    if v_used + 1 + v_plus > e.capacity then
      if v_status = 'ATTENDED' then raise exception 'Evento lotado: confirme a capacidade antes de registrar a presença' using errcode = 'P0181'; end if;
      v_status := 'WAITLIST';
    end if;
  end if;
  update mkt.event_guests set rsvp_status = v_status, plus_ones = v_plus, checked_in_at = case when v_status = 'ATTENDED' then coalesce(checked_in_at, now()) else null end where id = g.id returning * into g;
  if g.deal_id is not null then
    v_pos := case v_status when 'CONFIRMED' then 2 when 'ATTENDED' then 3 else 1 end;
    if v_status in ('DECLINED', 'NO_SHOW') then
      select s.id into v_stage from crm.deals d join crm.pipeline_stages s on s.pipeline_id = d.pipeline_id and s.is_lost where d.id = g.deal_id limit 1;
      if v_stage is not null then perform private.move_deal_core(p_org, g.deal_id, v_stage, case v_status when 'DECLINED' then 'Recusou o convite' else 'Não compareceu' end); end if;
    else
      select s.id into v_stage from crm.deals d join crm.pipeline_stages s on s.pipeline_id = d.pipeline_id and s.position = v_pos where d.id = g.deal_id limit 1;
      if v_stage is not null then perform private.move_deal_core(p_org, g.deal_id, v_stage); end if;
    end if;
  end if;
  perform private.timeline(g.org_id, g.party_id, 'EVENT_RSVP', 'mkt.events', e.id, e.name || ': ' || case v_status when 'CONFIRMED' then 'confirmou presença' when 'DECLINED' then 'recusou' when 'WAITLIST' then 'na lista de espera' when 'ATTENDED' then 'compareceu' when 'NO_SHOW' then 'não compareceu' else 'convite pendente' end);
  return g;
end $$;

create or replace function mkt.set_rsvp(p_guest uuid, p_status text, p_plus_ones integer default null) returns mkt.event_guests
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.write');
  return private.apply_rsvp(private.org_id(), p_guest, p_status, p_plus_ones);
end $$;

-- ---------------------------------------------------------------------
-- Ferramentas da IA: eventos (só os da própria cliente; o ctx fixa quem ela é)
-- ---------------------------------------------------------------------
create or replace function agent.t_list_upcoming_events(c omni.conversations, a jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'event_id', e.id, 'name', e.name, 'kind', e.kind, 'starts_at', to_char(e.starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'), 'venue', e.venue,
      'your_rsvp', g.rsvp_status, 'plus_ones', g.plus_ones,
      'spots_left', case when e.capacity is null then null else greatest(0, e.capacity - private.event_headcount(e.id)) end) order by e.starts_at), '[]'::jsonb)
  into v
  from mkt.event_guests g join mkt.events e on e.id = g.event_id
  where g.org_id = c.org_id and g.party_id = c.party_id and e.status in ('PLANNED', 'CONFIRMED') and e.starts_at >= now() and g.rsvp_status in ('INVITED', 'CONFIRMED', 'WAITLIST');
  if jsonb_array_length(v) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Nenhum evento com convite para esta cliente: não ofereça nem invente eventos', 'code', 'NOT_FOUND');
  end if;
  return jsonb_build_object('ok', true, 'events', v);
end $$;

create or replace function agent.t_rsvp_event(c omni.conversations, a jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g mkt.event_guests; e mkt.events; v_status text := upper(coalesce(a ->> 'status', ''));
begin
  if v_status not in ('CONFIRMED', 'DECLINED') then return jsonb_build_object('ok', false, 'error', 'Use CONFIRMED ou DECLINED', 'code', 'INVALID'); end if;
  select * into e from mkt.events where id = nullif(a ->> 'event_id', '')::uuid and org_id = c.org_id;
  if e.id is null or e.status not in ('PLANNED', 'CONFIRMED') or e.starts_at < now() then
    return jsonb_build_object('ok', false, 'error', 'Evento não encontrado ou já encerrado', 'code', 'NOT_FOUND');
  end if;
  select * into g from mkt.event_guests where event_id = e.id and party_id = c.party_id;
  if g.id is null then return jsonb_build_object('ok', false, 'error', 'Esta cliente não tem convite para este evento: encaminhe para a equipe', 'code', 'NOT_INVITED'); end if;
  if g.rsvp_status in ('ATTENDED', 'NO_SHOW') then return jsonb_build_object('ok', false, 'error', 'A presença deste convite já foi registrada', 'code', 'INVALID'); end if;
  g := private.apply_rsvp(c.org_id, g.id, v_status, coalesce((a ->> 'plus_ones')::int, g.plus_ones));
  return jsonb_build_object('ok', true, 'event', e.name, 'rsvp', g.rsvp_status, 'plus_ones', g.plus_ones,
    'note', case when g.rsvp_status = 'WAITLIST' then 'Evento lotado: ela ficou na lista de espera e a equipe avisa se abrir vaga' end);
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm, 'code', sqlstate);
end $$;
revoke execute on function agent.t_list_upcoming_events(omni.conversations, jsonb) from public, anon, authenticated;
revoke execute on function agent.t_rsvp_event(omni.conversations, jsonb) from public, anon, authenticated;
grant execute on function agent.t_list_upcoming_events(omni.conversations, jsonb) to agent_rpc, service_role;
grant execute on function agent.t_rsvp_event(omni.conversations, jsonb) to agent_rpc, service_role;

-- Ponto único de entrada das ferramentas, agora com os eventos
create or replace function agent.call_tool(p_ctx jsonb, p_tool text, p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c omni.conversations; v_t0 timestamptz := clock_timestamp(); v_res jsonb; v_run uuid := nullif(p_ctx ->> 'run', '')::uuid; v_args jsonb := coalesce(p_args, '{}');
begin
  c := agent.ctx_conversation(p_ctx);
  if jsonb_typeof(p_ctx -> 'caps') <> 'array' or not (p_ctx -> 'caps') ? p_tool then
    raise exception 'Ferramenta % não permitida neste contexto', p_tool using errcode = '42501';
  end if;
  -- IDs de cliente/organização/conversa vindos do modelo são descartados: vale só o do ctx
  v_args := v_args - 'party_id' - 'org_id' - 'conversation_id' - 'party' - 'org' - 'conv';
  begin
    v_res := case p_tool
      when 'search_catalog' then agent.t_search_catalog(c, v_args)
      when 'check_stock_by_size' then agent.t_check_stock(c, v_args)
      when 'get_customer_360' then agent.t_customer_360(c, v_args)
      when 'get_order_status' then agent.t_order_status(c, v_args)
      when 'get_policies' then agent.t_get_policies(c, v_args)
      when 'search_knowledge' then agent.t_search_knowledge(c, v_args)
      when 'list_upcoming_events' then agent.t_list_upcoming_events(c, v_args)
      when 'rsvp_event' then agent.t_rsvp_event(c, v_args)
      when 'apply_coupon' then agent.t_apply_coupon(c, v_args)
      when 'create_reservation' then agent.t_create_reservation(c, v_args)
      when 'schedule_locker' then agent.t_schedule_locker(c, v_args)
      when 'create_order_draft' then agent.t_create_order_draft(c, v_args || jsonb_build_object('_run', coalesce(v_run::text, 'x')))
      when 'confirm_order_draft' then agent.t_confirm_order_draft(c, v_args)
      when 'create_payment_link' then agent.t_create_payment_link(c, v_args)
      when 'register_consent' then agent.t_register_consent(c, v_args)
      when 'update_customer_profile' then agent.t_update_profile(c, v_args)
      when 'remember_customer_fact' then agent.t_remember_fact(c, v_args)
      when 'request_handoff' then agent.t_request_handoff(p_ctx, c, v_args)
      when 'propose_reply' then agent.t_propose_reply(c, v_args)
      else jsonb_build_object('ok', false, 'error', 'Ferramenta desconhecida: ' || p_tool, 'code', 'UNKNOWN_TOOL')
    end;
  exception when others then
    v_res := jsonb_build_object('ok', false, 'error', sqlerrm, 'code', sqlstate);
  end;
  if v_run is not null and exists (select 1 from ai.runs where id = v_run and org_id = c.org_id) then
    insert into ai.tool_calls (run_id, tool, args, result_digest, ok, ms)
    values (v_run, p_tool, v_args, v_res, coalesce((v_res ->> 'ok')::boolean, false), (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);
  end if;
  return v_res;
end $$;

insert into private.internal_functions (fqname) values ('private.move_deal_core'), ('private.apply_rsvp') on conflict do nothing;
select private.lock_functions();
