-- =====================================================================
-- Clientes › Ciclo de vida (plano de marketing e atendimento, Fase 1).
-- Motor que recalcula, toda noite e a cada compra: métricas de compra (12 meses), segmento RFM, sinal "em risco",
-- estágio (Cliente/VIP/Inativa/Perdida) e nível (VIP automático; VIP Black só manual), além do score de lead com explicação.
-- Limiares em core.settings 'lifecycle' (editáveis na tela; padrão = proposta do plano). Toda mudança vai para a linha do tempo.
-- Também: ficha da cliente editável (crm.update_profile) e aceite registrado pela equipe com evidência (crm.set_consent).
-- Códigos de erro: P0300 dado inválido · P0301 situação não permite · P0302 não encontrado.
-- =====================================================================

alter table crm.parties add column if not exists tier_manual boolean not null default false;   -- nível definido à mão não é recalculado

create table crm.customer_metrics (
  party_id uuid primary key references crm.parties(id) on delete cascade,
  org_id uuid not null references core.orgs(id),
  orders_total int not null default 0,
  revenue_total numeric(14, 2) not null default 0,
  orders_12m int not null default 0,
  revenue_12m numeric(14, 2) not null default 0,
  first_purchase_at timestamptz,
  last_purchase_at timestamptz,
  avg_interval_days numeric(8, 1),                -- intervalo médio entre compras (2+ compras)
  days_since_last int,
  rfm_segment text not null default 'NONE'
    check (rfm_segment in ('NONE', 'CHAMPION', 'LOYAL', 'NEW', 'NEEDS_ATTENTION', 'ONE_TIMER', 'HIBERNATING', 'LOST')),
  at_risk boolean not null default false,
  at_risk_since timestamptz,
  updated_at timestamptz not null default now()
);
create index customer_metrics_org_seg_idx on crm.customer_metrics (org_id, rfm_segment);
create index customer_metrics_risk_idx on crm.customer_metrics (org_id) where at_risk;

select private.apply_rls('crm', array['customer_metrics'], 'crm.read', 'crm.write');
select private.rpc_only('crm', array['customer_metrics']);

-- ---------------------------------------------------------------------
-- Configuração (core.settings 'lifecycle') com os padrões do plano
-- ---------------------------------------------------------------------
create or replace function private.lifecycle_cfg(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'vip_min_revenue_12m', 2000, 'vip_min_orders_12m', 4, 'at_risk_factor', 1.5, 'at_risk_single_days', 60,
    'inactive_days', 120, 'lost_days', 365, 'prospect_min_score', 40)
    || coalesce((select value from core.settings where org_id = p_org and key = 'lifecycle'), '{}')
$$;

create or replace function crm.save_lifecycle_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); c jsonb; k text;
begin
  perform private.require_perm('core.admin');
  if jsonb_typeof(p) <> 'object' then raise exception 'Configuração inválida' using errcode = 'P0300'; end if;
  c := private.lifecycle_cfg(v_org);
  for k in select jsonb_object_keys(p) loop
    if not c ? k then raise exception 'Parâmetro desconhecido: %', k using errcode = 'P0300'; end if;
    if jsonb_typeof(p -> k) <> 'number' or (p ->> k)::numeric < 0 then raise exception 'Valor inválido para %', k using errcode = 'P0300'; end if;
  end loop;
  c := c || p;
  if (c ->> 'inactive_days')::int <= (c ->> 'at_risk_single_days')::int or (c ->> 'lost_days')::int <= (c ->> 'inactive_days')::int then
    raise exception 'Os prazos precisam crescer: em risco < inativa < perdida' using errcode = 'P0300';
  end if;
  if (c ->> 'at_risk_factor')::numeric < 1 then raise exception 'O fator de risco é pelo menos 1' using errcode = 'P0300'; end if;
  if (c ->> 'prospect_min_score')::int > 100 then raise exception 'Score vai de 0 a 100' using errcode = 'P0300'; end if;
  insert into core.settings (org_id, key, value) values (v_org, 'lifecycle', c)
  on conflict (org_id, key) do update set value = excluded.value;
  perform private.refresh_lifecycle(v_org, null);
  return c;
end $$;

-- ---------------------------------------------------------------------
-- Score de lead (regras v1 do seed + sinais novos), com explicação
-- ---------------------------------------------------------------------
create or replace function private.score_party(p_party uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p crm.parties; r jsonb; w jsonb; items jsonb := '[]'; total int := 0; v_txt text; v_hit text; v_n int;
  v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  select * into p from crm.parties where id = p_party;
  if p.id is null then return jsonb_build_object('score', 0, 'items', '[]'); end if;
  select rules into r from crm.lead_scoring_rules where org_id = p.org_id and active order by version desc limit 1;
  r := coalesce(r, '{}');
  w := jsonb_build_object('profession', 20, 'sports', 20, 'has_contact', 10, 'target_city', 10, 'engaged_conversation', 20, 'purchased', 20,
                          'host_member', 15, 'referral', 10, 'event_attended', 10, 'recent_reply', 10, 'asked_product', 10) || coalesce(r -> 'weights', '{}');

  -- profissão-alvo
  if p.profession is not null then
    select x into v_hit from jsonb_array_elements_text(coalesce(r -> 'professions', '[]')) x where private.norm(p.profession) like '%' || private.norm(x) || '%' limit 1;
    if v_hit is not null then items := items || jsonb_build_object('key', 'profession', 'label', 'Profissão (' || v_hit || ')', 'points', (w ->> 'profession')::int); end if;
  end if;
  -- esporte-alvo (atividades da ficha ou etiquetas)
  v_txt := private.norm(coalesce((select string_agg(a, ' ') from jsonb_array_elements_text(coalesce(p.preferences -> 'activities', '[]')) a), '') || ' ' || array_to_string(p.tags, ' '));
  v_hit := null;
  select x into v_hit from jsonb_array_elements_text(coalesce(r -> 'sports', '[]')) x where v_txt like '%' || private.norm(x) || '%' limit 1;
  if v_hit is not null then items := items || jsonb_build_object('key', 'sports', 'label', 'Pratica ' || v_hit, 'points', (w ->> 'sports')::int); end if;
  -- contato completo
  if exists (select 1 from crm.party_contact_points c where c.party_id = p.id and c.type in ('WHATSAPP', 'PHONE'))
     and p.display_name !~ '^[+0-9 ()-]+$' then
    items := items || jsonb_build_object('key', 'has_contact', 'label', 'Contato completo (nome e telefone)', 'points', (w ->> 'has_contact')::int);
  end if;
  -- cidade-alvo
  if p.city is not null and exists (select 1 from jsonb_array_elements_text(coalesce(r -> 'target_cities', '[]')) x where private.norm(x) = private.norm(p.city)) then
    items := items || jsonb_build_object('key', 'target_city', 'label', 'Cidade-alvo (' || p.city || ')', 'points', (w ->> 'target_city')::int);
  end if;
  -- conversa engajada (3+ mensagens dela em 90 dias)
  select count(*) into v_n from omni.messages m join omni.conversations cv on cv.id = m.conversation_id
  where cv.party_id = p.id and m.direction = 'IN' and m.created_at > now() - interval '90 days';
  if v_n >= 3 then items := items || jsonb_build_object('key', 'engaged_conversation', 'label', 'Conversou com a loja (' || v_n || ' mensagens em 90 dias)', 'points', (w ->> 'engaged_conversation')::int); end if;
  -- respondeu nos últimos 7 dias
  if exists (select 1 from omni.messages m join omni.conversations cv on cv.id = m.conversation_id where cv.party_id = p.id and m.direction = 'IN' and m.created_at > now() - interval '7 days') then
    items := items || jsonb_build_object('key', 'recent_reply', 'label', 'Escreveu nos últimos 7 dias', 'points', (w ->> 'recent_reply')::int);
  end if;
  -- perguntou de produto, tamanho, estoque ou reserva (30 dias)
  if exists (select 1 from omni.conversations cv where cv.party_id = p.id and cv.last_message_at > now() - interval '30 days'
             and cv.intent in ('STOCK', 'PRODUCT_INFO', 'SIZE_GUIDE', 'RESERVATION', 'PAYMENT_LINK', 'LOCKER')) then
    items := items || jsonb_build_object('key', 'asked_product', 'label', 'Perguntou de produto ou tamanho', 'points', (w ->> 'asked_product')::int);
  end if;
  -- comprou
  if exists (select 1 from sales.orders o where o.party_id = p.id and o.status::text = any (v_paid)) then
    items := items || jsonb_build_object('key', 'purchased', 'label', 'Já comprou', 'points', (w ->> 'purchased')::int);
  end if;
  -- aluna da academia parceira (autodeclarada ou confirmada na loja)
  if p.host_member_status <> 'UNKNOWN' then
    items := items || jsonb_build_object('key', 'host_member', 'label', case p.host_member_status when 'CONFIRMED_IN_STORE' then 'Aluna da academia parceira (confirmada)' else 'Aluna da academia parceira (autodeclarada)' end, 'points', (w ->> 'host_member')::int);
  end if;
  -- veio por indicação (afiliada ou cliente)
  if upper(coalesce(p.source, '')) in ('REFERRAL', 'AFFILIATE', 'INDICACAO') or 'indicacao' = any (p.tags)
     or exists (select 1 from sales.orders o join sales.coupons cp on cp.id = o.coupon_id where o.party_id = p.id and cp.affiliate_party_id is not null) then
    items := items || jsonb_build_object('key', 'referral', 'label', 'Veio por indicação', 'points', (w ->> 'referral')::int);
  end if;
  -- foi a um evento
  if exists (select 1 from mkt.event_guests g where g.party_id = p.id and g.rsvp_status = 'ATTENDED') then
    items := items || jsonb_build_object('key', 'event_attended', 'label', 'Foi a um evento', 'points', (w ->> 'event_attended')::int);
  end if;

  select coalesce(sum((x ->> 'points')::int), 0) into total from jsonb_array_elements(items) x;
  return jsonb_build_object('score', least(100, total), 'items', items, 'version', coalesce((select version from crm.lead_scoring_rules where org_id = p.org_id and active order by version desc limit 1), 0),
                            'computed_at', now(), 'hot', coalesce((r #>> '{tiers,hot}')::int, 70), 'warm', coalesce((r #>> '{tiers,warm}')::int, 40));
end $$;

-- ---------------------------------------------------------------------
-- Motor do ciclo de vida. p_party nulo = todas as pessoas da org (ou de todas as orgs se p_org também for nulo).
-- Devolve quantas pessoas mudaram de estágio ou de nível.
-- ---------------------------------------------------------------------
create or replace function private.refresh_lifecycle(p_org uuid default null, p_party uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record; c jsonb; v_org uuid := null; m record; sc jsonb; n int := 0;
  v_stage crm.lifecycle_stage; v_tier crm.tier; v_seg text; v_risk boolean; v_limit numeric;
  v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
  old_risk boolean;
  lbl constant jsonb := '{"LEAD":"Lead","PROSPECT":"Prospect","CUSTOMER":"Cliente","VIP":"VIP","INACTIVE":"Inativa","LOST":"Perdida","STANDARD":"Padrão","VIP_BLACK":"VIP Black"}';
begin
  for r in
    select p.* from crm.parties p
    where (p_org is null or p.org_id = p_org) and (p_party is null or p.id = p_party)
      and p.merged_into_id is null and p.anonymized_at is null
      and not exists (select 1 from crm.party_roles rl where rl.party_id = p.id and rl.role in ('EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK'))
    order by p.org_id
  loop
    if v_org is distinct from r.org_id then v_org := r.org_id; c := private.lifecycle_cfg(v_org); end if;

    select count(*)::int as orders_total, coalesce(sum(o.total), 0) as revenue_total,
           count(*) filter (where o.created_at > now() - interval '12 months')::int as orders_12m,
           coalesce(sum(o.total) filter (where o.created_at > now() - interval '12 months'), 0) as revenue_12m,
           min(o.created_at) as first_at, max(o.created_at) as last_at
    into m from sales.orders o where o.party_id = r.id and o.status::text = any (v_paid);

    sc := private.score_party(r.id);

    v_stage := r.lifecycle_stage; v_tier := r.tier; v_seg := 'NONE'; v_risk := false;
    if m.orders_total = 0 then
      if r.lifecycle_stage = 'LEAD' and (sc ->> 'score')::int >= (c ->> 'prospect_min_score')::int then v_stage := 'PROSPECT'; end if;
    else
      declare
        v_days int := (private.today_sp() - (m.last_at at time zone 'America/Sao_Paulo')::date);
        v_avg numeric := case when m.orders_total >= 2 then extract(epoch from (m.last_at - m.first_at)) / 86400.0 / (m.orders_total - 1) end;
      begin
        if not r.tier_manual then
          v_tier := case when m.revenue_12m >= (c ->> 'vip_min_revenue_12m')::numeric or m.orders_12m >= (c ->> 'vip_min_orders_12m')::int then 'VIP' else 'STANDARD' end;
        end if;
        v_stage := case when v_days >= (c ->> 'lost_days')::int then 'LOST'
                        when v_days >= (c ->> 'inactive_days')::int then 'INACTIVE'
                        when v_tier in ('VIP', 'VIP_BLACK') then 'VIP'
                        else 'CUSTOMER' end;
        v_limit := case when v_avg is not null then greatest(30, v_avg * (c ->> 'at_risk_factor')::numeric) else (c ->> 'at_risk_single_days')::numeric end;
        v_risk := v_stage in ('CUSTOMER', 'VIP') and v_days >= v_limit;
        v_seg := case when v_days > 365 then 'LOST'
                      when v_days > 120 then 'HIBERNATING'
                      when v_days <= 60 and m.orders_12m >= 4 then 'CHAMPION'
                      when v_days <= 90 and m.orders_total >= 2 then 'LOYAL'
                      when v_days <= 45 and m.orders_total = 1 then 'NEW'
                      when m.orders_total >= 2 then 'NEEDS_ATTENTION'
                      else 'ONE_TIMER' end;

        select at_risk into old_risk from crm.customer_metrics where party_id = r.id;
        insert into crm.customer_metrics (party_id, org_id, orders_total, revenue_total, orders_12m, revenue_12m, first_purchase_at, last_purchase_at,
                                          avg_interval_days, days_since_last, rfm_segment, at_risk, at_risk_since, updated_at)
        values (r.id, r.org_id, m.orders_total, m.revenue_total, m.orders_12m, m.revenue_12m, m.first_at, m.last_at, round(v_avg, 1), v_days, v_seg, v_risk,
                case when v_risk then now() end, now())
        on conflict (party_id) do update set orders_total = excluded.orders_total, revenue_total = excluded.revenue_total, orders_12m = excluded.orders_12m,
          revenue_12m = excluded.revenue_12m, first_purchase_at = excluded.first_purchase_at, last_purchase_at = excluded.last_purchase_at,
          avg_interval_days = excluded.avg_interval_days, days_since_last = excluded.days_since_last, rfm_segment = excluded.rfm_segment,
          at_risk = excluded.at_risk, at_risk_since = case when excluded.at_risk then coalesce(crm.customer_metrics.at_risk_since, now()) end, updated_at = now();

        if v_risk and not coalesce(old_risk, false) then
          perform private.timeline(r.org_id, r.id, 'LIFECYCLE', 'crm.customer_metrics', r.id, format('Em risco: %s dias sem comprar (o normal dela é a cada %s dias)', v_days, round(v_limit / (c ->> 'at_risk_factor')::numeric)));
          if v_tier in ('VIP', 'VIP_BLACK') then
            perform core.notify(r.org_id, 'CUSTOMER_AT_RISK', 'VIP em risco: ' || r.display_name || ' está há ' || v_days || ' dias sem comprar',
                                jsonb_build_object('party_id', r.id), case when r.relationship_owner_member_id is null then 'crm.write' end, r.relationship_owner_member_id);
          end if;
        end if;
      end;
    end if;
    if m.orders_total = 0 then delete from crm.customer_metrics where party_id = r.id; end if;

    if v_stage is distinct from r.lifecycle_stage or v_tier is distinct from r.tier or (sc ->> 'score')::int <> r.lead_score or sc -> 'items' is distinct from r.score_breakdown -> 'items' then
      update crm.parties set lifecycle_stage = v_stage, tier = v_tier, lead_score = (sc ->> 'score')::int, score_breakdown = sc where id = r.id;
    end if;
    if v_stage is distinct from r.lifecycle_stage or v_tier is distinct from r.tier then
      perform private.timeline(r.org_id, r.id, 'LIFECYCLE', 'crm.parties', r.id,
        concat_ws(' · ',
          case when v_stage is distinct from r.lifecycle_stage then format('Estágio: %s → %s', lbl ->> r.lifecycle_stage::text, lbl ->> v_stage::text) end,
          case when v_tier is distinct from r.tier then format('Nível: %s → %s', lbl ->> r.tier::text, lbl ->> v_tier::text) end),
        jsonb_build_object('from_stage', r.lifecycle_stage, 'to_stage', v_stage, 'from_tier', r.tier, 'to_tier', v_tier));
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- A cada venda paga (ou cancelada/devolvida) recalcula a pessoa
create or replace function private.lifecycle_on_order() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.party_id is not null and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    perform private.refresh_lifecycle(new.org_id, new.party_id);
  end if;
  return null;
end $$;
create trigger trg_lifecycle_on_order after insert or update of status on sales.orders
  for each row execute function private.lifecycle_on_order();

select cron.schedule('centralops-lifecycle-nightly', '30 6 * * *', $$ select private.refresh_lifecycle(null, null) $$);   -- 03:30 BRT

-- Recalcular na hora (botão da tela)
create or replace function crm.refresh_lifecycle(p_party uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.write');
  if p_party is not null and not exists (select 1 from crm.parties where id = p_party and org_id = private.org_id()) then
    raise exception 'Pessoa não encontrada' using errcode = 'P0302';
  end if;
  return private.refresh_lifecycle(private.org_id(), p_party);
end $$;

-- ---------------------------------------------------------------------
-- Ficha editável
-- p = {display_name?, birth_date?, city?, uf?, profession?, instagram_handle?, email?, sizes?{top,bottom,bra,shoe}, activities?[],
--      notes?, host_member_status?, relationship_owner_member_id?, home_store_id?, tier? ('AUTO'|'STANDARD'|'VIP'|'VIP_BLACK'), tags?[]}
-- Só altera as chaves enviadas. Campo vazio ("") apaga.
-- ---------------------------------------------------------------------
create or replace function crm.update_profile(p_party uuid, p jsonb) returns crm.parties
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); x crm.parties; v_sizes jsonb; v_act jsonb; k text; v_tags text[]; v_owner uuid; v_store uuid; v_email text;
begin
  perform private.require_perm('crm.write');
  select * into x from crm.parties where id = p_party and org_id = v_org and merged_into_id is null and anonymized_at is null for update;
  if x.id is null then raise exception 'Pessoa não encontrada' using errcode = 'P0302'; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'Dados inválidos' using errcode = 'P0300'; end if;

  if p ? 'display_name' then
    if length(trim(p ->> 'display_name')) not between 2 and 120 then raise exception 'Nome: 2 a 120 caracteres' using errcode = 'P0300'; end if;
    x.display_name := trim(p ->> 'display_name');
  end if;
  if p ? 'birth_date' then
    begin x.birth_date := nullif(p ->> 'birth_date', '')::date; exception when others then raise exception 'Data de nascimento inválida' using errcode = 'P0300'; end;
    if x.birth_date is not null and (x.birth_date > current_date - interval '10 years' or x.birth_date < date '1920-01-01') then raise exception 'Data de nascimento fora do esperado' using errcode = 'P0300'; end if;
  end if;
  if p ? 'city' then x.city := nullif(left(trim(p ->> 'city'), 80), ''); end if;
  if p ? 'uf' then
    x.uf := nullif(upper(trim(p ->> 'uf')), '');
    if x.uf is not null and x.uf !~ '^[A-Z]{2}$' then raise exception 'UF inválida' using errcode = 'P0300'; end if;
  end if;
  if p ? 'profession' then x.profession := nullif(left(trim(p ->> 'profession'), 80), ''); end if;
  if p ? 'instagram_handle' then
    x.instagram_handle := nullif(lower(ltrim(trim(p ->> 'instagram_handle'), '@')), '');
    if x.instagram_handle is not null and x.instagram_handle !~ '^[a-z0-9._]{1,30}$' then raise exception 'Instagram inválido' using errcode = 'P0300'; end if;
  end if;
  if p ? 'sizes' then
    if jsonb_typeof(p -> 'sizes') <> 'object' then raise exception 'Tamanhos inválidos' using errcode = 'P0300'; end if;
    v_sizes := '{}';
    for k in select jsonb_object_keys(p -> 'sizes') loop
      if k not in ('top', 'bottom', 'bra', 'shoe') then raise exception 'Tamanho desconhecido: %', k using errcode = 'P0300'; end if;
      if nullif(trim(p -> 'sizes' ->> k), '') is not null then
        if length(trim(p -> 'sizes' ->> k)) > 6 then raise exception 'Tamanho inválido' using errcode = 'P0300'; end if;
        v_sizes := v_sizes || jsonb_build_object(k, upper(trim(p -> 'sizes' ->> k)));
      end if;
    end loop;
    x.sizes := v_sizes;
  end if;
  if p ? 'activities' then
    if jsonb_typeof(p -> 'activities') <> 'array' or jsonb_array_length(p -> 'activities') > 10 then raise exception 'Atividades: até 10' using errcode = 'P0300'; end if;
    select coalesce(jsonb_agg(distinct lower(trim(a))) filter (where trim(a) <> ''), '[]') into v_act from jsonb_array_elements_text(p -> 'activities') a;
    x.preferences := x.preferences || jsonb_build_object('activities', v_act);
  end if;
  if p ? 'notes' then x.preferences := x.preferences || jsonb_build_object('notes', left(coalesce(p ->> 'notes', ''), 500)); end if;
  if p ? 'host_member_status' then
    if p ->> 'host_member_status' not in ('UNKNOWN', 'SELF_DECLARED', 'CONFIRMED_IN_STORE') then raise exception 'Situação de aluna da academia parceira inválida' using errcode = 'P0300'; end if;
    x.host_member_status := p ->> 'host_member_status';
  end if;
  if p ? 'relationship_owner_member_id' then
    v_owner := nullif(p ->> 'relationship_owner_member_id', '')::uuid;
    if v_owner is not null and not exists (select 1 from core.members where id = v_owner and org_id = v_org and status = 'ACTIVE') then raise exception 'Responsável inválida' using errcode = 'P0300'; end if;
    x.relationship_owner_member_id := v_owner;
  end if;
  if p ? 'home_store_id' then
    v_store := nullif(p ->> 'home_store_id', '')::uuid;
    if v_store is not null and not exists (select 1 from core.stores where id = v_store and org_id = v_org) then raise exception 'Loja inválida' using errcode = 'P0300'; end if;
    x.home_store_id := v_store;
  end if;
  if p ? 'tier' then
    if p ->> 'tier' = 'AUTO' then x.tier_manual := false;
    elsif p ->> 'tier' in ('STANDARD', 'VIP', 'VIP_BLACK') then
      -- mudar o nível à mão: só sócios/administração
      if p ->> 'tier' is distinct from x.tier::text then perform private.require_perm('core.admin'); end if;
      x.tier := (p ->> 'tier')::crm.tier; x.tier_manual := true;
    else raise exception 'Nível inválido' using errcode = 'P0300'; end if;
  end if;
  if p ? 'tags' then
    if jsonb_typeof(p -> 'tags') <> 'array' then raise exception 'Etiquetas inválidas' using errcode = 'P0300'; end if;
    v_tags := array(select distinct lower(trim(t)) from jsonb_array_elements_text(p -> 'tags') t where trim(t) <> '');
    if exists (select 1 from unnest(v_tags) t where t !~ '^[a-z0-9][a-z0-9_-]{1,29}$') then raise exception 'Etiqueta: 2 a 30 letras minúsculas, números, _ ou -' using errcode = 'P0300'; end if;
    x.tags := v_tags;
  end if;

  update crm.parties set display_name = x.display_name, birth_date = x.birth_date, city = x.city, uf = x.uf, profession = x.profession,
         instagram_handle = x.instagram_handle, sizes = x.sizes, preferences = x.preferences, host_member_status = x.host_member_status,
         relationship_owner_member_id = x.relationship_owner_member_id, home_store_id = x.home_store_id, tier = x.tier, tier_manual = x.tier_manual, tags = x.tags
  where id = x.id;

  if p ? 'email' and nullif(trim(p ->> 'email'), '') is not null then
    v_email := lower(trim(p ->> 'email'));
    if v_email !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then raise exception 'E-mail inválido' using errcode = 'P0300'; end if;
    if exists (select 1 from crm.party_contact_points where org_id = v_org and type = 'EMAIL' and value_normalized = v_email and party_id <> x.id) then
      raise exception 'Este e-mail já é de outra pessoa (use a mesclagem)' using errcode = 'P0301';
    end if;
    insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary)
    values (v_org, x.id, 'EMAIL', v_email, v_email, not exists (select 1 from crm.party_contact_points where party_id = x.id and type = 'EMAIL'))
    on conflict (org_id, type, value_normalized) do nothing;
  end if;

  perform private.refresh_lifecycle(v_org, x.id);
  select * into x from crm.parties where id = x.id;
  return x;
end $$;

-- Aceite registrado pela equipe (balcão, telefone, evento), com evidência e versão do texto
create or replace function crm.set_consent(p_party uuid, p_purpose crm.consent_purpose, p_granted boolean, p_channel text, p_text_version text default 'v1') returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id();
begin
  perform private.require_perm('crm.write');
  if not exists (select 1 from crm.parties where id = p_party and org_id = v_org) then raise exception 'Pessoa não encontrada' using errcode = 'P0302'; end if;
  if p_purpose = 'TRANSACTIONAL' then raise exception 'O aceite transacional vem do contrato (compra)' using errcode = 'P0300'; end if;
  if coalesce(p_channel, '') not in ('BALCAO', 'TELEFONE', 'EVENTO', 'WHATSAPP', 'INSTAGRAM', 'EMAIL', 'FORMULARIO') then raise exception 'Informe onde o aceite foi dado' using errcode = 'P0300'; end if;
  insert into crm.consents (org_id, party_id, purpose, granted, legal_basis, evidence, recorded_by)
  values (v_org, p_party, p_purpose, p_granted, 'CONSENT',
          jsonb_build_object('channel', p_channel, 'via', 'STAFF', 'text_version', left(coalesce(p_text_version, 'v1'), 20)), private.member_id());
  perform private.timeline(v_org, p_party, 'CONSENT', 'crm.consents', null,
    format('%s %s (%s)', case when p_granted then 'Aceitou' else 'Recusou' end, lower(replace(p_purpose::text, '_', ' ')), lower(p_channel)));
end $$;

-- ---------------------------------------------------------------------
-- Painel do ciclo de vida
-- ---------------------------------------------------------------------
create or replace function crm.lifecycle_overview(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_f timestamptz; v_t timestamptz; res jsonb;
  v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('crm.read');
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Período inválido' using errcode = 'P0300'; end if;
  v_f := (p_from::timestamp at time zone 'America/Sao_Paulo'); v_t := ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo');
  with base as (
    select p.* from crm.parties p
    where p.org_id = v_org and p.merged_into_id is null and p.anonymized_at is null
      and not exists (select 1 from crm.party_roles rl where rl.party_id = p.id and rl.role in ('EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK'))
  ), ord as (
    select o.party_id, o.created_at, o.total, row_number() over (partition by o.party_id order by o.created_at) as n
    from sales.orders o join base b on b.id = o.party_id where o.status::text = any (v_paid)
  ), mv as (
    select (e.payload ->> 'from_stage') as fs, (e.payload ->> 'to_stage') as ts, (e.payload ->> 'to_tier') as tt, (e.payload ->> 'from_tier') as ft
    from crm.timeline_events e where e.org_id = v_org and e.kind = 'LIFECYCLE' and e.source_type = 'crm.parties' and e.occurred_at >= v_f and e.occurred_at < v_t
  )
  select jsonb_build_object(
    'stages', (select coalesce(jsonb_object_agg(s, n), '{}') from (select lifecycle_stage::text as s, count(*) as n from base group by 1) x),
    'tiers', (select coalesce(jsonb_object_agg(s, n), '{}') from (select tier::text as s, count(*) as n from base group by 1) x),
    'segments', (select coalesce(jsonb_object_agg(s, n), '{}') from (select m.rfm_segment as s, count(*) as n from crm.customer_metrics m join base b on b.id = m.party_id group by 1) x),
    'at_risk', (select count(*) from crm.customer_metrics m join base b on b.id = m.party_id where m.at_risk),
    'funnel', jsonb_build_object(
      'new_leads', (select count(*) from base where created_at >= v_f and created_at < v_t),
      'qualified', (select count(*) from base where created_at >= v_f and created_at < v_t and lead_score >= (private.lifecycle_cfg(v_org) ->> 'prospect_min_score')::int),
      'first_purchases', (select count(*) from ord where n = 1 and created_at >= v_f and created_at < v_t),
      'second_purchases', (select count(*) from ord where n = 2 and created_at >= v_f and created_at < v_t),
      'repeat_orders', (select count(*) from ord where n >= 2 and created_at >= v_f and created_at < v_t),
      'became_vip', (select count(*) from mv where tt = 'VIP' and ft is distinct from 'VIP' and ft is distinct from 'VIP_BLACK'),
      'became_inactive', (select count(*) from mv where ts = 'INACTIVE'),
      'became_lost', (select count(*) from mv where ts = 'LOST'),
      'reactivated', (select count(*) from mv where fs in ('INACTIVE', 'LOST') and ts in ('CUSTOMER', 'VIP'))),
    'revenue', jsonb_build_object(
      'total', (select coalesce(sum(total), 0) from ord where created_at >= v_f and created_at < v_t),
      'repeat', (select coalesce(sum(total), 0) from ord where n >= 2 and created_at >= v_f and created_at < v_t)),
    'consent_whatsapp', jsonb_build_object(
      'customers', (select count(*) from base where lifecycle_stage in ('CUSTOMER', 'VIP', 'INACTIVE')),
      'granted', (select count(*) from base b join crm.v_current_consents c on c.party_id = b.id and c.purpose = 'MARKETING_WHATSAPP' and c.granted
                  where b.lifecycle_stage in ('CUSTOMER', 'VIP', 'INACTIVE'))),
    'second_purchase_90d', (
      select jsonb_build_object('cohort', count(*), 'returned', count(*) filter (where exists (select 1 from ord o2 where o2.party_id = f.party_id and o2.n = 2 and o2.created_at <= f.created_at + interval '90 days')))
      from ord f where f.n = 1 and f.created_at >= v_f - interval '90 days' and f.created_at < v_t - interval '90 days'),
    'avg_interval_days', (select round(avg(m.avg_interval_days), 0) from crm.customer_metrics m join base b on b.id = m.party_id where m.avg_interval_days is not null),
    'settings', private.lifecycle_cfg(v_org)
  ) into res;
  return res;
end $$;

insert into private.internal_functions (fqname) values ('private.refresh_lifecycle'), ('private.score_party'), ('private.lifecycle_cfg'), ('private.lifecycle_on_order')
on conflict do nothing;

-- Primeira carga
select private.refresh_lifecycle(null, null);
select private.lock_functions();
