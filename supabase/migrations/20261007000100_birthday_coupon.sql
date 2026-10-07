-- =====================================================================
-- Aniversariantes: lista no Início → Clientes e cupom de aniversário automático.
--   • crm.birthday_party_ids(): mesma regra do resumo do dia; a lista de clientes filtra por ela (?aniversario=hoje|mes).
--   • Cupom pessoal: sales.coupons.party_id restringe o uso a uma pessoa (prévia e fechamento do pedido).
--   • A régua "Aniversário" gera um cupom por aniversariante (config trigger_config.coupon = {enabled, percent, valid_days, min_order?})
--     e a mensagem usa {cupom}, {desconto} e {validade_cupom}. Padrão: 5% por 30 dias, editável na régua. Grupo de controle zero.
-- =====================================================================

alter table sales.coupons add column party_id uuid references crm.parties(id);          -- cupom pessoal: só esta pessoa usa
create index coupons_party_idx on sales.coupons (party_id) where party_id is not null;
alter table mkt.journey_enrollments add column coupon_id uuid references sales.coupons(id) on delete set null;

-- ---------------------------------------------------------------------
-- 1) Cupom pessoal vale só para a pessoa
-- ---------------------------------------------------------------------
create or replace function private.check_coupon_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c sales.coupons; v_total int; v_party int;
begin
  select * into c from sales.coupons where id = new.coupon_id;
  if c.party_id is not null and new.party_id is distinct from c.party_id then
    raise exception 'O cupom % é pessoal: vale só para a cliente que o recebeu', c.code using errcode = 'P0008';
  end if;
  select count(*) into v_total from sales.coupon_redemptions r join sales.orders o on o.id = r.order_id
    where r.coupon_id = c.id and r.id is distinct from new.id and o.status <> 'CANCELLED';
  if c.max_uses is not null and v_total >= c.max_uses then
    raise exception 'Cupom % esgotado (limite de % usos)', c.code, c.max_uses using errcode = 'P0008';
  end if;
  if c.per_customer_limit is not null and new.party_id is not null then
    select count(*) into v_party from sales.coupon_redemptions r join sales.orders o on o.id = r.order_id
      where r.coupon_id = c.id and r.party_id = new.party_id and r.id is distinct from new.id and o.status <> 'CANCELLED';
    if v_party >= c.per_customer_limit then
      raise exception 'Este cliente já usou o cupom % o máximo de vezes (%)', c.code, c.per_customer_limit using errcode = 'P0008';
    end if;
  end if;
  return new;
end $$;

create or replace function private.coupon_preview(p_org uuid, p_code text, p_subtotal numeric, p_party uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c sales.coupons; v_disc numeric; v_total int; v_party int;
begin
  select * into c from sales.coupons where org_id = p_org and upper(code) = upper(p_code) and active and valid_from <= now() and (valid_to is null or valid_to > now());
  if c.id is null then return jsonb_build_object('valid', false, 'reason', 'Cupom inválido ou expirado'); end if;
  if c.party_id is not null and p_party is distinct from c.party_id then
    return jsonb_build_object('valid', false, 'reason', case when p_party is null then 'Cupom pessoal: identifique a cliente antes' else 'Cupom pessoal de outra cliente' end);
  end if;
  if c.min_order is not null and p_subtotal < c.min_order then
    return jsonb_build_object('valid', false, 'reason', format('Pedido mínimo de R$ %s', c.min_order));
  end if;
  select count(*) into v_total from sales.coupon_redemptions r join sales.orders o on o.id = r.order_id where r.coupon_id = c.id and o.status <> 'CANCELLED';
  if c.max_uses is not null and v_total >= c.max_uses then return jsonb_build_object('valid', false, 'reason', 'Cupom esgotado'); end if;
  if c.per_customer_limit is not null and p_party is not null then
    select count(*) into v_party from sales.coupon_redemptions r join sales.orders o on o.id = r.order_id
      where r.coupon_id = c.id and r.party_id = p_party and o.status <> 'CANCELLED';
    if v_party >= c.per_customer_limit then return jsonb_build_object('valid', false, 'reason', 'Cliente já usou este cupom'); end if;
  end if;
  v_disc := round(case when c.kind = 'PERCENT' then p_subtotal * c.value / 100 else least(c.value, p_subtotal) end, 2);
  return jsonb_build_object('valid', true, 'discount', v_disc, 'kind', c.kind, 'value', c.value, 'affiliate', c.affiliate_party_id is not null);
end $$;

-- ---------------------------------------------------------------------
-- 2) Aniversariantes (clientes) de hoje ou do mês — a lista de clientes e o resumo do dia usam a mesma regra
-- ---------------------------------------------------------------------
create or replace function crm.birthday_party_ids(p_scope text default 'today') returns setof uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_today date := private.today_sp();
begin
  perform private.require_perm('crm.read');
  if p_scope not in ('today', 'month') then raise exception 'Escolha hoje ou mês' using errcode = 'P0150'; end if;
  return query
    select p.id from crm.parties p
    where p.org_id = v_org and p.merged_into_id is null and p.archived_at is null and p.birth_date is not null
      and extract(month from p.birth_date) = extract(month from v_today)
      and (p_scope = 'month' or extract(day from p.birth_date) = extract(day from v_today))
      and exists (select 1 from crm.party_roles r where r.party_id = p.id and r.role = 'CUSTOMER');
end $$;

do $x$
declare v_def text;
begin
  select pg_get_functiondef('ai.daily_briefing()'::regprocedure) into v_def;
  if position($y$'key', 'aniversariantes', 'count', n, 'tone', 'neutral', 'href', '/clientes')$y$ in v_def) = 0 then raise exception 'daily_briefing mudou: ajuste este patch'; end if;
  v_def := replace(v_def, $y$'key', 'aniversariantes', 'count', n, 'tone', 'neutral', 'href', '/clientes')$y$,
                          $y$'key', 'aniversariantes', 'count', n, 'tone', 'neutral', 'href', '/clientes?aniversario=hoje')$y$);
  execute v_def;
end $x$;

-- ---------------------------------------------------------------------
-- 3) Texto da régua com o cupom pessoal: {cupom} {desconto} {validade_cupom}
--    Cria o cupom na primeira vez que o texto da inscrição é montado (grupo de controle nunca chega aqui).
-- ---------------------------------------------------------------------
create or replace function private.render_journey_text(p_enrollment uuid, p_party uuid, p_text text, p_related uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_txt text := private.render_party_text(p_party, p_text, p_related); e mkt.journey_enrollments; j mkt.journeys; c sales.coupons; cfg jsonb;
  v_days int; v_last date; v_try int := 0;
begin
  select * into e from mkt.journey_enrollments where id = p_enrollment;
  select * into j from mkt.journeys where id = e.journey_id;
  cfg := j.trigger_config -> 'coupon';
  if cfg is null or jsonb_typeof(cfg) <> 'object' or coalesce((cfg ->> 'enabled')::boolean, true) is not true then return v_txt; end if;

  if e.coupon_id is not null then
    select * into c from sales.coupons where id = e.coupon_id;
  end if;
  if c.id is null then
    v_days := coalesce((cfg ->> 'valid_days')::int, 30);
    v_last := private.today_sp() + v_days;
    while c.id is null and v_try < 5 loop
      v_try := v_try + 1;
      insert into sales.coupons (org_id, code, kind, value, party_id, max_uses, per_customer_limit, min_order, valid_to)
      values (e.org_id, 'ANIV-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)), 'PERCENT', coalesce((cfg ->> 'percent')::numeric, 5), p_party, 1, 1,
              nullif(cfg ->> 'min_order', '')::numeric, (v_last + 1)::timestamp at time zone 'America/Sao_Paulo')
      on conflict (org_id, code) do nothing returning * into c;
    end loop;
    if c.id is null then return v_txt; end if;
    update mkt.journey_enrollments set coupon_id = c.id where id = e.id;
  end if;
  v_last := (c.valid_to at time zone 'America/Sao_Paulo')::date - 1;
  return replace(replace(replace(v_txt, '{cupom}', c.code), '{desconto}', replace(trim_scale(c.value)::text, '.', ',') || '%'), '{validade_cupom}', to_char(v_last, 'DD/MM'));
end $$;

do $x$
declare v_def text;
begin
  select pg_get_functiondef('private.run_journeys()'::regprocedure) into v_def;
  if position('private.render_party_text(e.party_id, s.message, private.related_of(e.source_key))' in v_def) = 0
     or position('private.render_party_text(e.party_id, s.title, private.related_of(e.source_key))' in v_def) = 0 then
    raise exception 'run_journeys mudou: ajuste este patch';
  end if;
  v_def := replace(v_def, 'private.render_party_text(e.party_id, s.message, private.related_of(e.source_key))', 'private.render_journey_text(e.id, e.party_id, s.message, private.related_of(e.source_key))');
  v_def := replace(v_def, 'private.render_party_text(e.party_id, s.title, private.related_of(e.source_key))', 'private.render_journey_text(e.id, e.party_id, s.title, private.related_of(e.source_key))');
  execute v_def;

  select pg_get_functiondef('mkt.save_journey(jsonb)'::regprocedure) into v_def;
  if position($y$if coalesce((p ->> 'holdout_pct')::int, 10) not between 0 and 50$y$ in v_def) = 0 then raise exception 'save_journey mudou: ajuste este patch'; end if;
  v_def := replace(v_def, $y$if coalesce((p ->> 'holdout_pct')::int, 10) not between 0 and 50$y$,
    $y$if v_cfg ? 'coupon' and (jsonb_typeof(v_cfg -> 'coupon') <> 'object' or coalesce((v_cfg #>> '{coupon,percent}')::numeric, 5) not between 1 and 100 or coalesce((v_cfg #>> '{coupon,valid_days}')::int, 30) not between 1 and 365) then raise exception 'Cupom: desconto de 1%% a 100%% e validade de 1 a 365 dias' using errcode = 'P0350'; end if;$y$ || chr(10) ||
    $y$  if coalesce((p ->> 'holdout_pct')::int, 10) not between 0 and 50$y$);
  execute v_def;
end $x$;

-- ---------------------------------------------------------------------
-- 4) Régua "Aniversário": 5% por 30 dias, ligada e sem grupo de controle (presente de aniversário não se sorteia).
--    Só mexe na régua que ainda está com o texto padrão; régua personalizada fica como está.
-- ---------------------------------------------------------------------
create or replace function private.seed_birthday_coupon(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare j mkt.journeys;
begin
  select * into j from mkt.journeys where org_id = p_org and key = 'aniversario';
  if j.id is null or j.trigger_config ? 'coupon' then return; end if;
  update mkt.journey_steps set
    title = 'Aniversário de {nome}: cupom de {desconto}',
    message = 'Feliz aniversário, {nome}! 🎂💛 Seu presente: {desconto} de desconto na {loja} com o cupom {cupom}, válido até {validade_cupom}.'
  where journey_id = j.id and position = 1 and message = 'Feliz aniversário, {nome}! 💛 Separamos um mimo para você retirar na loja até {data_limite}.';
  if not found then return; end if;
  update mkt.journeys set trigger_config = trigger_config || '{"coupon": {"enabled": true, "percent": 5, "valid_days": 30}}'::jsonb,
         description = 'Três dias antes: tarefa com a mensagem pronta e um cupom pessoal de aniversário (5% por 30 dias, editável).',
         holdout_pct = 0, active = true
  where id = j.id;
end $$;

create or replace function private.seed_journeys_on_org() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.seed_default_journeys(new.id);
  perform private.seed_occasion_journeys(new.id);
  perform private.seed_birthday_coupon(new.id);
  return null;
end $$;
select private.seed_birthday_coupon(id) from core.orgs;

insert into private.internal_functions (fqname) values ('private.render_journey_text'), ('private.seed_birthday_coupon') on conflict do nothing;
select private.lock_functions();
