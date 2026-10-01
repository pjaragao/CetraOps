-- =====================================================================
-- Endurecimento de privilégios de funções.
--
-- O PostgreSQL concede EXECUTE a PUBLIC em toda função nova, e `alter default privileges ... in schema` NÃO desfaz esse padrão
-- (só o global desfaria, o que quebraria extensões como pgTAP). Resultado: os `revoke ... from authenticated` espalhados pelas
-- migrations não tinham efeito e qualquer usuário logado podia chamar via /rpc funções internas (finalizar pedido, jobs, numeração).
--
-- Regra daqui em diante: toda migration que cria função termina com `select private.lock_functions();`.
-- Um teste pgTAP (008) falha se sobrar função com EXECUTE para PUBLIC nos schemas expostos.
-- =====================================================================

-- Funções de leitura chamadas por telas passam a respeitar a organização do token (service_role continua sem filtro)
create or replace function catalog.current_price(p_variant uuid, p_price_list uuid default null) returns numeric
language sql stable security definer set search_path = '' as $$
  with v as (select id, product_id, org_id from catalog.variants where id = p_variant and org_id = coalesce(private.org_id(), org_id)),
       pl as (
         select coalesce(p_price_list, (select l.id from catalog.price_lists l, v where l.org_id = v.org_id and l.is_default)) as id
       )
  select p.price from catalog.prices p, v, pl
  where p.price_list_id = pl.id
    and (p.variant_id = v.id or p.product_id = v.product_id)
    and p.valid_from <= now() and (p.valid_to is null or p.valid_to > now())
  order by (p.variant_id is not null) desc, p.valid_from desc
  limit 1
$$;

create or replace function sales.store_credit_balance(p_party uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount), 0) from sales.store_credit_ledger where party_id = p_party and org_id = coalesce(private.org_id(), org_id)
$$;

create or replace function sales.cash_session_expected(p_session uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select s.opening_float + coalesce((select sum(m.amount) from sales.cash_session_movements m where m.session_id = s.id), 0)
  from sales.cash_sessions s where s.id = p_session and s.org_id = coalesce(private.org_id(), s.org_id)
$$;

create or replace function fin.expected_fee_rate(p_org uuid, p_acquirer text, p_method text, p_installments integer, p_mode text, p_on date default current_date)
returns numeric language sql stable security definer set search_path = '' as $$
  select rate from fin.acquirer_fee_plans
  where org_id = p_org and p_org = coalesce(private.org_id(), p_org)
    and acquirer = p_acquirer and method = p_method and anticipation_mode = p_mode
    and p_installments between inst_from and inst_to
    and valid_from <= p_on and (valid_to is null or valid_to >= p_on)
  order by valid_from desc limit 1
$$;

-- omni.check_send_window: mesma lógica, agora restrita à organização do token
create or replace function omni.check_send_window(p_conversation uuid, p_author text)
returns table (allowed boolean, mode text, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare
  c record;
  v_elapsed interval;
  v_tiktok boolean;
begin
  select cv.last_inbound_at, ca.channel, cv.org_id into c
  from omni.conversations cv join omni.channel_accounts ca on ca.id = cv.channel_account_id
  where cv.id = p_conversation and cv.org_id = coalesce(private.org_id(), cv.org_id);
  v_elapsed := case when c.last_inbound_at is null then interval '100 years' else now() - c.last_inbound_at end;

  if c.channel = 'WHATSAPP' then
    if v_elapsed <= interval '24 hours' then return query select true, 'FREE_FORM', null::text;
    else return query select false, 'TEMPLATE_ONLY', 'Janela de 24h do WhatsApp fechada: use um template aprovado'; end if;
  elsif c.channel = 'INSTAGRAM' then
    if v_elapsed <= interval '24 hours' then return query select true, 'FREE_FORM', null::text;
    elsif v_elapsed <= interval '7 days' and p_author = 'HUMAN' then return query select true, 'HUMAN_AGENT_TAG', null::text;
    elsif v_elapsed <= interval '7 days' then return query select false, 'BLOCKED', 'Entre 24h e 7 dias só um humano pode responder';
    else return query select false, 'BLOCKED', 'Janela do Instagram encerrada (mais de 7 dias)'; end if;
  elsif c.channel = 'TELEGRAM' then
    if c.last_inbound_at is not null then return query select true, 'FREE_FORM', null::text;
    else return query select false, 'BLOCKED', 'O bot só fala com quem iniciou a conversa'; end if;
  else
    select enabled into v_tiktok from core.feature_flags where org_id = c.org_id and key = 'channel.tiktok';
    if coalesce(v_tiktok, false) and v_elapsed <= interval '48 hours' then return query select true, 'FREE_FORM', null::text;
    else return query select false, 'BLOCKED', 'Canal TikTok indisponível'; end if;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Trava: EXECUTE só para authenticated/service_role nas RPCs; internas só para service_role
-- ---------------------------------------------------------------------
create or replace function private.lock_functions() returns void
language plpgsql security definer set search_path = '' as $$
declare
  s text; r record;
  -- funções que só o servidor (service_role/worker/cron) ou outras funções security definer podem chamar
  internal text[] := array[
    'core.next_number', 'crm.resolve_identity', 'hr.roll_vacation_status', 'inv.expire_reservations',
    'sales.expire_locker_drops', 'sales.expire_pending_orders', 'sales.finalize_order'];
begin
  foreach s in array array['core', 'crm', 'catalog', 'inv', 'sales', 'fin', 'fiscal', 'omni', 'ai', 'hr', 'comm', 'purch'] loop
    execute format('revoke execute on all functions in schema %I from public, anon', s);
    execute format('grant execute on all functions in schema %I to authenticated, service_role', s);
  end loop;
  for r in select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname || '.' || p.proname = any (internal) loop
    execute format('revoke execute on function %s from authenticated', r.fn);
  end loop;
end $$;
revoke execute on function private.lock_functions() from public, anon, authenticated;

select private.lock_functions();
