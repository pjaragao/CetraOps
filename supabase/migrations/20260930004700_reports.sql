-- =====================================================================
-- Relatórios: consultas de leitura para a tela Relatórios (vendas por canal/vendedor/período, curva ABC e cruzamento vendas × nota × maquininha).
-- Só leitura, respeitam a permissão de quem pede. "Venda" = pedido pago ou além (pago, em separação, entregue, devolvido em parte).
-- Códigos de erro: P0280 parâmetro inválido.
-- =====================================================================

-- Vendas agrupadas: por canal, vendedor, dia ou mês (receita, descontos, ticket médio e margem sobre o custo registrado)
create or replace function sales.report_sales(p_from date, p_to date, p_group text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('sales.read');
  if p_group not in ('channel', 'seller', 'day', 'month') then raise exception 'Agrupe por canal, vendedor, dia ou mês' using errcode = 'P0280'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'Período inválido (no máximo 1 ano)' using errcode = 'P0280'; end if;
  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.sort_key) from (
      select case p_group when 'channel' then o.channel::text when 'seller' then coalesce(m.display_name, 'Sem vendedor')
                          when 'day' then to_char((o.created_at at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD') else to_char((o.created_at at time zone 'America/Sao_Paulo')::date, 'YYYY-MM') end as label,
             case when p_group in ('day', 'month') then 0 else -sum(o.total) end as sort_key,
             count(*) as orders, sum(o.total) as revenue, sum(o.discount_total) as discount, round(avg(o.total), 2) as avg_ticket,
             sum(o.total - o.cost_total) as margin, case when sum(o.total) > 0 then round(100 * sum(o.total - o.cost_total) / sum(o.total), 1) else null end as margin_pct
      from sales.orders o left join core.members m on m.id = o.seller_member_id
      where o.org_id = v_org and o.status::text = any (v_paid) and (o.created_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
      group by 1
    ) x), '[]'::jsonb);
end $$;

-- Curva ABC por produto, tamanho ou categoria (A = os que somam 80% da receita, B = até 95%, C = o resto)
create or replace function sales.report_abc(p_from date, p_to date, p_by text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('sales.read');
  if p_by not in ('product', 'size', 'category') then raise exception 'Agrupe por produto, tamanho ou categoria' using errcode = 'P0280'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'Período inválido (no máximo 1 ano)' using errcode = 'P0280'; end if;
  return coalesce((
    with base as (
      select case p_by when 'product' then p.name when 'size' then coalesce(v.size, '—') else coalesce(c.name, 'Sem categoria') end as label, sum(i.qty) as qty, sum(i.total) as revenue
      from sales.order_items i join sales.orders o on o.id = i.order_id join catalog.variants v on v.id = i.variant_id join catalog.products p on p.id = v.product_id left join catalog.categories c on c.id = p.category_id
      where o.org_id = v_org and o.status::text = any (v_paid) and (o.created_at at time zone 'America/Sao_Paulo')::date between p_from and p_to group by 1),
    ranked as (select label, qty, revenue, revenue / nullif(sum(revenue) over (), 0) as share, sum(revenue) over (order by revenue desc, label) / nullif(sum(revenue) over (), 0) as cumulative from base)
    select jsonb_agg(jsonb_build_object('label', label, 'qty', qty, 'revenue', revenue, 'share_pct', round(100 * share, 1), 'cumulative_pct', round(100 * cumulative, 1),
                                        'class', case when cumulative - share < 0.80 then 'A' when cumulative - share < 0.95 then 'B' else 'C' end) order by revenue desc, label) from ranked), '[]'::jsonb);
end $$;

-- Cruzamento vendas × nota fiscal × maquininha: o que não fecha entre os sistemas
create or replace function fin.report_cross_gaps(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  perform private.require_perm('fin.read');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'Período inválido (no máximo 1 ano)' using errcode = 'P0280'; end if;
  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.day desc, x.kind) from (
      -- venda paga no balcão sem nota autorizada (há mais de 1 hora)
      select 'VENDA_SEM_NOTA' as kind, o.number as ref, (o.created_at at time zone 'America/Sao_Paulo')::date as day, o.total as amount, 'Pedido pago sem NFC-e/NF-e autorizada' as detail
      from sales.orders o where o.org_id = v_org and o.channel = 'POS' and o.status::text = any (v_paid) and o.created_at < now() - interval '1 hour'
        and (o.created_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
        and not exists (select 1 from fiscal.documents d where d.order_id = o.id and d.status = 'AUTHORIZED')
      union all
      -- nota de saída autorizada sem pedido
      select 'NOTA_SEM_VENDA', 'Nota ' || d.number || '/' || d.series, (d.issue_at at time zone 'America/Sao_Paulo')::date, coalesce((d.totals ->> 'vNF')::numeric, 0), 'Nota autorizada sem pedido, devolução ou transferência ligados'
      from fiscal.documents d where d.org_id = v_org and d.direction = 'OUT' and d.status = 'AUTHORIZED' and d.order_id is null and d.return_id is null and d.transfer_id is null
        and (d.issue_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
      union all
      -- cartão no sistema sem a transação da adquirente (há mais de 3 dias)
      select 'CARTAO_SEM_ADQUIRENTE', o.number, (p.created_at at time zone 'America/Sao_Paulo')::date, p.amount, 'Pagamento em cartão sem transação importada da adquirente'
      from sales.payments p join sales.orders o on o.id = p.order_id
      where p.org_id = v_org and p.method in ('CREDIT', 'DEBIT') and p.status in ('CAPTURED', 'PAID', 'CONFIRMED', 'APPROVED') and p.created_at < now() - interval '3 days'
        and (p.created_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
        and not exists (select 1 from fin.acquirer_transactions t where t.payment_id = p.id)
      union all
      -- transação da adquirente sem venda no sistema
      select 'ADQUIRENTE_SEM_VENDA', t.acquirer || ' ' || t.external_id, (t.captured_at at time zone 'America/Sao_Paulo')::date, t.gross, 'Transação da maquininha sem venda correspondente'
      from fin.acquirer_transactions t where t.org_id = v_org and t.match_status = 'UNMATCHED' and (t.captured_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
    ) x), '[]'::jsonb);
end $$;

select private.lock_functions();
