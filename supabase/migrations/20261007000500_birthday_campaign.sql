-- =====================================================================
-- Campanha fixa dos aniversariantes (régua "Aniversário").
--   • O cupom pessoal nasce quando a cliente entra na régua (padrão: 10 dias antes do aniversário) e vale até N dias depois (padrão 20).
--     Config: trigger_config = {days_before: 10, coupon: {enabled, percent, days_after, min_order?}}. Tudo editável na tela da régua.
--   • O contato (tarefa de marketing, uma por aniversariante) sai no dia: a espera do 1º passo é igual a "dias antes".
--   • As tarefas da régua de aniversário passam a ter o tipo BIRTHDAY; o resumo do dia leva para essas tarefas.
--   • sales.party_auto_coupon: o cupom vigente da cliente, para entrar sozinho no carrinho (PDV e pedido remoto).
--   • mkt.journey_coupon_report: cupons emitidos, usados, desconto dado e vendas — a medida de eficácia da campanha.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Cupom da régua: criado na entrada, válido até "dias depois" do aniversário
-- ---------------------------------------------------------------------
create or replace function private.ensure_journey_coupon(p_enrollment uuid) returns sales.coupons
language plpgsql security definer set search_path = '' as $$
declare e mkt.journey_enrollments; j mkt.journeys; c sales.coupons; cfg jsonb; v_last date; v_try int := 0;
begin
  select * into e from mkt.journey_enrollments where id = p_enrollment;
  select * into j from mkt.journeys where id = e.journey_id;
  cfg := j.trigger_config -> 'coupon';
  if cfg is null or jsonb_typeof(cfg) <> 'object' or coalesce((cfg ->> 'enabled')::boolean, true) is not true then return null; end if;
  if e.coupon_id is not null then
    select * into c from sales.coupons where id = e.coupon_id;
    return c;
  end if;
  -- aniversário = dia da entrada + "dias antes"; o cupom vai até "dias depois" dele (fim do dia, horário de São Paulo)
  v_last := (e.enrolled_at at time zone 'America/Sao_Paulo')::date + coalesce((j.trigger_config ->> 'days_before')::int, 0) + coalesce((cfg ->> 'days_after')::int, 20);
  while c.id is null and v_try < 5 loop
    v_try := v_try + 1;
    insert into sales.coupons (org_id, code, kind, value, party_id, max_uses, per_customer_limit, min_order, valid_to)
    values (e.org_id, 'ANIV-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)), 'PERCENT', coalesce((cfg ->> 'percent')::numeric, 5), e.party_id, 1, 1,
            nullif(cfg ->> 'min_order', '')::numeric, (v_last + 1)::timestamp at time zone 'America/Sao_Paulo')
    on conflict (org_id, code) do nothing returning * into c;
  end loop;
  if c.id is null then return null; end if;
  update mkt.journey_enrollments set coupon_id = c.id where id = e.id;
  return c;
end $$;

create or replace function private.render_journey_text(p_enrollment uuid, p_party uuid, p_text text, p_related uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_txt text := private.render_party_text(p_party, p_text, p_related); c sales.coupons;
begin
  c := private.ensure_journey_coupon(p_enrollment);
  if c.id is null then return v_txt; end if;
  return replace(replace(replace(v_txt, '{cupom}', c.code), '{desconto}', replace(trim_scale(c.value)::text, '.', ',') || '%'),
                 '{validade_cupom}', to_char((c.valid_to at time zone 'America/Sao_Paulo')::date - 1, 'DD/MM'));
end $$;

do $x$
declare v_def text;
begin
  select pg_get_functiondef('private.run_journeys()'::regprocedure) into v_def;
  if position($y$  -- saída por compra (meta atingida)$y$ in v_def) = 0 or position($y$v_owner, 'JOURNEY',$y$ in v_def) = 0 then raise exception 'run_journeys mudou: ajuste este patch'; end if;
  -- o cupom nasce na entrada (vale desde já), não só quando o passo roda; só para quem é cliente
  v_def := replace(v_def, $y$  -- saída por compra (meta atingida)$y$,
$y$  for e in select en.id from mkt.journey_enrollments en join mkt.journeys jj on jj.id = en.journey_id
           where en.status = 'ACTIVE' and en.grp = 'TREATMENT' and en.coupon_id is null and jj.active and jj.trigger_config ? 'coupon'
             and exists (select 1 from crm.party_roles pr where pr.party_id = en.party_id and pr.role = 'CUSTOMER') limit 500 loop
    perform private.ensure_journey_coupon(e.id);
  end loop;

  -- saída por compra (meta atingida)$y$);
  -- as tarefas da régua de aniversário são do tipo BIRTHDAY (uma por aniversariante)
  v_def := replace(v_def, $y$v_owner, 'JOURNEY',$y$,
    $y$v_owner, case when (select jj.trigger from mkt.journeys jj where jj.id = e.journey_id) = 'BIRTHDAY' then 'BIRTHDAY' else 'JOURNEY' end,$y$);
  execute v_def;

  select pg_get_functiondef('mkt.save_journey(jsonb)'::regprocedure) into v_def;
  if position($y$coalesce((v_cfg #>> '{coupon,valid_days}')::int, 30) not between 1 and 365$y$ in v_def) = 0 then raise exception 'save_journey mudou: ajuste este patch'; end if;
  v_def := replace(v_def, $y$coalesce((v_cfg #>> '{coupon,valid_days}')::int, 30) not between 1 and 365$y$, $y$coalesce((v_cfg #>> '{coupon,days_after}')::int, 20) not between 0 and 365$y$);
  v_def := replace(v_def, $y$e validade de 1 a 365 dias'$y$, $y$e validade de 0 a 365 dias depois do aniversário'$y$);
  execute v_def;

  -- o resumo do dia abre as tarefas de aniversário
  select pg_get_functiondef('ai.daily_briefing()'::regprocedure) into v_def;
  if position($y$'/clientes?aniversario=hoje'$y$ in v_def) = 0 then raise exception 'daily_briefing mudou: ajuste este patch'; end if;
  v_def := replace(v_def, $y$'/clientes?aniversario=hoje'$y$, $y$'/clientes/tarefas?ver=todas&tipo=BIRTHDAY'$y$);
  execute v_def;
end $x$;

-- tarefas já criadas pela régua de aniversário
update crm.tasks t set type = 'BIRTHDAY'
where t.type = 'JOURNEY' and t.source_rule like 'journey:%'
  and exists (select 1 from mkt.journey_enrollments e join mkt.journeys j on j.id = e.journey_id
              where e.id::text = split_part(t.source_rule, ':', 2) and j.trigger = 'BIRTHDAY');

-- ---------------------------------------------------------------------
-- 2) Padrões da campanha: 10 dias antes, até 20 depois, contato no dia do aniversário
-- ---------------------------------------------------------------------
create or replace function private.seed_birthday_coupon(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare j mkt.journeys;
begin
  select * into j from mkt.journeys where org_id = p_org and key = 'aniversario';
  if j.id is null or j.trigger_config ? 'coupon' then return; end if;
  update mkt.journey_steps set
    title = 'Aniversário de {nome}: ligar, dar parabéns e falar do cupom',
    message = 'Feliz aniversário, {nome}! 🎂💛 Seu presente: {desconto} de desconto na {loja} com o cupom {cupom}, válido até {validade_cupom}. Ele já entra sozinho quando você se identifica na compra.',
    wait_days = 10
  where journey_id = j.id and position = 1 and message = 'Feliz aniversário, {nome}! 💛 Separamos um mimo para você retirar na loja até {data_limite}.';
  if not found then return; end if;
  update mkt.journeys set trigger_config = trigger_config || '{"days_before": 10, "coupon": {"enabled": true, "percent": 5, "days_after": 20}}'::jsonb,
         description = 'O cupom pessoal vale 10 dias antes até 20 dias depois do aniversário (5%, tudo editável) e entra sozinho no carrinho. No dia, uma tarefa para dar os parabéns e falar do cupom.',
         holdout_pct = 0, active = true
  where id = j.id;
end $$;

-- organizações que já receberam a versão anterior (3 dias antes, cupom de 30 dias) e não mexeram nela
with j as (
  update mkt.journeys set trigger_config = jsonb_set(jsonb_set(trigger_config, '{days_before}', '10'), '{coupon}', ((trigger_config -> 'coupon') - 'valid_days') || '{"days_after": 20}'),
         description = 'O cupom pessoal vale 10 dias antes até 20 dias depois do aniversário (5%, tudo editável) e entra sozinho no carrinho. No dia, uma tarefa para dar os parabéns e falar do cupom.'
  where key = 'aniversario' and trigger_config #>> '{coupon,valid_days}' = '30' and trigger_config ->> 'days_before' = '3' returning id
)
update mkt.journey_steps s set wait_days = 10,
       title = case when s.title = 'Aniversário de {nome}: cupom de {desconto}' then 'Aniversário de {nome}: ligar, dar parabéns e falar do cupom' else s.title end,
       message = case when s.message like '%válido até {validade_cupom}.' then s.message || ' Ele já entra sozinho quando você se identifica na compra.' else s.message end
from j where s.journey_id = j.id and s.position = 1;

-- ---------------------------------------------------------------------
-- 3) Cupom vigente da cliente (entra sozinho no carrinho)
-- ---------------------------------------------------------------------
create or replace function sales.party_auto_coupon(p_party uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c sales.coupons;
begin
  perform private.require_perm('sales.read');
  select * into c from sales.coupons cp
  where cp.org_id = private.org_id() and cp.party_id = p_party and cp.active and cp.valid_from <= now() and (cp.valid_to is null or cp.valid_to > now())
    and (cp.max_uses is null or (select count(*) from sales.coupon_redemptions r join sales.orders o on o.id = r.order_id where r.coupon_id = cp.id and o.status <> 'CANCELLED') < cp.max_uses)
  order by cp.valid_to nulls last limit 1;
  if c.id is null then return null; end if;
  return jsonb_build_object('code', c.code, 'kind', c.kind, 'value', c.value, 'valid_to', c.valid_to, 'min_order', c.min_order);
end $$;

-- ---------------------------------------------------------------------
-- 4) Eficácia da campanha: emitidos × usados, desconto dado e vendas com o cupom
-- ---------------------------------------------------------------------
create or replace function mkt.journey_coupon_report(p_journey uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); res jsonb;
begin
  perform private.require_perm('crm.read');
  if not exists (select 1 from mkt.journeys where id = p_journey and org_id = v_org) then raise exception 'Régua não encontrada' using errcode = 'P0352'; end if;
  select jsonb_build_object(
    'issued', count(*), 'redeemed', count(*) filter (where coalesce(r.n, 0) > 0),
    'open', count(*) filter (where coalesce(r.n, 0) = 0 and c.active and (c.valid_to is null or c.valid_to > now())),
    'expired', count(*) filter (where coalesce(r.n, 0) = 0 and (not c.active or c.valid_to <= now())),
    'discount', coalesce(sum(r.disc), 0), 'revenue', coalesce(sum(r.rev), 0))
  into res
  from mkt.journey_enrollments e join sales.coupons c on c.id = e.coupon_id
  left join lateral (select count(*) as n, sum(cr.amount) as disc, sum(o.total) as rev from sales.coupon_redemptions cr join sales.orders o on o.id = cr.order_id
                     where cr.coupon_id = c.id and o.status <> 'CANCELLED') r on true
  where e.journey_id = p_journey and e.org_id = v_org;
  return res;
end $$;

insert into private.internal_functions (fqname) values ('private.ensure_journey_coupon') on conflict do nothing;
select private.lock_functions();
