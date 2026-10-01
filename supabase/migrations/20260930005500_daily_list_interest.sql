-- =====================================================================
-- Retenção (plano de marketing e atendimento, Fase 3):
-- • "Minha lista de hoje": as tarefas de relacionamento do dia, ordenadas por urgência e valor da cliente (até 10),
--   com a mensagem pronta e o atalho para abrir a conversa com o texto preenchido.
-- • Avise-me: a cliente pede "me avisa quando chegar o M" (na loja, na ficha ou pela IA); quando o tamanho entra no estoque,
--   sai o aviso (texto/ template de utilidade/ tarefa) e, se configurado, a peça fica reservada 24 h para ela.
-- • Ferramenta da IA register_interest (registra o avise-me pela conversa).
-- Códigos de erro: P0360 dado inválido · P0361 situação não permite · P0362 não encontrado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Lista do dia
-- ---------------------------------------------------------------------
alter table crm.tasks add column if not exists outcome_note text;

create or replace function crm.daily_actions(p_limit integer default 10) returns table (
  task_id uuid, party_id uuid, party_name text, title text, suggested_message text, type text, due_at timestamptz, overdue boolean,
  tier text, at_risk boolean, revenue_12m numeric, priority int, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := private.member_id(); v_end timestamptz := ((private.today_sp() + 1)::timestamp at time zone 'America/Sao_Paulo');
begin
  perform private.require_perm('crm.read');
  return query
    select t.id, t.party_id, p.display_name, t.title, t.suggested_message, t.type, t.due_at, coalesce(t.due_at < now(), false), p.tier::text, coalesce(m.at_risk, false), coalesce(m.revenue_12m, 0),
           (case when t.due_at < now() then 40 else 20 end
            + case t.type when 'RECOVERY' then 50 when 'BIRTHDAY' then 35 when 'JOURNEY' then 30 when 'REACTIVATION' then 25 else 15 end
            + case p.tier when 'VIP_BLACK' then 30 when 'VIP' then 20 else 0 end
            + case when coalesce(m.at_risk, false) then 15 else 0 end
            + least(20, floor(coalesce(m.revenue_12m, 0) / 100))::int)::int as prio,
           concat_ws(' · ',
             case t.type when 'RECOVERY' then 'retomar' when 'BIRTHDAY' then 'aniversário' when 'JOURNEY' then 'régua' when 'REACTIVATION' then 'reativação' else null end,
             case p.tier when 'VIP_BLACK' then 'VIP Black' when 'VIP' then 'VIP' end,
             case when coalesce(m.at_risk, false) then 'em risco' end,
             case when t.due_at < now() then 'atrasada' end)
    from crm.tasks t join crm.parties p on p.id = t.party_id left join crm.customer_metrics m on m.party_id = p.id
    where t.org_id = private.org_id() and t.status = 'OPEN' and t.type <> 'OUTREACH' and coalesce(t.due_at, now()) < v_end
      and (t.assignee_member_id = v_me or (t.assignee_member_id is null and (p.relationship_owner_member_id is null or p.relationship_owner_member_id = v_me)))
    order by prio desc, t.due_at nulls last
    limit least(coalesce(p_limit, 10), 50);
end $$;

-- Pular (com motivo) ou concluir com uma nota
create or replace function crm.finish_task(p_id uuid, p_status text, p_note text default null) returns crm.tasks
language plpgsql security definer set search_path = '' as $$
declare t crm.tasks;
begin
  perform private.require_perm('crm.write');
  if p_status not in ('DONE', 'CANCELLED') then raise exception 'Situação inválida' using errcode = 'P0360'; end if;
  if p_status = 'CANCELLED' and length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Diga por que pulou (ex.: já comprou, pediu para não chamar)' using errcode = 'P0360'; end if;
  update crm.tasks set status = p_status, completed_at = case when p_status = 'DONE' then now() end, outcome_note = nullif(left(trim(coalesce(p_note, '')), 300), '')
  where id = p_id and org_id = private.org_id() and status = 'OPEN' returning * into t;
  if t.id is null then raise exception 'Tarefa não encontrada ou já resolvida' using errcode = 'P0362'; end if;
  if t.party_id is not null then
    perform private.timeline(t.org_id, t.party_id, 'TASK', 'crm.tasks', t.id, case when p_status = 'DONE' then 'Feito: ' else 'Pulado: ' end || t.title || coalesce(' — ' || t.outcome_note, ''));
  end if;
  return t;
end $$;

-- Abre (ou acha) a conversa de WhatsApp da pessoa para a equipe escrever
create or replace function omni.open_conversation_for(p_party uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_conv uuid; v_acc uuid; v_wa text;
begin
  perform private.require_perm('omni.write');
  if not exists (select 1 from crm.parties where id = p_party and org_id = v_org) then raise exception 'Pessoa não encontrada' using errcode = 'P0362'; end if;
  select id into v_conv from omni.conversations where party_id = p_party and org_id = v_org and status <> 'CLOSED' order by last_message_at desc nulls last limit 1;
  if v_conv is not null then return v_conv; end if;
  v_wa := private.party_wa_id(p_party);
  select id into v_acc from omni.channel_accounts where org_id = v_org and channel = 'WHATSAPP' and status = 'ACTIVE' order by created_at limit 1;
  if v_wa is null or v_acc is null then raise exception 'Esta cliente não tem WhatsApp cadastrado (ou não há número da loja ativo)' using errcode = 'P0361'; end if;
  v_conv := private.ensure_wa_conversation(v_acc, p_party, v_wa);
  if v_conv is null then raise exception 'Este número pertence a outra pessoa no cadastro' using errcode = 'P0361'; end if;
  update omni.conversations set mode = 'HUMAN' where id = v_conv and mode <> 'HUMAN';
  return v_conv;
end $$;

-- ---------------------------------------------------------------------
-- 2) Avise-me
-- ---------------------------------------------------------------------
create table crm.interest_alerts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id) on delete cascade,
  product_id uuid not null references catalog.products(id) on delete cascade,
  size text not null,
  color_id uuid references catalog.colors(id),
  note text,
  status text not null default 'WAITING' check (status in ('WAITING', 'NOTIFIED', 'CANCELLED')),
  created_via text not null default 'STAFF' check (created_via in ('STAFF', 'AI')),
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  reservation_id uuid references inv.reservations(id) on delete set null
);
create index interest_waiting_idx on crm.interest_alerts (product_id, size) where status = 'WAITING';
create unique index interest_one_waiting_uq on crm.interest_alerts (party_id, product_id, size, coalesce(color_id, '00000000-0000-0000-0000-000000000000')) where status = 'WAITING';
select private.apply_rls('crm', array['interest_alerts'], 'crm.read', 'crm.write');
select private.rpc_only('crm', array['interest_alerts']);

create or replace function private.add_interest(p_org uuid, p_party uuid, p_product uuid, p_size text, p_color uuid, p_note text, p_via text) returns crm.interest_alerts
language plpgsql security definer set search_path = '' as $$
declare a crm.interest_alerts; v_size text := upper(trim(coalesce(p_size, '')));
begin
  if not exists (select 1 from catalog.products where id = p_product and org_id = p_org) then raise exception 'Produto não encontrado' using errcode = 'P0362'; end if;
  if not exists (select 1 from catalog.variants where product_id = p_product and upper(size) = v_size and (p_color is null or color_id = p_color)) then
    raise exception 'Este produto não tem o tamanho %', v_size using errcode = 'P0360';
  end if;
  select * into a from crm.interest_alerts where party_id = p_party and product_id = p_product and size = v_size and color_id is not distinct from p_color and status = 'WAITING';
  if a.id is not null then                                               -- já pedido: só atualiza a observação
    if nullif(trim(coalesce(p_note, '')), '') is not null then update crm.interest_alerts set note = left(trim(p_note), 200) where id = a.id returning * into a; end if;
    return a;
  end if;
  insert into crm.interest_alerts (org_id, party_id, product_id, size, color_id, note, created_via, created_by)
  values (p_org, p_party, p_product, v_size, p_color, nullif(left(trim(coalesce(p_note, '')), 200), ''), p_via, private.member_id()) returning * into a;
  perform private.timeline(p_org, p_party, 'INTEREST', 'crm.interest_alerts', a.id,
    'Avise-me: ' || (select name from catalog.products where id = p_product) || ' no ' || v_size);
  return a;
end $$;

create or replace function crm.add_interest(p_party uuid, p_product uuid, p_size text, p_color uuid default null, p_note text default null) returns crm.interest_alerts
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.write');
  if not exists (select 1 from crm.parties where id = p_party and org_id = private.org_id()) then raise exception 'Pessoa não encontrada' using errcode = 'P0362'; end if;
  return private.add_interest(private.org_id(), p_party, p_product, p_size, p_color, p_note, 'STAFF');
end $$;

create or replace function crm.cancel_interest(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.write');
  update crm.interest_alerts set status = 'CANCELLED' where id = p_id and org_id = private.org_id() and status = 'WAITING';
  if not found then raise exception 'Pedido não encontrado' using errcode = 'P0362'; end if;
end $$;

-- Aviso "chegou o seu tamanho" entra nos avisos automáticos
alter table omni.notice_rules drop constraint if exists notice_rules_event_check;
alter table omni.notice_rules add constraint notice_rules_event_check check (event in ('ORDER_PAID', 'READY_FOR_PICKUP', 'SHIPPED', 'LOCKER_READY', 'RESERVATION_EXPIRING', 'PAYMENT_LINK_REMINDER', 'STORE_CREDIT_ISSUED', 'EVENT_REMINDER', 'BACK_IN_STOCK'));
create or replace function private.notice_default_text(p_event text) returns text
language sql immutable as $$
  select case p_event
    when 'ORDER_PAID' then 'Oi, {nome}! Recebemos o pagamento do pedido {pedido}. Avisamos por aqui assim que estiver pronto. 💛'
    when 'READY_FOR_PICKUP' then 'Oi, {nome}! Seu pedido {pedido} está pronto para retirar na SIÉ, dentro da JOY.'
    when 'SHIPPED' then 'Oi, {nome}! Seu pedido {pedido} saiu para entrega. Rastreio: {rastreio}'
    when 'LOCKER_READY' then 'Oi, {nome}! Suas peças estão separadas no Armário VIP {codigo} até {prazo}. É só pedir a chave na loja. ✨'
    when 'RESERVATION_EXPIRING' then 'Oi, {nome}! A peça que separamos para você fica reservada até {prazo}. Quer que a gente segure mais um pouco?'
    when 'PAYMENT_LINK_REMINDER' then 'Oi, {nome}! Passando para lembrar do link do pedido {pedido}: {link} . Se preferir, dá para pagar na loja também.'
    when 'STORE_CREDIT_ISSUED' then 'Oi, {nome}! Geramos um vale-troca de {valor} para você usar na SIÉ. Ele já está no seu cadastro.'
    when 'EVENT_REMINDER' then 'Oi, {nome}! Lembrando do {evento} amanhã, {prazo}. Te esperamos! ✨'
    when 'BACK_IN_STOCK' then 'Oi, {nome}! Chegou {codigo} no tamanho que você pediu. {prazo} 💛'
  end
$$;

create or replace function private.interest_cfg(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('auto_reserve_hours', 24) || coalesce((select value from core.settings where org_id = p_org and key = 'interest'), '{}')
$$;

-- Estoque do tamanho voltou: avisa quem pediu (um aviso por pedido) e reserva se configurado
create or replace function private.interest_on_stock() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v record; a record; v_store uuid; r inv.reservations; v_hours int; v_left numeric; v_name text; v_task uuid;
begin
  if new.available <= 0 or (tg_op = 'UPDATE' and old.available > 0) then return null; end if;
  select va.product_id, upper(va.size) as size, va.color_id, p.name into v from catalog.variants va join catalog.products p on p.id = va.product_id where va.id = new.variant_id;
  select l.store_id into v_store from inv.locations l where l.id = new.location_id and l.is_sellable;
  if v_store is null then return null; end if;
  v_hours := coalesce((private.interest_cfg(new.org_id) ->> 'auto_reserve_hours')::int, 0);
  v_left := new.available;
  for a in select * from crm.interest_alerts where product_id = v.product_id and size = v.size and status = 'WAITING' and (color_id is null or color_id = v.color_id)
           order by created_at limit 20 loop
    begin
      r := null;
      if v_hours > 0 and v_left >= 1 then
        r := private.reserve_for(new.org_id, jsonb_build_object('variant_id', new.variant_id, 'location_id', new.location_id, 'qty', 1, 'reason', 'DROP_WAITLIST',
                                                                'party_id', a.party_id, 'hold_hours', v_hours, 'created_by_kind', 'SYSTEM'));
        v_left := v_left - 1;
      end if;
      update crm.interest_alerts set status = 'NOTIFIED', notified_at = now(), reservation_id = r.id where id = a.id;
      if private.dispatch_notice(new.org_id, 'BACK_IN_STOCK', a.party_id, a.id,
           jsonb_build_object('codigo', v.name, 'prazo', case when r.id is not null then 'Separei para você até ' || private.fmt_when(r.expires_at) || '.' else 'Quer que eu separe?' end)) = 'NO_RULE' then
        select display_name into v_name from crm.parties where id = a.party_id;
        insert into crm.tasks (org_id, party_id, type, title, suggested_message, due_at, source_rule)
        values (new.org_id, a.party_id, 'RECOVERY', 'Avisar ' || split_part(v_name, ' ', 1) || ': chegou ' || v.name || ' no ' || v.size,
                'Oi, ' || split_part(v_name, ' ', 1) || '! Chegou ' || v.name || ' no ' || v.size || ', que você pediu. ' ||
                case when r.id is not null then 'Separei para você até ' || private.fmt_when(r.expires_at) || '.' else 'Quer que eu separe?' end,
                now() + interval '4 hours', 'interest:' || a.id) returning id into v_task;
      end if;
    exception when others then raise warning 'avise-me % falhou: %', a.id, sqlerrm;
    end;
  end loop;
  return null;
end $$;
create trigger trg_interest_on_stock after insert or update of on_hand, reserved on inv.stock_levels for each row execute function private.interest_on_stock();

-- ---------------------------------------------------------------------
-- 3) Ferramenta da IA: register_interest (produto + tamanho, da cliente do ctx)
-- ---------------------------------------------------------------------
create or replace function agent.t_register_interest(c omni.conversations, a jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x crm.interest_alerts; v_prod uuid := nullif(a ->> 'product_id', '')::uuid;
begin
  if v_prod is null or coalesce(trim(a ->> 'size'), '') = '' then return jsonb_build_object('ok', false, 'error', 'Informe product_id e size', 'code', 'INVALID'); end if;
  begin
    x := private.add_interest(c.org_id, c.party_id, v_prod, a ->> 'size', null, a ->> 'note', 'AI');
  exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm, 'code', 'INVALID');
  end;
  update crm.interest_alerts set created_by = null where id = x.id;
  return jsonb_build_object('ok', true, 'alert_id', x.id, 'size', x.size, 'message', 'Pedido registrado: quando o tamanho chegar a cliente é avisada (não prometa data).');
end $$;
revoke execute on function agent.t_register_interest(omni.conversations, jsonb) from public, anon, authenticated;
grant execute on function agent.t_register_interest(omni.conversations, jsonb) to agent_rpc, service_role;

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
      when 'register_interest' then agent.t_register_interest(c, v_args)
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

insert into private.internal_functions (fqname) values ('private.add_interest'), ('private.interest_cfg'), ('private.interest_on_stock') on conflict do nothing;
select private.lock_functions();
