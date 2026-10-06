-- =====================================================================
-- Central › resumo do dia (briefing da manhã). O banco monta os números de cada pessoa conforme as permissões dela (quem não vê o
-- financeiro não recebe contas); o Início mostra o resumo e a Central conversa sobre ele (ferramenta resumo_do_dia). Sem IA, o resumo
-- continua saindo: são só números do banco, com o link de cada assunto.
-- Aviso diário opcional (assistant_policies.daily_briefing_notify): às 08:00 de Brasília, uma notificação "Resumo do dia" para quem usa a Central.
-- =====================================================================

update core.settings set value = value || '{"daily_briefing_notify": true}'::jsonb
where key = 'assistant_policies' and not (value ? 'daily_briefing_notify');

-- Itens: {key, count?, amount?, compare_amount?, tone, href}. O texto é montado na tela (e pela Central), não aqui.
create or replace function ai.daily_briefing() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_me uuid := private.member_id(); v_today date := private.today_sp();
  v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
  items jsonb := '[]'; n int; v numeric; v2 numeric; n2 int;
begin
  if v_org is null or v_me is null then raise exception 'Sem acesso' using errcode = '42501'; end if;

  if private.has_perm('sales.read') then
    select count(*), coalesce(sum(total), 0) into n, v from sales.orders
    where org_id = v_org and status::text = any (v_paid) and (created_at at time zone 'America/Sao_Paulo')::date = v_today - 1;
    select coalesce(sum(total), 0) into v2 from sales.orders
    where org_id = v_org and status::text = any (v_paid) and (created_at at time zone 'America/Sao_Paulo')::date = v_today - 8;
    items := items || jsonb_build_object('key', 'vendas_ontem', 'count', n, 'amount', v, 'compare_amount', v2, 'tone', case when v < v2 then 'warning' else 'neutral' end, 'href', '/relatorios/vendas');
    select s.difference into v from sales.cash_sessions s
    where s.org_id = v_org and s.status = 'CLOSED' and (s.closed_at at time zone 'America/Sao_Paulo')::date >= v_today - 1 and coalesce(s.difference, 0) <> 0
    order by s.closed_at desc limit 1;
    if v is not null then items := items || jsonb_build_object('key', 'caixa_diferenca', 'amount', v, 'tone', 'danger', 'href', '/vender/caixa'); end if;
  end if;

  if private.has_perm('fin.read') then
    select count(*), coalesce(sum(i.amount - i.amount_settled), 0) into n, v from fin.title_installments i join fin.titles t on t.id = i.title_id
    where i.org_id = v_org and t.direction = 'PAYABLE' and i.status in ('OPEN', 'PARTIAL') and t.status not in ('CANCELLED', 'RENEGOTIATED') and i.due_date = v_today;
    select count(*), coalesce(sum(i.amount - i.amount_settled), 0) into n2, v2 from fin.title_installments i join fin.titles t on t.id = i.title_id
    where i.org_id = v_org and t.direction = 'PAYABLE' and i.status in ('OPEN', 'PARTIAL') and t.status not in ('CANCELLED', 'RENEGOTIATED') and i.due_date < v_today;
    if n > 0 then items := items || jsonb_build_object('key', 'pagar_hoje', 'count', n, 'amount', v, 'tone', 'warning', 'href', '/financeiro/pagar'); end if;
    if n2 > 0 then items := items || jsonb_build_object('key', 'pagar_vencidas', 'count', n2, 'amount', v2, 'tone', 'danger', 'href', '/financeiro/pagar'); end if;
    select count(*) into n from fin.title_installments i join fin.titles t on t.id = i.title_id
    where i.org_id = v_org and t.direction = 'PAYABLE' and t.approval_status <> 'APPROVED' and i.status in ('OPEN', 'PARTIAL') and t.status not in ('CANCELLED', 'RENEGOTIATED')
      and i.due_date <= v_today + 3;
    if n > 0 then items := items || jsonb_build_object('key', 'sem_aprovacao', 'count', n, 'tone', 'warning', 'href', '/financeiro/pagar'); end if;
    select count(*), coalesce(sum(i.amount - i.amount_settled - i.fee_expected), 0) into n, v from fin.title_installments i join fin.titles t on t.id = i.title_id
    where i.org_id = v_org and t.direction = 'RECEIVABLE' and i.status in ('OPEN', 'PARTIAL') and t.status not in ('CANCELLED', 'RENEGOTIATED') and coalesce(i.expected_date, i.due_date) = v_today;
    if n > 0 then items := items || jsonb_build_object('key', 'receber_hoje', 'count', n, 'amount', v, 'tone', 'neutral', 'href', '/financeiro/receber'); end if;
  end if;

  if private.has_perm('fiscal.read') then
    select count(*), coalesce(sum(amount), 0) into n, v from fiscal.obligations where org_id = v_org and status = 'PENDING' and due_date <= v_today + 7;
    if n > 0 then items := items || jsonb_build_object('key', 'obrigacoes', 'count', n, 'amount', v, 'tone', 'warning', 'href', '/fiscal/obrigacoes'); end if;
  end if;

  if private.has_perm('inv.read') then
    select count(*) into n from (
      select v1.id from catalog.variants v1
      where v1.org_id = v_org and v1.active
        and exists (select 1 from sales.order_items oi join sales.orders o on o.id = oi.order_id where oi.variant_id = v1.id and o.status::text = any (v_paid) and o.created_at > now() - interval '30 days')
        and coalesce((select sum(sl.available) from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable where sl.variant_id = v1.id), 0) <= 1) x;
    if n > 0 then items := items || jsonb_build_object('key', 'estoque_critico', 'count', n, 'tone', 'warning', 'href', '/produtos/reposicao'); end if;
  end if;

  if private.has_perm('omni.read') then
    select count(*) into n from omni.conversations where org_id = v_org and mode = 'WAITING_HUMAN' and status <> 'CLOSED';
    if n > 0 then items := items || jsonb_build_object('key', 'conversas_aguardando', 'count', n, 'tone', 'warning', 'href', '/atendimento?filtro=aguardando'); end if;
  end if;

  if private.has_perm('crm.read') then
    select count(*) into n from crm.daily_actions(50);
    if n > 0 then items := items || jsonb_build_object('key', 'contatar_hoje', 'count', n, 'tone', 'neutral', 'href', '/inicio'); end if;
    select count(*) into n from crm.tasks where org_id = v_org and assignee_member_id = v_me and status = 'OPEN' and due_at < now();
    if n > 0 then items := items || jsonb_build_object('key', 'tarefas_atrasadas', 'count', n, 'tone', 'danger', 'href', '/clientes/tarefas'); end if;
    select count(*) into n from crm.parties p
    where p.org_id = v_org and p.merged_into_id is null and p.archived_at is null and p.birth_date is not null
      and extract(month from p.birth_date) = extract(month from v_today) and extract(day from p.birth_date) = extract(day from v_today)
      and exists (select 1 from crm.party_roles r where r.party_id = p.id and r.role = 'CUSTOMER');
    if n > 0 then items := items || jsonb_build_object('key', 'aniversariantes', 'count', n, 'tone', 'neutral', 'href', '/clientes'); end if;
    select count(*) into n from mkt.events where org_id = v_org and status in ('PLANNED', 'CONFIRMED')
      and (starts_at at time zone 'America/Sao_Paulo')::date between v_today and v_today + 7;
    if n > 0 then items := items || jsonb_build_object('key', 'eventos_semana', 'count', n, 'tone', 'neutral', 'href', '/marketing/eventos'); end if;
  end if;

  if private.has_perm('ai.read') then
    select count(*) into n from ai.suggestions where org_id = v_org and status = 'OPEN' and payload ->> 'severity' = 'HIGH';
    if n > 0 then items := items || jsonb_build_object('key', 'alertas', 'count', n, 'tone', 'danger', 'href', '/ia'); end if;
  end if;

  return jsonb_build_object('date', v_today, 'items', items);
end $$;

-- 08:00 de Brasília: avisa quem usa a Central que o resumo do dia está no Início (uma notificação por pessoa por dia)
create or replace function private.notify_daily_briefing() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select s.org_id from core.settings s where s.key = 'assistant_policies' and coalesce((s.value ->> 'daily_briefing_notify')::boolean, false)
             and coalesce((select enabled from core.feature_flags f where f.org_id = s.org_id and f.key = 'ai.assistant'), true) loop
    if not exists (select 1 from core.notifications x where x.org_id = r.org_id and x.kind = 'BRIEFING' and x.created_at > now() - interval '20 hours') then
      n := n + core.notify(r.org_id, 'BRIEFING', 'Seu resumo do dia está no Início', jsonb_build_object('date', private.today_sp()), 'ai.assistant', null);
    end if;
  end loop;
  return n;
end $$;
select cron.schedule('centralops-daily-briefing', '0 11 * * *', $$ select private.notify_daily_briefing() $$);   -- 08:00 BRT

insert into private.internal_functions (fqname) values ('private.notify_daily_briefing') on conflict do nothing;
select private.lock_functions();
