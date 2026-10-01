-- =====================================================================
-- Atendimento › Avisos automáticos e retomada de vendas paradas (plano de marketing e atendimento, Fase 2).
-- Avisos transacionais: pagamento confirmado, pronto para retirar, enviado (rastreio), Armário VIP pronto, reserva vencendo,
-- lembrete do link de pagamento, vale-troca gerado e lembrete de evento. Cada aviso: texto livre se a janela de 24 h está aberta;
-- fora dela, o template de UTILIDADE escolhido; sem template, vira tarefa para a equipe. Nasce desligado; um aviso por fato.
-- Retomada: link vencido sem pagamento, pedido remoto expirado e armário devolvido sem compra viram tarefa com mensagem pronta.
-- Códigos de erro: P0330 dado inválido · P0331 situação não permite · P0332 não encontrado.
-- =====================================================================

create table omni.notice_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  event text not null check (event in ('ORDER_PAID', 'READY_FOR_PICKUP', 'SHIPPED', 'LOCKER_READY', 'RESERVATION_EXPIRING', 'PAYMENT_LINK_REMINDER', 'STORE_CREDIT_ISSUED', 'EVENT_REMINDER')),
  active boolean not null default false,
  channel_account_id uuid references omni.channel_accounts(id),
  free_text text not null,
  template_id uuid references omni.templates(id),
  template_vars jsonb not null default '[]',
  task_fallback boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (org_id, event)
);

create table omni.notices_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  event text not null,
  source_id uuid not null,
  party_id uuid not null references crm.parties(id) on delete cascade,
  status text not null check (status in ('SENT_TEXT', 'SENT_TEMPLATE', 'TASK', 'SKIPPED')),
  reason text,
  conversation_id uuid references omni.conversations(id) on delete set null,
  message_id uuid references omni.messages(id) on delete set null,
  task_id uuid references crm.tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, event, source_id, party_id)
);
create index notices_log_recent_idx on omni.notices_log (org_id, created_at desc);

select private.attach_updated_at('omni');
select private.apply_rls('omni', array['notice_rules', 'notices_log'], 'omni.read', 'omni.write');
select private.rpc_only('omni', array['notice_rules', 'notices_log']);

-- Texto padrão de cada aviso ({nome}, {pedido}, {prazo}, {codigo}, {rastreio}, {link}, {evento}, {valor})
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
  end
$$;

-- Cadastro: p = {event, active, channel_account_id?, free_text?, template_id?, template_vars?, task_fallback?}
create or replace function omni.save_notice_rule(p jsonb) returns omni.notice_rules
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_event text := upper(coalesce(p ->> 'event', '')); r omni.notice_rules; t omni.templates; v_text text; v_acc uuid; v_tpl uuid; v_vars jsonb;
begin
  perform private.require_perm('omni.write');
  if private.notice_default_text(v_event) is null then raise exception 'Aviso inválido' using errcode = 'P0330'; end if;
  v_text := coalesce(nullif(trim(p ->> 'free_text'), ''), private.notice_default_text(v_event));
  if length(v_text) > 600 then raise exception 'Texto do aviso: até 600 caracteres' using errcode = 'P0330'; end if;
  v_acc := nullif(p ->> 'channel_account_id', '')::uuid;
  if v_acc is not null and not exists (select 1 from omni.channel_accounts where id = v_acc and org_id = v_org and channel = 'WHATSAPP') then raise exception 'Escolha um número de WhatsApp' using errcode = 'P0330'; end if;
  v_tpl := nullif(p ->> 'template_id', '')::uuid;
  if v_tpl is not null then
    select * into t from omni.templates where id = v_tpl and org_id = v_org;
    if t.id is null then raise exception 'Template não encontrado' using errcode = 'P0332'; end if;
    if t.category <> 'UTILITY' then raise exception 'Aviso transacional usa template de UTILIDADE (marketing exige aceite e é outra coisa)' using errcode = 'P0331'; end if;
  end if;
  v_vars := coalesce(p -> 'template_vars', '[]');
  if jsonb_typeof(v_vars) <> 'array' or exists (select 1 from jsonb_array_elements_text(v_vars) x where x not in ('FIRST_NAME', 'ORDER_NUMBER', 'DEADLINE', 'LOCKER_CODE', 'TRACKING', 'LINK_URL', 'EVENT_NAME', 'AMOUNT')) then
    raise exception 'Variáveis do template inválidas' using errcode = 'P0330';
  end if;
  insert into omni.notice_rules (org_id, event, active, channel_account_id, free_text, template_id, template_vars, task_fallback)
  values (v_org, v_event, coalesce((p ->> 'active')::boolean, false), v_acc, v_text, v_tpl, v_vars, coalesce((p ->> 'task_fallback')::boolean, true))
  on conflict (org_id, event) do update set active = excluded.active, channel_account_id = excluded.channel_account_id, free_text = excluded.free_text,
    template_id = excluded.template_id, template_vars = excluded.template_vars, task_fallback = excluded.task_fallback
  returning * into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- Disparo de um aviso (interno). p_vars = {pedido, prazo, codigo, rastreio, link, evento, valor}
-- ---------------------------------------------------------------------
create or replace function private.dispatch_notice(p_org uuid, p_event text, p_party uuid, p_source uuid, p_vars jsonb default '{}') returns text
language plpgsql security definer set search_path = '' as $$
declare
  r omni.notice_rules; v_log bigint; v_name text; v_first text; v_text text; v_wa text; v_acc uuid; v_conv uuid; w record; v_msg uuid; t omni.templates; v_body text;
  v_params jsonb := '[]'; x text; i int := 0; v_task uuid; v jsonb := coalesce(p_vars, '{}');
begin
  select * into r from omni.notice_rules where org_id = p_org and event = p_event and active;
  if r.id is null or p_party is null then return 'NO_RULE'; end if;
  insert into omni.notices_log (org_id, event, source_id, party_id, status) values (p_org, p_event, p_source, p_party, 'SKIPPED')
  on conflict (org_id, event, source_id, party_id) do nothing returning id into v_log;
  if v_log is null then return 'DUPLICATE'; end if;

  select display_name into v_name from crm.parties where id = p_party and anonymized_at is null;
  if v_name is null then update omni.notices_log set reason = 'ANONYMIZED' where id = v_log; return 'SKIPPED'; end if;
  v_first := split_part(v_name, ' ', 1);
  v_text := replace(replace(replace(replace(replace(replace(replace(replace(r.free_text,
              '{nome}', v_first), '{pedido}', coalesce(v ->> 'pedido', '')), '{prazo}', coalesce(v ->> 'prazo', '')), '{codigo}', coalesce(v ->> 'codigo', '')),
              '{rastreio}', coalesce(v ->> 'rastreio', '')), '{link}', coalesce(v ->> 'link', '')), '{evento}', coalesce(v ->> 'evento', '')), '{valor}', coalesce(v ->> 'valor', ''));

  v_wa := private.party_wa_id(p_party);
  v_acc := coalesce(r.channel_account_id, (select id from omni.channel_accounts where org_id = p_org and channel = 'WHATSAPP' and status = 'ACTIVE' order by created_at limit 1));
  if v_wa is not null and v_acc is not null then
    v_conv := private.ensure_wa_conversation(v_acc, p_party, v_wa);
  end if;
  if v_conv is not null then
    select * into w from omni.check_send_window(v_conv, 'AI');
    if w.allowed and w.mode = 'FREE_FORM' then
      v_msg := omni.queue_system_message(v_conv, v_text);
      update omni.notices_log set status = 'SENT_TEXT', conversation_id = v_conv, message_id = v_msg where id = v_log;
      return 'SENT_TEXT';
    end if;
    select * into t from omni.templates where id = r.template_id and status = 'APPROVED' and category = 'UTILITY' and channel_account_id = v_acc;
    if t.id is not null then
      v_body := (select c2 ->> 'text' from jsonb_array_elements(t.components) c2 where c2 ->> 'type' = 'BODY' limit 1);
      for x in select jsonb_array_elements_text(r.template_vars) loop
        i := i + 1;
        v_params := v_params || to_jsonb(coalesce(case x when 'FIRST_NAME' then v_first when 'ORDER_NUMBER' then v ->> 'pedido' when 'DEADLINE' then v ->> 'prazo'
                                                   when 'LOCKER_CODE' then v ->> 'codigo' when 'TRACKING' then v ->> 'rastreio' when 'LINK_URL' then v ->> 'link'
                                                   when 'EVENT_NAME' then v ->> 'evento' when 'AMOUNT' then v ->> 'valor' end, '-'));
        v_body := replace(v_body, '{{' || i || '}}', v_params ->> (i - 1));
      end loop;
      insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, type, body, template_name, status, client_dedupe_key, payload)
      values (p_org, v_conv, v_acc, 'OUT', 'SYSTEM', 'TEMPLATE', v_body, t.name, 'QUEUED', 'notice:' || p_event || ':' || p_source || ':' || p_party,
              jsonb_build_object('language', t.language, 'template_id', t.id, 'notice', p_event,
                'components', case when jsonb_array_length(v_params) = 0 then '[]'::jsonb
                                   else jsonb_build_array(jsonb_build_object('type', 'body', 'parameters', (select jsonb_agg(jsonb_build_object('type', 'text', 'text', z #>> '{}')) from jsonb_array_elements(v_params) z))) end))
      on conflict (client_dedupe_key) where client_dedupe_key is not null do nothing
      returning id into v_msg;
      if v_msg is not null then perform private.enqueue('outbound_messages', jsonb_build_object('message_id', v_msg, 'org_id', p_org)); end if;
      update omni.notices_log set status = 'SENT_TEMPLATE', conversation_id = v_conv, message_id = v_msg where id = v_log;
      return 'SENT_TEMPLATE';
    end if;
  end if;
  if r.task_fallback then
    insert into crm.tasks (org_id, party_id, type, title, suggested_message, due_at, source_rule)
    values (p_org, p_party, 'FOLLOW_UP', 'Avisar ' || v_first || ': ' || lower(replace(p_event, '_', ' ')), v_text, now() + interval '4 hours', 'notice:' || p_event)
    returning id into v_task;
    update omni.notices_log set status = 'TASK', task_id = v_task, conversation_id = v_conv,
      reason = case when v_wa is null then 'NO_WHATSAPP' when v_conv is null then 'NO_CONVERSATION' else 'WINDOW_CLOSED_NO_TEMPLATE' end where id = v_log;
    return 'TASK';
  end if;
  update omni.notices_log set reason = case when v_wa is null then 'NO_WHATSAPP' else 'WINDOW_CLOSED_NO_TEMPLATE' end, conversation_id = v_conv where id = v_log;
  return 'SKIPPED';
end $$;

create or replace function private.fmt_when(p_at timestamptz) returns text
language sql stable as $$ select to_char(p_at at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24"h"MI') $$;

-- ---------------------------------------------------------------------
-- Gatilhos dos fatos (um erro aqui nunca derruba a venda)
-- ---------------------------------------------------------------------
create or replace function private.notice_on_order() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_track text;
begin
  if new.party_id is null or new.status is not distinct from old.status then return null; end if;
  begin
    if new.status = 'PAID' and new.channel <> 'POS' then
      perform private.dispatch_notice(new.org_id, 'ORDER_PAID', new.party_id, new.id, jsonb_build_object('pedido', new.number));
    elsif new.status = 'READY_FOR_PICKUP' then
      perform private.dispatch_notice(new.org_id, 'READY_FOR_PICKUP', new.party_id, new.id, jsonb_build_object('pedido', new.number));
    elsif new.status = 'SHIPPED' then
      select tracking into v_track from sales.shipments where order_id = new.id order by created_at desc limit 1;
      perform private.dispatch_notice(new.org_id, 'SHIPPED', new.party_id, new.id, jsonb_build_object('pedido', new.number, 'rastreio', coalesce(v_track, 'enviamos em seguida')));
    elsif new.status = 'CANCELLED' and old.status = 'PENDING_PAYMENT' and coalesce(new.notes, '') like '%Expirado sem pagamento%' and new.channel <> 'POS' then
      perform private.recovery_task(new.org_id, new.party_id, 'ORDER_EXPIRED', new.id,
        'Retomar venda: pedido ' || new.number || ' expirou sem pagamento',
        'Oi! Vi que o pedido ' || new.number || ' ficou sem pagamento. Quer que eu gere um link novo ou separe para você provar na loja?');
    end if;
  exception when others then
    raise warning 'aviso do pedido % falhou: %', new.id, sqlerrm;
  end;
  return null;
end $$;

create or replace function private.notice_on_locker() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if new.party_id is null then return null; end if;
  begin
    if tg_op = 'INSERT' then
      select code into v_code from inv.lockers where id = new.locker_id;
      perform private.dispatch_notice(new.org_id, 'LOCKER_READY', new.party_id, new.id, jsonb_build_object('codigo', v_code, 'prazo', private.fmt_when(new.expires_at)));
    elsif new.outcome in ('RETURNED', 'PARTIAL', 'EXPIRED') and old.outcome = 'PENDING' then
      perform private.recovery_task(new.org_id, new.party_id, 'LOCKER_' || new.outcome, new.id,
        case new.outcome when 'PARTIAL' then 'Armário: levou só parte — entender o que não serviu' when 'RETURNED' then 'Armário devolvido sem compra — entender o motivo' else 'Armário venceu sem retirada — retomar' end,
        'Oi! Vi que algumas peças do armário não ficaram com você. Me conta o que não funcionou (tamanho, cor, modelo)? Posso separar outra opção.');
    end if;
  exception when others then
    raise warning 'aviso do armário % falhou: %', new.id, sqlerrm;
  end;
  return null;
end $$;

create or replace function private.notice_on_credit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.amount > 0 and new.reason in ('RETURN', 'GOODWILL', 'AFFILIATE_COMMISSION') then
    begin
      perform private.dispatch_notice(new.org_id, 'STORE_CREDIT_ISSUED', new.party_id, new.id, jsonb_build_object('valor', 'R$ ' || to_char(new.amount, 'FM999G990D00')));
    exception when others then raise warning 'aviso de vale-troca falhou: %', sqlerrm; end;
  end if;
  return null;
end $$;

-- Tarefa de retomada (uma por fato), com a dona do relacionamento como responsável
create or replace function private.recovery_task(p_org uuid, p_party uuid, p_kind text, p_source uuid, p_title text, p_message text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_owner uuid;
begin
  if p_party is null or exists (select 1 from crm.tasks where source_rule = 'recovery:' || p_kind || ':' || p_source) then return null; end if;
  select relationship_owner_member_id into v_owner from crm.parties where id = p_party;
  insert into crm.tasks (org_id, party_id, assignee_member_id, type, title, suggested_message, due_at, source_rule)
  values (p_org, p_party, v_owner, 'RECOVERY', p_title, p_message, now() + interval '24 hours', 'recovery:' || p_kind || ':' || p_source)
  returning id into v_id;
  perform private.timeline(p_org, p_party, 'RECOVERY', 'crm.tasks', v_id, p_title);
  return v_id;
end $$;

create trigger trg_notice_on_order after update of status on sales.orders for each row execute function private.notice_on_order();
create trigger trg_notice_on_locker after insert or update of outcome on sales.locker_drops for each row execute function private.notice_on_locker();
create trigger trg_notice_on_credit after insert on sales.store_credit_ledger for each row execute function private.notice_on_credit();

-- ---------------------------------------------------------------------
-- Varredura a cada 15 min: reserva vencendo (6 h), link sem pagamento (2 h; vencido → retomada) e evento amanhã
-- ---------------------------------------------------------------------
create or replace function private.sweep_notices() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select rs.id, rs.org_id, rs.party_id, rs.expires_at from inv.reservations rs
           where rs.status = 'ACTIVE' and rs.party_id is not null and rs.expires_at between now() and now() + interval '6 hours' and rs.created_at < now() - interval '2 hours' loop
    if private.dispatch_notice(r.org_id, 'RESERVATION_EXPIRING', r.party_id, r.id, jsonb_build_object('prazo', private.fmt_when(r.expires_at))) in ('SENT_TEXT', 'SENT_TEMPLATE', 'TASK') then n := n + 1; end if;
  end loop;
  for r in select pl.id, o.org_id, o.party_id, o.number, pl.url, pl.status, pl.expires_at from sales.payment_links pl join sales.orders o on o.id = pl.order_id
           where pl.status in ('CREATED', 'SENT') and o.party_id is not null and pl.url is not null and pl.created_at < now() - interval '2 hours' and pl.created_at > now() - interval '3 days' loop
    if private.dispatch_notice(r.org_id, 'PAYMENT_LINK_REMINDER', r.party_id, r.id, jsonb_build_object('pedido', r.number, 'link', r.url)) in ('SENT_TEXT', 'SENT_TEMPLATE', 'TASK') then n := n + 1; end if;
  end loop;
  for r in select pl.id, o.org_id, o.party_id, o.number from sales.payment_links pl join sales.orders o on o.id = pl.order_id
           where pl.status = 'EXPIRED' and o.party_id is not null and o.status <> 'PAID' and pl.expires_at > now() - interval '3 days' loop
    if private.recovery_task(r.org_id, r.party_id, 'LINK_EXPIRED', r.id, 'Retomar venda: link do pedido ' || r.number || ' venceu sem pagamento',
         'Oi! O link do pedido ' || r.number || ' venceu. Quer que eu mande um novo ou prefere pagar na loja?') is not null then n := n + 1; end if;
  end loop;
  for r in select g.id, g.org_id, g.party_id, e.name, e.starts_at from mkt.event_guests g join mkt.events e on e.id = g.event_id
           where g.rsvp_status = 'CONFIRMED' and e.status in ('PLANNED', 'CONFIRMED') and e.starts_at between now() + interval '18 hours' and now() + interval '30 hours' loop
    if private.dispatch_notice(r.org_id, 'EVENT_REMINDER', r.party_id, r.id, jsonb_build_object('evento', r.name, 'prazo', 'às ' || to_char(r.starts_at at time zone 'America/Sao_Paulo', 'HH24"h"MI'))) in ('SENT_TEXT', 'SENT_TEMPLATE', 'TASK') then n := n + 1; end if;
  end loop;
  return n;
end $$;
select cron.schedule('sie-sweep-notices', '*/15 * * * *', $$ select private.sweep_notices() $$);

-- ---------------------------------------------------------------------
-- Vendas recuperadas: pedidos pagos até 7 dias depois de um aviso de reserva/link ou de uma tarefa de retomada
-- ---------------------------------------------------------------------
create or replace function sales.report_recovered(p_from date, p_to date) returns table (kind text, attempts int, recovered int, revenue numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_f timestamptz; v_t timestamptz;
  v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('sales.read');
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Período inválido' using errcode = 'P0330'; end if;
  v_f := (p_from::timestamp at time zone 'America/Sao_Paulo'); v_t := ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo');
  return query
    with a as (
      select l.event as k, l.party_id, l.created_at as at from omni.notices_log l
      where l.org_id = v_org and l.event in ('RESERVATION_EXPIRING', 'PAYMENT_LINK_REMINDER') and l.status <> 'SKIPPED' and l.created_at >= v_f and l.created_at < v_t
      union all
      select split_part(t.source_rule, ':', 2), t.party_id, t.created_at from crm.tasks t
      where t.org_id = v_org and t.source_rule like 'recovery:%' and t.created_at >= v_f and t.created_at < v_t
    ), w as (
      select a.k, a.party_id, a.at, (select o.total from sales.orders o where o.party_id = a.party_id and o.status::text = any (v_paid) and o.created_at > a.at and o.created_at <= a.at + interval '7 days' order by o.created_at limit 1) as total
      from a
    )
    select w.k, count(*)::int, count(w.total)::int, coalesce(sum(w.total), 0) from w group by w.k order by 2 desc;
end $$;

insert into private.internal_functions (fqname) values
  ('private.dispatch_notice'), ('private.notice_on_order'), ('private.notice_on_locker'), ('private.notice_on_credit'), ('private.recovery_task'), ('private.sweep_notices')
on conflict do nothing;
select private.lock_functions();
