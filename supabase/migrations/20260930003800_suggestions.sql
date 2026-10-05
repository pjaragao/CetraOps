-- =====================================================================
-- Inteligência › Central de sugestões: a caixa de decisões — o sistema aponta o que merece atenção e a pessoa resolve ou ignora (com registro).
-- Detectores de anomalia rodam à noite no banco (regras simples e explicáveis, sem IA): estoque negativo, diferença de caixa, desconto fora do padrão,
-- cancelamentos em série, queda de vendas e venda com margem negativa. Cada achado tem uma chave: o mesmo problema não vira duas sugestões abertas.
-- Códigos de erro: P0210 dado inválido · P0211 situação não permite · P0212 não encontrado.
-- =====================================================================

create unique index if not exists suggestions_open_key_uq on ai.suggestions (org_id, (payload ->> 'key')) where status = 'OPEN' and payload ? 'key';
alter table ai.suggestions add column if not exists decision_note text;
create trigger trg_audit_suggestions after update on ai.suggestions for each row execute function private.audit_capture();

-- Abre uma sugestão. Devolve true quando criou. Não repete o que já foi tratado:
--   • fato pontual (p_recurring = false: desconto, caixa, cancelamentos…): uma vez decidida, nunca volta;
--   • situação que pode voltar (p_recurring = true: estoque negativo): reabre depois de resolvida, mas "ignorar" silencia por 30 dias.
create or replace function private.open_suggestion(p_org uuid, p_kind text, p_key text, p_rule text, p_severity text, p_title text, p_detail text, p_href text,
                                                   p_target_type text default null, p_target uuid default null, p_extra jsonb default '{}', p_recurring boolean default false) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if exists (select 1 from ai.suggestions x where x.org_id = p_org and x.payload ->> 'key' = p_key and (x.status = 'OPEN'
        or (not p_recurring and x.status in ('ACCEPTED', 'DISMISSED', 'AUTO_APPLIED'))
        or (p_recurring and x.status = 'DISMISSED' and x.decided_at > now() - interval '30 days'))) then
    return false;
  end if;
  insert into ai.suggestions (org_id, kind, target_type, target_id, payload, confidence)
  values (p_org, p_kind, p_target_type, p_target, jsonb_build_object('key', p_key, 'rule', p_rule, 'severity', p_severity, 'title', p_title, 'detail', p_detail, 'href', p_href) || coalesce(p_extra, '{}'), 1)
  on conflict (org_id, (payload ->> 'key')) where status = 'OPEN' and payload ? 'key' do nothing
  returning id into v_id;
  if v_id is not null and p_severity = 'HIGH' then
    perform core.notify(p_org, 'SUGGESTION', p_title, jsonb_build_object('suggestion_id', v_id), 'ai.write', null);
  end if;
  return v_id is not null;
end $$;

-- ---------------------------------------------------------------------
-- Detectores (todos idempotentes: rodar de novo não duplica). Devolve quantas sugestões novas abriu.
-- ---------------------------------------------------------------------
create or replace function private.detect_anomalies() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record; n int := 0; v_today date := private.today_sp(); v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
  v_yest_rev numeric; v_avg numeric; v_from timestamptz; v_to timestamptz;
begin
  -- 1) Estoque negativo (some sozinho quando o saldo volta a ser positivo)
  for r in select sl.org_id, sl.variant_id, sl.location_id, sl.on_hand, v.sku, l.kind from inv.stock_levels sl join catalog.variants v on v.id = sl.variant_id join inv.locations l on l.id = sl.location_id where sl.on_hand < 0 loop
    if private.open_suggestion(r.org_id, 'ANOMALY', 'NEG_STOCK:' || r.variant_id || ':' || r.location_id, 'NEGATIVE_STOCK', 'HIGH', 'Estoque negativo: ' || r.sku,
         format('O saldo de %s está em %s unidades. Geralmente é venda sem a entrada da compra ou transferência não recebida: confira e ajuste (contagem ou recebimento).', r.sku, r.on_hand), '/produtos/estoque', 'catalog.variants', r.variant_id, '{}', true) then n := n + 1; end if;
  end loop;
  update ai.suggestions s set status = 'AUTO_APPLIED', decided_at = now(), decision_note = 'Saldo voltou a ser positivo'
  where s.status = 'OPEN' and s.payload ->> 'rule' = 'NEGATIVE_STOCK'
    and not exists (select 1 from inv.stock_levels sl where sl.on_hand < 0 and 'NEG_STOCK:' || sl.variant_id || ':' || sl.location_id = s.payload ->> 'key');

  -- 2) Diferença no fechamento do caixa (últimos 2 dias)
  for r in select cs.org_id, cs.id, cs.difference, cs.closed_at, cs.store_id from sales.cash_sessions cs where cs.status = 'CLOSED' and cs.closed_at >= now() - interval '2 days' and abs(coalesce(cs.difference, 0)) >= 5 loop
    if private.open_suggestion(r.org_id, 'ANOMALY', 'CASH_DIFF:' || r.id, 'CASH_DIFFERENCE', case when abs(r.difference) >= 50 then 'HIGH' else 'MEDIUM' end,
         format('Caixa fechou com diferença de R$ %s', to_char(r.difference, 'FM999990.00')), 'O valor contado não bate com o esperado. Confira sangrias, suprimentos e vendas em dinheiro do turno.', '/vender/caixa', 'sales.cash_sessions', r.id) then n := n + 1; end if;
  end loop;

  -- 3) Desconto fora do padrão (acima de 25% da venda, últimos 2 dias)
  for r in select o.org_id, o.id, o.number, o.discount_total, o.subtotal from sales.orders o where o.created_at >= now() - interval '2 days' and o.status::text = any (v_paid) and o.subtotal > 0 and o.discount_total / o.subtotal > 0.25 loop
    if private.open_suggestion(r.org_id, 'ANOMALY', 'DISCOUNT:' || r.id, 'DISCOUNT_OUTLIER', 'MEDIUM', format('Desconto alto no pedido %s (%s%%)', r.number, round(100 * r.discount_total / r.subtotal)),
         'Desconto acima de 25% do valor da venda. Confirme se estava autorizado.', '/vender/pedidos/' || r.id, 'sales.orders', r.id) then n := n + 1; end if;
  end loop;

  -- 4) Cancelamentos em série: 4 ou mais pelo mesmo vendedor em 7 dias
  for r in select o.org_id, o.seller_member_id, count(*) as c, m.display_name from sales.orders o join core.members m on m.id = o.seller_member_id
           where o.status = 'CANCELLED' and o.created_at >= now() - interval '7 days' group by o.org_id, o.seller_member_id, m.display_name having count(*) >= 4 loop
    if private.open_suggestion(r.org_id, 'ANOMALY', 'CANCELS:' || r.seller_member_id || ':' || to_char(v_today, 'IYYY-IW'), 'CANCELLATIONS', 'MEDIUM', format('%s cancelamentos de %s em 7 dias', r.c, r.display_name),
         'Muitos cancelamentos pela mesma pessoa. Pode ser erro de digitação ou algo a orientar.', '/vender/pedidos?status=CANCELLED', 'core.members', r.seller_member_id) then n := n + 1; end if;
  end loop;

  -- 5) Queda de vendas: ontem abaixo de 50% da média do mesmo dia da semana nas 4 semanas anteriores (só se a média passa de R$ 500)
  for r in select distinct o.org_id from sales.orders o where o.created_at >= now() - interval '40 days' loop
    v_from := ((v_today - 1)::timestamp at time zone 'America/Sao_Paulo'); v_to := (v_today::timestamp at time zone 'America/Sao_Paulo');
    select coalesce(sum(total), 0) into v_yest_rev from sales.orders where org_id = r.org_id and status::text = any (v_paid) and created_at >= v_from and created_at < v_to;
    select coalesce(avg(day_rev), 0) into v_avg from (
      select coalesce(sum(o.total), 0) as day_rev from generate_series(1, 4) w
      left join sales.orders o on o.org_id = r.org_id and o.status::text = any (v_paid) and o.created_at >= ((v_today - 1 - 7 * w)::timestamp at time zone 'America/Sao_Paulo') and o.created_at < ((v_today - 7 * w)::timestamp at time zone 'America/Sao_Paulo')
      group by w) d;
    if v_avg > 500 and v_yest_rev < 0.5 * v_avg then
      if private.open_suggestion(r.org_id, 'ANOMALY', 'SALES_DROP:' || (v_today - 1), 'SALES_DROP', 'MEDIUM', format('Vendas de ontem: R$ %s (média desse dia da semana: R$ %s)', to_char(v_yest_rev, 'FM999G990'), to_char(v_avg, 'FM999G990')),
           'Ontem vendeu menos da metade do normal para esse dia da semana. Vale ver o que mudou (loja fechada, sem estoque, campanha).', '/inicio') then n := n + 1; end if;
    end if;
  end loop;

  -- 6) Venda com margem negativa (valor abaixo do custo, últimos 2 dias)
  for r in select o.org_id, o.id, o.number, o.total, o.cost_total from sales.orders o where o.created_at >= now() - interval '2 days' and o.status::text = any (v_paid) and o.cost_total > 0 and o.total < o.cost_total loop
    if private.open_suggestion(r.org_id, 'ANOMALY', 'NEG_MARGIN:' || r.id, 'NEGATIVE_MARGIN', 'HIGH', format('Pedido %s vendido abaixo do custo', r.number),
         format('Vendido por R$ %s com custo de R$ %s. Confira preço, desconto e custo dos itens.', to_char(r.total, 'FM999990.00'), to_char(r.cost_total, 'FM999990.00')), '/vender/pedidos/' || r.id, 'sales.orders', r.id) then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Decidir: resolvida (ACCEPTED) ou ignorar (DISMISSED, com motivo). Quem ignora fica registrado.
-- ---------------------------------------------------------------------
create or replace function ai.decide_suggestion(p_id uuid, p_status text, p_note text default null) returns ai.suggestions
language plpgsql security definer set search_path = '' as $$
declare s ai.suggestions; v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  perform private.require_perm('ai.write');
  if p_status not in ('ACCEPTED', 'DISMISSED') then raise exception 'Situação inválida' using errcode = 'P0210'; end if;
  if p_status = 'DISMISSED' and (v_note is null or length(v_note) < 3) then raise exception 'Diga por que está ignorando' using errcode = 'P0210'; end if;
  update ai.suggestions set status = p_status, decided_by = private.member_id(), decided_at = now(), decision_note = v_note where id = p_id and org_id = private.org_id() and status = 'OPEN' returning * into s;
  if s.id is null then raise exception 'Sugestão não encontrada ou já decidida' using errcode = 'P0212'; end if;
  return s;
end $$;

-- "Verificar agora": roda os detectores na hora (a rotina noturna faz o mesmo)
create or replace function ai.run_detectors() returns integer
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('ai.write');
  return private.detect_anomalies();
end $$;

select cron.schedule('centralops-detect-anomalies', '0 9 * * *', $$ select private.detect_anomalies() $$);        -- 06:00 BRT, depois do fechamento do dia

insert into private.internal_functions (fqname) values ('private.open_suggestion'), ('private.detect_anomalies') on conflict do nothing;
select private.lock_functions();
