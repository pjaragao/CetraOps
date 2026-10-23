-- =====================================================================
-- Motor de relatórios: a equipe monta relatórios novos (à mão ou descrevendo para a IA) sem escrever SQL.
--  • core.report_datasets / core.report_fields: catálogo FIXO das fontes de dados e dos campos que se pode usar.
--    Só migration escreve aqui; cada campo é uma expressão SQL conhecida. Quem monta o relatório só escolhe chaves.
--  • core.report_run(spec, de, até, loja): monta a consulta a partir das chaves escolhidas (agrupar por, valores,
--    filtros, ordem, limite), sempre na empresa de quem pede, com a permissão da fonte e o acesso às lojas.
--    Valores dos filtros entram como literais (quote_literal) convertidos pelo tipo do campo.
--  • core.saved_reports: relatórios salvos pela equipe (com o pedido feito à IA, se houver). Edita/arquiva quem criou ou o admin.
-- spec = {dataset, dimensions:[chave], measures:[chave], filters:[{field, op, value?, values?}], sort:{field, dir}, limit, use_period}
--   op: eq, neq, contains, gt, gte, lt, lte, in, not_in, empty, not_empty. Filtro em "valor" (medida) vira HAVING.
-- Tipos de campo: text, number, money, percent, date, month (AAAA-MM), boolean.
-- Códigos: P0280 parâmetro inválido (o mesmo dos relatórios prontos) · P0281 sem permissão para editar.
-- =====================================================================

create table core.report_datasets (
  key text primary key,
  label text not null,
  description text not null,
  area text not null,
  perm text not null,
  from_sql text not null,          -- FROM com os joins (aliases usados nas expressões dos campos)
  org_expr text not null,          -- coluna da empresa na tabela principal
  date_expr text,                  -- data (dia em Brasília) que o período da tela filtra; null = foto atual, sem período
  date_label text,
  store_expr text,                 -- loja (para o filtro de loja do topo e o acesso por loja); null = não se aplica
  base_where text,                 -- condição fixa da fonte (ex.: só pedidos pagos)
  position int not null
);

create table core.report_fields (
  dataset text not null references core.report_datasets(key) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  label text not null,
  role text not null check (role in ('dimension', 'measure')),
  type text not null check (type in ('text', 'number', 'money', 'percent', 'date', 'month', 'boolean')),
  sql_expr text not null,
  description text,
  position int not null,
  primary key (dataset, key)
);

alter table core.report_datasets enable row level security;
alter table core.report_fields enable row level security;
revoke all on core.report_datasets, core.report_fields from anon, authenticated;

create table core.saved_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  title text not null check (length(btrim(title)) between 1 and 120),
  description text check (length(description) <= 600),
  dataset text not null references core.report_datasets(key),
  spec jsonb not null,
  prompt text check (length(prompt) <= 2000),
  created_by uuid references core.members(id) on delete set null,
  updated_by uuid references core.members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index on core.saved_reports (org_id, archived_at, title);

-- A pessoa só vê o relatório salvo se puder ler a fonte de dados dele.
create or replace function private.report_dataset_ok(p_dataset text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core.report_datasets d where d.key = p_dataset and private.has_perm(d.perm))
$$;

alter table core.saved_reports enable row level security;
drop policy if exists p_read on core.saved_reports;
create policy p_read on core.saved_reports for select to authenticated
  using (org_id = (select private.org_id()) and archived_at is null and private.report_dataset_ok(dataset));
select private.rpc_only('core', array['saved_reports']);
select private.attach_updated_at('core');

-- ---------------------------------------------------------------------
-- Catálogo de fontes e campos
-- ---------------------------------------------------------------------
do $do$
declare
  -- pedidos pagos ou além (o mesmo critério dos relatórios prontos)
  paid constant text := $s$('PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED')$s$;
  -- rótulos em português (%1$s = expressão)
  ch constant text := $s$case %1$s::text when 'POS' then 'Loja (PDV)' when 'WHATSAPP' then 'WhatsApp' when 'INSTAGRAM' then 'Instagram' when 'TELEGRAM' then 'Telegram' when 'TIKTOK' then 'TikTok' when 'PAYMENT_LINK' then 'Link de pagamento' when 'B2B' then 'Atacado (B2B)' when 'EVENT' then 'Evento' else coalesce(%1$s::text, '—') end$s$;
  stage constant text := $s$case %1$s::text when 'LEAD' then 'Lead' when 'PROSPECT' then 'Em negociação' when 'CUSTOMER' then 'Cliente' when 'VIP' then 'VIP' when 'INACTIVE' then 'Inativa' when 'LOST' then 'Perdida' else coalesce(%1$s::text, '—') end$s$;
  ostatus constant text := $s$case %1$s::text when 'PAID' then 'Pago' when 'FULFILLING' then 'Em separação' when 'READY_FOR_PICKUP' then 'Pronto para retirar' when 'SHIPPED' then 'Enviado' when 'COMPLETED' then 'Concluído' when 'PARTIALLY_RETURNED' then 'Devolvido em parte' else %1$s::text end$s$;
  ful constant text := $s$case %1$s::text when 'TAKEAWAY' then 'Levou na hora' when 'LOCKER_PICKUP' then 'Armário VIP' when 'STORE_PICKUP' then 'Retirada na loja' when 'MOTOBOY' then 'Motoboy' when 'CARRIER' then 'Transportadora' else coalesce(%1$s::text, '—') end$s$;
  pay constant text := $s$case %1$s::text when 'PIX' then 'Pix' when 'DEBIT' then 'Débito' when 'CREDIT' then 'Crédito' when 'CASH' then 'Dinheiro' when 'PAYMENT_LINK' then 'Link de pagamento' when 'BOLETO' then 'Boleto' when 'STORE_CREDIT' then 'Crédito da loja' when 'PERMUTA' then 'Permuta' when 'B2B_INVOICE' then 'Faturado (B2B)' else coalesce(%1$s::text, '—') end$s$;
  tstatus constant text := $s$case %1$s::text when 'OPEN' then 'Em aberto' when 'PARTIAL' then 'Pago em parte' when 'SETTLED' then 'Pago' when 'RENEGOTIATED' then 'Renegociado' else %1$s::text end$s$;
  wday constant text := $s$extract(isodow from %1$s)::int || ' · ' || (array['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'])[extract(isodow from %1$s)::int]$s$;
  months constant text := $s$lpad(extract(month from %1$s)::int::text, 2, '0') || ' · ' || (array['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'])[extract(month from %1$s)::int]$s$;
  t_o constant text := $s$(o.created_at at time zone 'America/Sao_Paulo')$s$;
  t_pg constant text := $s$(pg.created_at at time zone 'America/Sao_Paulo')$s$;
  t_cv constant text := $s$(cv.created_at at time zone 'America/Sao_Paulo')$s$;
  today constant text := $s$(now() at time zone 'America/Sao_Paulo')::date$s$;
begin
  insert into core.report_datasets (key, label, description, area, perm, from_sql, org_expr, date_expr, date_label, store_expr, base_where, position) values
  ('pedidos', 'Vendas (pedidos)', 'Um registro por pedido pago (pago, em separação, enviado, concluído ou devolvido em parte). Valores do pedido inteiro: receita, descontos, frete, custo e margem.', 'Vendas', 'sales.read',
   $s$sales.orders o
      left join core.members sm on sm.id = o.seller_member_id
      left join core.stores st on st.id = o.store_id
      left join crm.parties cp on cp.id = o.party_id
      left join sales.coupons cu on cu.id = o.coupon_id
      left join lateral (select sum(i.qty) as qty from sales.order_items i where i.order_id = o.id) it on true$s$,
   'o.org_id', t_o || '::date', 'data do pedido', 'o.store_id', 'o.status::text in ' || paid, 10),
  ('itens', 'Itens vendidos', 'Um registro por peça vendida em pedido pago: produto, categoria, coleção, tamanho, cor, quantidade, receita e margem pelo custo registrado na venda.', 'Vendas', 'sales.read',
   $s$sales.order_items i
      join sales.orders o on o.id = i.order_id
      left join catalog.variants v on v.id = i.variant_id
      left join catalog.products p on p.id = v.product_id
      left join catalog.categories c on c.id = p.category_id
      left join catalog.collections cl on cl.id = p.collection_id
      left join catalog.brands b on b.id = p.brand_id
      left join catalog.colors co on co.id = v.color_id
      left join core.members sm on sm.id = o.seller_member_id
      left join core.stores st on st.id = o.store_id$s$,
   'i.org_id', t_o || '::date', 'data do pedido', 'o.store_id', 'o.status::text in ' || paid, 20),
  ('pagamentos', 'Pagamentos recebidos', 'Um registro por pagamento aprovado de pedido pago: forma (Pix, crédito, débito…), parcelas, bandeira, taxa e líquido previstos.', 'Vendas', 'sales.read',
   $s$sales.payments pg
      join sales.orders o on o.id = pg.order_id
      left join core.stores st on st.id = o.store_id$s$,
   'pg.org_id', t_pg || '::date', 'data do pagamento', 'o.store_id', $s$pg.status in ('AUTHORIZED', 'CAPTURED') and o.status::text in $s$ || paid, 30),
  ('clientes', 'Clientes e leads', 'Uma pessoa por registro (sem fornecedores e bancos): estágio, nível, origem, cidade, aniversário e o histórico de compras de sempre (gasto, pedidos, última compra). O período filtra a data de cadastro.', 'Clientes', 'crm.read',
   $s$crm.parties p
      left join core.members rm on rm.id = p.relationship_owner_member_id
      left join core.stores st on st.id = p.home_store_id
      left join lateral (select count(*) as n, sum(o.total) as total from sales.orders o
                         where o.party_id = p.id and o.status::text in ('PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED')) s on true$s$,
   'p.org_id', $s$(p.created_at at time zone 'America/Sao_Paulo')::date$s$, 'data de cadastro', null,
   $s$p.kind = 'PERSON' and p.merged_into_id is null and p.anonymized_at is null and p.archived_at is null
      and not exists (select 1 from crm.party_roles r where r.party_id = p.id and r.role::text in ('SUPPLIER', 'BANK', 'ACQUIRER', 'CARRIER', 'SERVICE_PROVIDER', 'SHAREHOLDER'))$s$, 40),
  ('conversas', 'Conversas do atendimento', 'Uma conversa por registro (WhatsApp, Instagram…): canal, atendente, modo da IA, intenção, sentimento, resultado e tempo até encerrar.', 'Atendimento', 'omni.read',
   $s$omni.conversations cv
      left join omni.channel_accounts ca on ca.id = cv.channel_account_id
      left join core.members am on am.id = cv.assignee_member_id
      left join crm.parties cp on cp.id = cv.party_id$s$,
   'cv.org_id', t_cv || '::date', 'início da conversa', 'ca.store_id', null, 50),
  ('contas', 'Contas a pagar e a receber', 'Uma parcela por registro (sem as canceladas): tipo, situação, vencimento, conta do plano, centro de custo e contraparte. O período filtra o vencimento.', 'Financeiro', 'fin.read',
   $s$fin.title_installments ti
      join fin.titles t on t.id = ti.title_id
      left join crm.parties pp on pp.id = t.party_id
      left join fin.chart_accounts ca on ca.id = t.chart_account_id
      left join core.cost_centers cc on cc.id = t.cost_center_id
      left join core.stores st on st.id = t.store_id$s$,
   'ti.org_id', 'ti.due_date', 'vencimento', 't.store_id', $s$t.status::text <> 'CANCELLED' and ti.status::text <> 'CANCELLED'$s$, 60),
  ('estoque', 'Estoque atual', 'Foto do estoque agora, por peça e local: quantidade, reservado, disponível, valor a custo médio e a preço de venda. Não usa o período.', 'Estoque', 'inv.read',
   $s$inv.stock_levels sl
      join inv.locations l on l.id = sl.location_id
      join catalog.variants v on v.id = sl.variant_id
      join catalog.products p on p.id = v.product_id
      left join catalog.categories c on c.id = p.category_id
      left join catalog.collections cl on cl.id = p.collection_id
      left join catalog.colors co on co.id = v.color_id
      left join core.stores st on st.id = l.store_id
      left join inv.item_costs ic on ic.variant_id = v.id and ic.legal_entity_id = l.legal_entity_id
      left join lateral (select pr.price from catalog.prices pr join catalog.price_lists pl on pl.id = pr.price_list_id and pl.is_default
                         where pr.org_id = sl.org_id and (pr.variant_id = v.id or (pr.variant_id is null and pr.product_id = p.id))
                           and pr.valid_from <= now() and (pr.valid_to is null or pr.valid_to > now())
                         order by pr.variant_id nulls last, pr.valid_from desc limit 1) pz on true$s$,
   'sl.org_id', null, null, 'l.store_id', null, 70);

  insert into core.report_fields (dataset, key, label, role, type, sql_expr, description, position) values
  -- ------------------------------ pedidos ------------------------------
  ('pedidos', 'dia', 'Dia', 'dimension', 'date', t_o || '::date', null, 1),
  ('pedidos', 'semana', 'Semana (início)', 'dimension', 'date', format('date_trunc(''week'', %s)::date', t_o), 'Segunda-feira da semana', 2),
  ('pedidos', 'mes', 'Mês', 'dimension', 'month', format('to_char(%s, ''YYYY-MM'')', t_o), null, 3),
  ('pedidos', 'ano', 'Ano', 'dimension', 'text', format('to_char(%s, ''YYYY'')', t_o), null, 4),
  ('pedidos', 'dia_semana', 'Dia da semana', 'dimension', 'text', format(wday, t_o), null, 5),
  ('pedidos', 'hora', 'Hora do dia', 'dimension', 'text', format('to_char(%s, ''HH24'') || ''h''', t_o), null, 6),
  ('pedidos', 'canal', 'Canal', 'dimension', 'text', format(ch, 'o.channel'), 'Loja (PDV), WhatsApp, Instagram, link de pagamento, evento…', 7),
  ('pedidos', 'vendedor', 'Vendedor(a)', 'dimension', 'text', $s$coalesce(sm.display_name, 'Sem vendedor')$s$, null, 8),
  ('pedidos', 'loja', 'Loja', 'dimension', 'text', $s$coalesce(st.name, 'Sem loja')$s$, null, 9),
  ('pedidos', 'cliente', 'Cliente', 'dimension', 'text', $s$coalesce(cp.display_name, 'Sem cliente')$s$, null, 10),
  ('pedidos', 'estagio_cliente', 'Estágio da cliente', 'dimension', 'text', format(stage, 'cp.lifecycle_stage'), 'Hoje (lead, cliente, VIP, inativa…)', 11),
  ('pedidos', 'entrega', 'Forma de entrega', 'dimension', 'text', format(ful, 'o.fulfillment_type'), null, 12),
  ('pedidos', 'cupom', 'Cupom', 'dimension', 'text', $s$coalesce(cu.code, 'Sem cupom')$s$, null, 13),
  ('pedidos', 'pedido', 'Número do pedido', 'dimension', 'text', 'o.number', 'Uma linha por pedido', 14),
  ('pedidos', 'status', 'Situação do pedido', 'dimension', 'text', format(ostatus, 'o.status'), null, 15),
  ('pedidos', 'com_ia', 'Atendido com IA', 'dimension', 'boolean', 'o.assisted_by_ai', 'A venda saiu de conversa atendida pela IA', 16),
  ('pedidos', 'pedidos', 'Pedidos', 'measure', 'number', 'count(*)', null, 30),
  ('pedidos', 'receita', 'Receita', 'measure', 'money', 'sum(o.total)', 'Total pago pelos pedidos (com desconto e frete)', 31),
  ('pedidos', 'subtotal', 'Subtotal (antes do desconto)', 'measure', 'money', 'sum(o.subtotal)', null, 32),
  ('pedidos', 'descontos', 'Descontos', 'measure', 'money', 'sum(o.discount_total)', null, 33),
  ('pedidos', 'desconto_pct', 'Desconto %', 'measure', 'percent', 'round(100 * sum(o.discount_total) / nullif(sum(o.subtotal), 0), 1)', 'Descontos sobre o subtotal', 34),
  ('pedidos', 'frete', 'Frete cobrado', 'measure', 'money', 'sum(o.shipping_total)', null, 35),
  ('pedidos', 'ticket_medio', 'Ticket médio', 'measure', 'money', 'round(avg(o.total), 2)', null, 36),
  ('pedidos', 'custo', 'Custo das peças', 'measure', 'money', 'sum(o.cost_total)', null, 37),
  ('pedidos', 'margem', 'Margem', 'measure', 'money', 'sum(o.total - o.cost_total)', 'Receita menos o custo registrado', 38),
  ('pedidos', 'margem_pct', 'Margem %', 'measure', 'percent', 'round(100 * sum(o.total - o.cost_total) / nullif(sum(o.total), 0), 1)', null, 39),
  ('pedidos', 'clientes', 'Clientes diferentes', 'measure', 'number', 'count(distinct o.party_id)', null, 40),
  ('pedidos', 'pecas', 'Peças', 'measure', 'number', 'coalesce(sum(it.qty), 0)', null, 41),
  ('pedidos', 'pecas_por_pedido', 'Peças por pedido', 'measure', 'number', 'round(sum(it.qty) / nullif(count(*), 0), 2)', null, 42),
  -- ------------------------------ itens ------------------------------
  ('itens', 'produto', 'Produto', 'dimension', 'text', $s$coalesce(p.name, i.description, 'Item avulso')$s$, null, 1),
  ('itens', 'referencia', 'Referência', 'dimension', 'text', $s$coalesce(p.reference_code, '—')$s$, null, 2),
  ('itens', 'categoria', 'Categoria', 'dimension', 'text', $s$coalesce(c.name, 'Sem categoria')$s$, null, 3),
  ('itens', 'colecao', 'Coleção', 'dimension', 'text', $s$coalesce(cl.name, 'Sem coleção')$s$, null, 4),
  ('itens', 'marca', 'Marca', 'dimension', 'text', $s$coalesce(b.name, 'Sem marca')$s$, null, 5),
  ('itens', 'tamanho', 'Tamanho', 'dimension', 'text', $s$coalesce(v.size, '—')$s$, null, 6),
  ('itens', 'cor', 'Cor', 'dimension', 'text', $s$coalesce(co.name, 'Sem cor')$s$, null, 7),
  ('itens', 'sku', 'SKU', 'dimension', 'text', $s$coalesce(v.sku, '—')$s$, 'Uma linha por variação (produto + cor + tamanho)', 8),
  ('itens', 'dia', 'Dia', 'dimension', 'date', t_o || '::date', null, 9),
  ('itens', 'semana', 'Semana (início)', 'dimension', 'date', format('date_trunc(''week'', %s)::date', t_o), null, 10),
  ('itens', 'mes', 'Mês', 'dimension', 'month', format('to_char(%s, ''YYYY-MM'')', t_o), null, 11),
  ('itens', 'dia_semana', 'Dia da semana', 'dimension', 'text', format(wday, t_o), null, 12),
  ('itens', 'canal', 'Canal', 'dimension', 'text', format(ch, 'o.channel'), null, 13),
  ('itens', 'vendedor', 'Vendedor(a)', 'dimension', 'text', $s$coalesce(sm.display_name, 'Sem vendedor')$s$, null, 14),
  ('itens', 'loja', 'Loja', 'dimension', 'text', $s$coalesce(st.name, 'Sem loja')$s$, null, 15),
  ('itens', 'quantidade', 'Quantidade vendida', 'measure', 'number', 'sum(i.qty)', null, 30),
  ('itens', 'devolvidas', 'Quantidade devolvida', 'measure', 'number', 'sum(coalesce(i.returned_qty, 0))', null, 31),
  ('itens', 'receita', 'Receita', 'measure', 'money', 'sum(i.total)', 'Valor das peças com desconto (sem frete)', 32),
  ('itens', 'descontos', 'Descontos', 'measure', 'money', 'sum(i.discount_amount)', null, 33),
  ('itens', 'custo', 'Custo', 'measure', 'money', 'sum(i.qty * coalesce(i.unit_cost_snapshot, 0))', 'Custo registrado no momento da venda', 34),
  ('itens', 'margem', 'Margem', 'measure', 'money', 'sum(i.total - i.qty * coalesce(i.unit_cost_snapshot, 0))', null, 35),
  ('itens', 'margem_pct', 'Margem %', 'measure', 'percent', 'round(100 * sum(i.total - i.qty * coalesce(i.unit_cost_snapshot, 0)) / nullif(sum(i.total), 0), 1)', null, 36),
  ('itens', 'preco_medio', 'Preço médio por peça', 'measure', 'money', 'round(sum(i.total) / nullif(sum(i.qty), 0), 2)', null, 37),
  ('itens', 'pedidos', 'Pedidos', 'measure', 'number', 'count(distinct o.id)', null, 38),
  ('itens', 'produtos', 'Produtos diferentes', 'measure', 'number', 'count(distinct p.id)', null, 39),
  -- ------------------------------ pagamentos ------------------------------
  ('pagamentos', 'forma', 'Forma de pagamento', 'dimension', 'text', format(pay, 'pg.method'), null, 1),
  ('pagamentos', 'parcelas', 'Parcelas', 'dimension', 'text', $s$case when coalesce(pg.installments, 1) > 1 then lpad(pg.installments::text, 2, '0') || 'x' else 'À vista' end$s$, null, 2),
  ('pagamentos', 'bandeira', 'Bandeira', 'dimension', 'text', $s$coalesce(initcap(nullif(pg.brand, '')), '—')$s$, null, 3),
  ('pagamentos', 'adquirente', 'Adquirente', 'dimension', 'text', $s$coalesce(nullif(pg.acquirer, ''), '—')$s$, null, 4),
  ('pagamentos', 'dia', 'Dia', 'dimension', 'date', t_pg || '::date', null, 5),
  ('pagamentos', 'semana', 'Semana (início)', 'dimension', 'date', format('date_trunc(''week'', %s)::date', t_pg), null, 6),
  ('pagamentos', 'mes', 'Mês', 'dimension', 'month', format('to_char(%s, ''YYYY-MM'')', t_pg), null, 7),
  ('pagamentos', 'canal', 'Canal do pedido', 'dimension', 'text', format(ch, 'o.channel'), null, 8),
  ('pagamentos', 'loja', 'Loja', 'dimension', 'text', $s$coalesce(st.name, 'Sem loja')$s$, null, 9),
  ('pagamentos', 'pagamentos', 'Pagamentos', 'measure', 'number', 'count(*)', null, 30),
  ('pagamentos', 'valor', 'Valor', 'measure', 'money', 'sum(pg.amount)', null, 31),
  ('pagamentos', 'valor_medio', 'Valor médio', 'measure', 'money', 'round(avg(pg.amount), 2)', null, 32),
  ('pagamentos', 'taxa_prevista', 'Taxa prevista', 'measure', 'money', 'sum(coalesce(pg.fee_expected, 0))', 'Taxa da maquininha/adquirente pelo plano cadastrado', 33),
  ('pagamentos', 'taxa_pct', 'Taxa %', 'measure', 'percent', 'round(100 * sum(coalesce(pg.fee_expected, 0)) / nullif(sum(pg.amount), 0), 2)', null, 34),
  ('pagamentos', 'liquido_previsto', 'Líquido previsto', 'measure', 'money', 'sum(coalesce(pg.net_expected, pg.amount))', null, 35),
  -- ------------------------------ clientes ------------------------------
  ('clientes', 'cliente', 'Cliente', 'dimension', 'text', 'p.display_name', 'Uma linha por pessoa', 1),
  ('clientes', 'instagram', 'Instagram', 'dimension', 'text', $s$coalesce(nullif(p.instagram_handle, ''), '—')$s$, null, 2),
  ('clientes', 'estagio', 'Estágio', 'dimension', 'text', format(stage, 'p.lifecycle_stage'), 'Lead, em negociação, cliente, VIP, inativa, perdida', 3),
  ('clientes', 'nivel', 'Nível', 'dimension', 'text', $s$case p.tier::text when 'VIP' then 'VIP' when 'VIP_BLACK' then 'VIP Black' else 'Padrão' end$s$, null, 4),
  ('clientes', 'origem', 'Origem', 'dimension', 'text', $s$coalesce(nullif(p.source, ''), 'Sem origem')$s$, 'De onde a pessoa veio (cadastro, anúncio, indicação…)', 5),
  ('clientes', 'cidade', 'Cidade', 'dimension', 'text', $s$coalesce(nullif(p.city, ''), 'Sem cidade')$s$, null, 6),
  ('clientes', 'uf', 'UF', 'dimension', 'text', $s$coalesce(nullif(p.uf, ''), '—')$s$, null, 7),
  ('clientes', 'mes_aniversario', 'Mês do aniversário', 'dimension', 'text', format('coalesce(%s, ''Sem data'')', format(months, 'p.birth_date')), null, 8),
  ('clientes', 'responsavel', 'Responsável', 'dimension', 'text', $s$coalesce(rm.display_name, 'Sem responsável')$s$, 'Quem cuida do relacionamento', 9),
  ('clientes', 'loja', 'Loja de referência', 'dimension', 'text', $s$coalesce(st.name, 'Sem loja')$s$, null, 10),
  ('clientes', 'mes_cadastro', 'Mês do cadastro', 'dimension', 'month', $s$to_char(p.created_at at time zone 'America/Sao_Paulo', 'YYYY-MM')$s$, null, 11),
  ('clientes', 'mes_primeira_compra', 'Mês da 1ª compra', 'dimension', 'month', $s$to_char(p.first_purchase_at at time zone 'America/Sao_Paulo', 'YYYY-MM')$s$, 'Vazio se nunca comprou', 12),
  ('clientes', 'ultima_compra', 'Última compra', 'dimension', 'date', $s$(p.last_purchase_at at time zone 'America/Sao_Paulo')::date$s$, 'Vazio se nunca comprou', 13),
  ('clientes', 'dias_sem_comprar', 'Dias sem comprar', 'dimension', 'number', format($s$(%s - (p.last_purchase_at at time zone 'America/Sao_Paulo')::date)$s$, today), 'Dias desde a última compra; vazio se nunca comprou. Use com filtro (ex.: maior que 90)', 14),
  ('clientes', 'faixa_sem_comprar', 'Faixa sem comprar', 'dimension', 'text',
   format($s$case when p.last_purchase_at is null then '6 · nunca comprou'
                 when %1$s - (p.last_purchase_at at time zone 'America/Sao_Paulo')::date <= 30 then '1 · até 30 dias'
                 when %1$s - (p.last_purchase_at at time zone 'America/Sao_Paulo')::date <= 60 then '2 · 31 a 60 dias'
                 when %1$s - (p.last_purchase_at at time zone 'America/Sao_Paulo')::date <= 90 then '3 · 61 a 90 dias'
                 when %1$s - (p.last_purchase_at at time zone 'America/Sao_Paulo')::date <= 180 then '4 · 91 a 180 dias'
                 else '5 · mais de 180 dias' end$s$, today), null, 15),
  ('clientes', 'comprou', 'Já comprou', 'dimension', 'boolean', 'coalesce(s.n, 0) > 0', null, 16),
  ('clientes', 'clientes', 'Pessoas', 'measure', 'number', 'count(*)', null, 30),
  ('clientes', 'compradoras', 'Já compraram', 'measure', 'number', 'count(*) filter (where s.n > 0)', null, 31),
  ('clientes', 'gasto_total', 'Gasto total (desde sempre)', 'measure', 'money', 'coalesce(sum(s.total), 0)', 'Soma dos pedidos pagos de todas as datas, não só do período', 32),
  ('clientes', 'pedidos', 'Pedidos (desde sempre)', 'measure', 'number', 'coalesce(sum(s.n), 0)', null, 33),
  ('clientes', 'ticket_medio', 'Ticket médio (desde sempre)', 'measure', 'money', 'round(sum(s.total) / nullif(sum(s.n), 0), 2)', null, 34),
  ('clientes', 'media_dias_sem_comprar', 'Média de dias sem comprar', 'measure', 'number', format($s$round(avg(%s - (p.last_purchase_at at time zone 'America/Sao_Paulo')::date))$s$, today), null, 35),
  ('clientes', 'pontuacao_media', 'Pontuação média (lead score)', 'measure', 'number', 'round(avg(p.lead_score), 1)', null, 36),
  -- ------------------------------ conversas ------------------------------
  ('conversas', 'canal', 'Canal', 'dimension', 'text', format(ch, 'ca.channel'), null, 1),
  ('conversas', 'conta', 'Conta/número', 'dimension', 'text', $s$coalesce(ca.display_name, '—')$s$, null, 2),
  ('conversas', 'atendente', 'Atendente', 'dimension', 'text', $s$coalesce(am.display_name, 'Sem atendente')$s$, null, 3),
  ('conversas', 'modo', 'Modo', 'dimension', 'text', $s$case cv.mode::text when 'HUMAN' then 'Pessoa' when 'AI_COPILOT' then 'IA sugere' when 'AI_AUTOPILOT' then 'IA responde' when 'WAITING_HUMAN' then 'Esperando pessoa' else coalesce(cv.mode::text, '—') end$s$, null, 4),
  ('conversas', 'situacao', 'Situação', 'dimension', 'text', $s$case cv.status when 'OPEN' then 'Aberta' when 'SNOOZED' then 'Adiada' when 'CLOSED' then 'Encerrada' else cv.status end$s$, null, 5),
  ('conversas', 'resultado', 'Resultado', 'dimension', 'text', $s$case cv.outcome when 'PURCHASED' then 'Comprou' when 'RESERVED' then 'Reservou' when 'RESOLVED' then 'Resolvida' when 'EXCHANGE' then 'Troca' when 'COMPLAINT' then 'Reclamação' when 'NO_REPLY' then 'Sem resposta' when 'NOT_CUSTOMER' then 'Não é cliente' when 'SPAM' then 'Spam' else 'Sem resultado' end$s$, null, 6),
  ('conversas', 'intencao', 'Intenção', 'dimension', 'text', $s$coalesce(nullif(cv.intent, ''), '—')$s$, 'Classificada pela IA', 7),
  ('conversas', 'sentimento', 'Sentimento', 'dimension', 'text', $s$coalesce(nullif(cv.sentiment, ''), '—')$s$, 'Classificado pela IA', 8),
  ('conversas', 'cliente', 'Cliente', 'dimension', 'text', $s$coalesce(cp.display_name, 'Sem cadastro')$s$, null, 9),
  ('conversas', 'dia', 'Dia', 'dimension', 'date', t_cv || '::date', null, 10),
  ('conversas', 'semana', 'Semana (início)', 'dimension', 'date', format('date_trunc(''week'', %s)::date', t_cv), null, 11),
  ('conversas', 'mes', 'Mês', 'dimension', 'month', format('to_char(%s, ''YYYY-MM'')', t_cv), null, 12),
  ('conversas', 'dia_semana', 'Dia da semana', 'dimension', 'text', format(wday, t_cv), null, 13),
  ('conversas', 'hora', 'Hora do dia', 'dimension', 'text', format('to_char(%s, ''HH24'') || ''h''', t_cv), null, 14),
  ('conversas', 'conversas', 'Conversas', 'measure', 'number', 'count(*)', null, 30),
  ('conversas', 'encerradas', 'Encerradas', 'measure', 'number', 'count(*) filter (where cv.closed_at is not null)', null, 31),
  ('conversas', 'compraram', 'Terminaram em compra', 'measure', 'number', $s$count(*) filter (where cv.outcome in ('PURCHASED', 'RESERVED'))$s$, 'Resultado "comprou" ou "reservou"', 32),
  ('conversas', 'conversao_pct', 'Conversão %', 'measure', 'percent', $s$round(100 * count(*) filter (where cv.outcome in ('PURCHASED', 'RESERVED')) / nullif(count(*), 0)::numeric, 1)$s$, null, 33),
  ('conversas', 'horas_ate_encerrar', 'Horas até encerrar (média)', 'measure', 'number', 'round((avg(extract(epoch from cv.closed_at - cv.created_at)) / 3600)::numeric, 1)', null, 34),
  ('conversas', 'clientes', 'Clientes diferentes', 'measure', 'number', 'count(distinct cv.party_id)', null, 35),
  -- ------------------------------ contas ------------------------------
  ('contas', 'tipo', 'Tipo', 'dimension', 'text', $s$case t.direction::text when 'PAYABLE' then 'A pagar' else 'A receber' end$s$, null, 1),
  ('contas', 'situacao', 'Situação', 'dimension', 'text', format(tstatus, 'ti.status'), null, 2),
  ('contas', 'atrasada', 'Atrasada', 'dimension', 'boolean', format($s$(ti.status::text in ('OPEN', 'PARTIAL') and ti.due_date < %s)$s$, today), 'Em aberto e com vencimento já passado', 3),
  ('contas', 'vencimento', 'Vencimento', 'dimension', 'date', 'ti.due_date', null, 4),
  ('contas', 'semana_vencimento', 'Semana do vencimento', 'dimension', 'date', $s$date_trunc('week', ti.due_date)::date$s$, null, 5),
  ('contas', 'mes_vencimento', 'Mês do vencimento', 'dimension', 'month', $s$to_char(ti.due_date, 'YYYY-MM')$s$, null, 6),
  ('contas', 'mes_competencia', 'Mês de competência', 'dimension', 'month', $s$to_char(coalesce(t.competence_date, t.issue_date), 'YYYY-MM')$s$, null, 7),
  ('contas', 'conta', 'Conta do plano', 'dimension', 'text', $s$coalesce(ca.code || ' ' || ca.name, 'Sem conta')$s$, null, 8),
  ('contas', 'centro_custo', 'Centro de custo', 'dimension', 'text', $s$coalesce(cc.name, 'Sem centro de custo')$s$, null, 9),
  ('contas', 'contraparte', 'Fornecedor/cliente', 'dimension', 'text', $s$coalesce(pp.display_name, 'Sem contraparte')$s$, null, 10),
  ('contas', 'loja', 'Loja', 'dimension', 'text', $s$coalesce(st.name, 'Sem loja')$s$, null, 11),
  ('contas', 'documento', 'Tipo de documento', 'dimension', 'text', $s$coalesce(nullif(t.document_kind, ''), '—')$s$, 'Boleto, NF, Pix…', 12),
  ('contas', 'descricao', 'Descrição', 'dimension', 'text', $s$coalesce(t.description, '—')$s$, 'Uma linha por título', 13),
  ('contas', 'parcelas', 'Parcelas', 'measure', 'number', 'count(*)', null, 30),
  ('contas', 'titulos', 'Títulos', 'measure', 'number', 'count(distinct t.id)', null, 31),
  ('contas', 'valor', 'Valor', 'measure', 'money', 'sum(ti.amount)', null, 32),
  ('contas', 'pago', 'Pago/recebido', 'measure', 'money', 'sum(coalesce(ti.amount_settled, 0))', null, 33),
  ('contas', 'em_aberto', 'Em aberto', 'measure', 'money', $s$sum(case when ti.status::text in ('OPEN', 'PARTIAL') then ti.amount - coalesce(ti.amount_settled, 0) else 0 end)$s$, null, 34),
  ('contas', 'juros_multa', 'Juros e multa', 'measure', 'money', 'sum(coalesce(ti.interest, 0) + coalesce(ti.fine, 0))', null, 35),
  ('contas', 'saldo', 'Saldo (receber − pagar)', 'measure', 'money', $s$sum(case when t.direction::text = 'RECEIVABLE' then ti.amount else -ti.amount end)$s$, 'Positivo = entra mais do que sai', 36),
  -- ------------------------------ estoque ------------------------------
  ('estoque', 'produto', 'Produto', 'dimension', 'text', 'p.name', null, 1),
  ('estoque', 'referencia', 'Referência', 'dimension', 'text', $s$coalesce(p.reference_code, '—')$s$, null, 2),
  ('estoque', 'categoria', 'Categoria', 'dimension', 'text', $s$coalesce(c.name, 'Sem categoria')$s$, null, 3),
  ('estoque', 'colecao', 'Coleção', 'dimension', 'text', $s$coalesce(cl.name, 'Sem coleção')$s$, null, 4),
  ('estoque', 'tamanho', 'Tamanho', 'dimension', 'text', $s$coalesce(v.size, '—')$s$, null, 5),
  ('estoque', 'cor', 'Cor', 'dimension', 'text', $s$coalesce(co.name, 'Sem cor')$s$, null, 6),
  ('estoque', 'sku', 'SKU', 'dimension', 'text', $s$coalesce(v.sku, '—')$s$, 'Uma linha por variação', 7),
  ('estoque', 'local', 'Local', 'dimension', 'text', 'l.name', null, 8),
  ('estoque', 'tipo_local', 'Tipo de local', 'dimension', 'text', $s$case l.kind::text when 'SALES_FLOOR' then 'Loja (salão)' when 'BACKROOM' then 'Estoque/depósito' when 'VIP_LOCKERS' then 'Armário VIP' when 'IN_TRANSIT' then 'Em trânsito' when 'WITH_CUSTOMER' then 'Com cliente (malinha)' when 'DAMAGED' then 'Avariado' when 'POPUP' then 'Pop-up' when 'CONSIGNMENT_AT_PARTNER' then 'Consignado em parceiro' when 'MARKETING' then 'Marketing' else l.kind::text end$s$, null, 9),
  ('estoque', 'loja', 'Loja', 'dimension', 'text', $s$coalesce(st.name, 'Sem loja')$s$, null, 10),
  ('estoque', 'situacao_produto', 'Situação do produto', 'dimension', 'text', $s$case p.status::text when 'ACTIVE' then 'Ativo' when 'DRAFT' then 'Rascunho' when 'DISCONTINUED' then 'Fora de linha' else p.status::text end$s$, null, 11),
  ('estoque', 'vendavel', 'Local vendável', 'dimension', 'boolean', 'l.is_sellable', null, 12),
  ('estoque', 'em_estoque', 'Em estoque', 'measure', 'number', 'sum(sl.on_hand)', null, 30),
  ('estoque', 'reservado', 'Reservado', 'measure', 'number', 'sum(sl.reserved)', null, 31),
  ('estoque', 'disponivel', 'Disponível', 'measure', 'number', 'sum(sl.available)', null, 32),
  ('estoque', 'custo_estoque', 'Valor a custo', 'measure', 'money', 'round(sum(greatest(sl.on_hand, 0) * coalesce(ic.avg_cost, 0)), 2)', 'Quantidade × custo médio', 33),
  ('estoque', 'valor_venda', 'Valor a preço de venda', 'measure', 'money', 'round(sum(greatest(sl.on_hand, 0) * coalesce(pz.price, 0)), 2)', 'Quantidade × preço da tabela padrão', 34),
  ('estoque', 'skus', 'SKUs com estoque', 'measure', 'number', 'count(distinct v.id) filter (where sl.on_hand > 0)', null, 35),
  ('estoque', 'skus_zerados', 'SKUs sem disponível', 'measure', 'number', 'count(distinct v.id) filter (where sl.available <= 0)', null, 36);
end $do$;

-- ---------------------------------------------------------------------
-- Catálogo para a tela e para a IA: só as fontes que a pessoa pode ler (sem as expressões SQL)
-- ---------------------------------------------------------------------
create or replace function core.report_catalog() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', d.key, 'label', d.label, 'description', d.description, 'area', d.area, 'perm', d.perm,
           'date_label', d.date_label, 'has_period', d.date_expr is not null, 'has_store', d.store_expr is not null,
           'fields', (select jsonb_agg(jsonb_build_object('key', f.key, 'label', f.label, 'role', f.role, 'type', f.type, 'description', f.description) order by f.position)
                      from core.report_fields f where f.dataset = d.key)) order by d.position), '[]'::jsonb)
  from core.report_datasets d
  where private.org_id() is not null and private.has_perm(d.perm)
$$;

-- Condição de um filtro: expressão conhecida + operador permitido + valor convertido pelo tipo do campo.
create or replace function private.report_cond(p_expr text, p_type text, p_label text, p_f jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_op text := coalesce(nullif(p_f ->> 'op', ''), 'eq');
  v text := p_f ->> 'value';
  vs text[];
  lit text;
begin
  if v_op = 'empty' then return format('%s is null', p_expr); end if;
  if v_op = 'not_empty' then return format('%s is not null', p_expr); end if;
  if v_op in ('in', 'not_in') then
    select array_agg(x) into vs from jsonb_array_elements_text(case when jsonb_typeof(p_f -> 'values') = 'array' then p_f -> 'values' else '[]'::jsonb end) x;
    if coalesce(cardinality(vs), 0) = 0 then raise exception 'O filtro de «%» precisa de ao menos um valor', p_label using errcode = 'P0280'; end if;
    return format('lower(%s::text) %s (%L::text[])', p_expr, case v_op when 'in' then '= any' else '<> all' end,
                  (select array_agg(lower(x)) from unnest(vs) x));
  end if;
  if v is null or btrim(v) = '' then raise exception 'O filtro de «%» está sem valor', p_label using errcode = 'P0280'; end if;
  if v_op = 'contains' then
    return format('%s::text ilike %L', p_expr, '%' || replace(replace(replace(v, '\', '\\'), '%', '\%'), '_', '\_') || '%');
  end if;
  if p_type in ('number', 'money', 'percent') then
    begin lit := (replace(btrim(v), ',', '.')::numeric)::text;
    exception when others then raise exception 'O filtro de «%» precisa de um número (veio «%»)', p_label, v using errcode = 'P0280'; end;
  elsif p_type = 'date' then
    begin lit := quote_literal((btrim(v)::date)::text) || '::date';
    exception when others then raise exception 'O filtro de «%» precisa de uma data AAAA-MM-DD (veio «%»)', p_label, v using errcode = 'P0280'; end;
  elsif p_type = 'boolean' then
    lit := case when lower(btrim(v)) in ('true', 't', 'sim', 's', '1') then 'true' when lower(btrim(v)) in ('false', 'f', 'não', 'nao', 'n', '0') then 'false' end;
    if lit is null then raise exception 'O filtro de «%» é sim ou não', p_label using errcode = 'P0280'; end if;
    if v_op not in ('eq', 'neq') then raise exception 'O filtro de «%» só aceita igual ou diferente', p_label using errcode = 'P0280'; end if;
  else
    if v_op in ('eq', 'neq') then lit := quote_literal(lower(btrim(v))); p_expr := format('lower(%s::text)', p_expr);
    else lit := quote_literal(btrim(v)); end if;
  end if;
  return case v_op
    when 'eq' then format('%s = %s', p_expr, lit)
    when 'neq' then format('%s is distinct from %s', p_expr, lit)
    when 'gt' then format('%s > %s', p_expr, lit)
    when 'gte' then format('%s >= %s', p_expr, lit)
    when 'lt' then format('%s < %s', p_expr, lit)
    when 'lte' then format('%s <= %s', p_expr, lit)
    else null end;
end $$;

-- ---------------------------------------------------------------------
-- Executa um relatório. Devolve {columns:[{key,label,type,role}], rows:[{...}], truncated, dataset, period}
-- ---------------------------------------------------------------------
create or replace function core.report_run(p_spec jsonb, p_from date default null, p_to date default null, p_store uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  ds core.report_datasets;
  f core.report_fields;
  v_key text; v_flt jsonb;
  v_dims text[] := '{}'; v_meas text[] := '{}';
  v_select text[] := '{}'; v_group text[] := '{}'; v_where text[] := '{}'; v_having text[] := '{}';
  v_cols jsonb := '[]';
  v_sort text; v_dir text; v_order text; v_limit int; v_period boolean := false; v_sql text; v_rows jsonb; v_cond text;
begin
  if v_org is null then raise exception 'Sessão sem empresa' using errcode = '42501'; end if;
  if p_spec is null or jsonb_typeof(p_spec) <> 'object' then raise exception 'Relatório inválido' using errcode = 'P0280'; end if;
  select * into ds from core.report_datasets where key = p_spec ->> 'dataset';
  if ds.key is null then raise exception 'Fonte de dados desconhecida: %', coalesce(p_spec ->> 'dataset', '(vazia)') using errcode = 'P0280'; end if;
  perform private.require_perm(ds.perm);

  -- agrupar por
  for v_key in select jsonb_array_elements_text(case when jsonb_typeof(p_spec -> 'dimensions') = 'array' then p_spec -> 'dimensions' else '[]'::jsonb end) loop
    continue when v_key = any (v_dims);
    select * into f from core.report_fields where dataset = ds.key and key = v_key and role = 'dimension';
    if f.key is null then raise exception 'Campo para agrupar desconhecido em «%»: %', ds.label, v_key using errcode = 'P0280'; end if;
    v_dims := v_dims || v_key;
    v_select := v_select || format('(%s) as %I', f.sql_expr, f.key);
    v_group := v_group || cardinality(v_select)::text;
    v_cols := v_cols || jsonb_build_object('key', f.key, 'label', f.label, 'type', f.type, 'role', f.role);
  end loop;
  -- valores
  for v_key in select jsonb_array_elements_text(case when jsonb_typeof(p_spec -> 'measures') = 'array' then p_spec -> 'measures' else '[]'::jsonb end) loop
    continue when v_key = any (v_meas);
    select * into f from core.report_fields where dataset = ds.key and key = v_key and role = 'measure';
    if f.key is null then raise exception 'Valor desconhecido em «%»: %', ds.label, v_key using errcode = 'P0280'; end if;
    v_meas := v_meas || v_key;
    v_select := v_select || format('(%s) as %I', f.sql_expr, f.key);
    v_cols := v_cols || jsonb_build_object('key', f.key, 'label', f.label, 'type', f.type, 'role', f.role);
  end loop;
  if cardinality(v_dims) + cardinality(v_meas) = 0 then raise exception 'Escolha ao menos um campo para agrupar ou um valor' using errcode = 'P0280'; end if;
  if cardinality(v_dims) > 4 then raise exception 'Agrupe por no máximo 4 campos' using errcode = 'P0280'; end if;
  if cardinality(v_meas) > 16 then raise exception 'Use no máximo 16 valores' using errcode = 'P0280'; end if;

  -- empresa, condição fixa da fonte, lojas que a pessoa acessa e loja escolhida no topo
  v_where := v_where || format('%s = %L::uuid', ds.org_expr, v_org);
  if ds.base_where is not null then v_where := v_where || format('(%s)', ds.base_where); end if;
  if ds.store_expr is not null then
    v_where := v_where || format('private.can_store(%s)', ds.store_expr);
    if p_store is not null then v_where := v_where || format('%s = %L::uuid', ds.store_expr, p_store); end if;
  end if;
  -- período da tela
  if ds.date_expr is not null and coalesce((p_spec ->> 'use_period')::boolean, true) and (p_from is not null or p_to is not null) then
    if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100 then raise exception 'Período inválido (no máximo 3 anos)' using errcode = 'P0280'; end if;
    v_where := v_where || format('(%s) between %L::date and %L::date', ds.date_expr, p_from, p_to);
    v_period := true;
  end if;
  -- filtros
  for v_flt in select jsonb_array_elements(case when jsonb_typeof(p_spec -> 'filters') = 'array' then p_spec -> 'filters' else '[]'::jsonb end) loop
    if jsonb_typeof(v_flt) <> 'object' then raise exception 'Filtro inválido' using errcode = 'P0280'; end if;
    select * into f from core.report_fields where dataset = ds.key and key = v_flt ->> 'field';
    if f.key is null then raise exception 'Filtro com campo desconhecido em «%»: %', ds.label, coalesce(v_flt ->> 'field', '(vazio)') using errcode = 'P0280'; end if;
    if coalesce(nullif(v_flt ->> 'op', ''), 'eq') not in ('eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'empty', 'not_empty') then
      raise exception 'Operador de filtro desconhecido: %', v_flt ->> 'op' using errcode = 'P0280';
    end if;
    v_cond := private.report_cond(format('(%s)', f.sql_expr), f.type, f.label, v_flt);
    if f.role = 'measure' then v_having := v_having || v_cond; else v_where := v_where || v_cond; end if;
  end loop;

  -- ordem: o campo escolhido (precisa estar no relatório) ou, sem escolha, a data em ordem ou o 1º valor do maior para o menor
  v_sort := p_spec #>> '{sort,field}';
  v_dir := case when lower(coalesce(p_spec #>> '{sort,dir}', '')) = 'asc' then 'asc' when lower(coalesce(p_spec #>> '{sort,dir}', '')) = 'desc' then 'desc' end;
  if v_sort is not null and v_sort <> '' then
    if not (v_sort = any (v_dims) or v_sort = any (v_meas)) then raise exception 'Ordene por um campo que está no relatório (%)', v_sort using errcode = 'P0280'; end if;
    v_order := format('%I %s nulls last', v_sort, coalesce(v_dir, case when v_sort = any (v_meas) then 'desc' else 'asc' end));
  elsif cardinality(v_dims) > 0 and (select type from core.report_fields where dataset = ds.key and key = v_dims[1]) in ('date', 'month') then
    v_order := format('%I asc', v_dims[1]);
  elsif cardinality(v_meas) > 0 then
    v_order := format('%I desc nulls last', v_meas[1]);
  else
    v_order := format('%I asc', v_dims[1]);
  end if;
  if cardinality(v_dims) > 0 then
    v_order := v_order || ', ' || (select string_agg(format('%I', d), ', ') from unnest(v_dims) d);
  end if;
  v_limit := least(greatest(coalesce(nullif(p_spec ->> 'limit', '')::int, 500), 1), 5000);

  v_sql := format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from (select %s from %s where %s %s %s order by %s limit %s) x',
                  array_to_string(v_select, ', '), ds.from_sql, array_to_string(v_where, ' and '),
                  case when cardinality(v_group) > 0 then 'group by ' || array_to_string(v_group, ', ') else '' end,
                  case when cardinality(v_having) > 0 then 'having ' || array_to_string(v_having, ' and ') else '' end,
                  v_order, v_limit + 1);
  execute v_sql into v_rows;
  return jsonb_build_object('columns', v_cols, 'rows', case when jsonb_array_length(v_rows) > v_limit then v_rows - v_limit else v_rows end,
                            'truncated', jsonb_array_length(v_rows) > v_limit, 'dataset', ds.label, 'period', v_period,
                            'date_label', case when v_period then ds.date_label end);
end $$;

-- ---------------------------------------------------------------------
-- Relatórios salvos. p = {id?, title, description?, spec, prompt?}. Quem pode ler a fonte cria; edita quem criou ou o admin.
-- ---------------------------------------------------------------------
create or replace function core.report_save(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_me uuid := private.member_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; r core.saved_reports; v_spec jsonb := p -> 'spec';
        v_title text := btrim(coalesce(p ->> 'title', ''));
begin
  if v_title = '' or length(v_title) > 120 then raise exception 'Dê um nome ao relatório (até 120 letras)' using errcode = 'P0280'; end if;
  if v_spec is null or jsonb_typeof(v_spec) <> 'object' then raise exception 'Relatório inválido' using errcode = 'P0280'; end if;
  -- só guarda o que roda (valida fonte, campos, filtros e permissão); o período mínimo deixa a validação barata
  perform core.report_run(jsonb_set(v_spec, '{limit}', '1'), (now() at time zone 'America/Sao_Paulo')::date, (now() at time zone 'America/Sao_Paulo')::date);
  v_spec := jsonb_strip_nulls(jsonb_build_object('dataset', v_spec -> 'dataset', 'dimensions', v_spec -> 'dimensions', 'measures', v_spec -> 'measures',
                                                 'filters', v_spec -> 'filters', 'sort', v_spec -> 'sort', 'limit', v_spec -> 'limit', 'use_period', v_spec -> 'use_period'));
  if v_id is null then
    insert into core.saved_reports (org_id, title, description, dataset, spec, prompt, created_by, updated_by)
    values (v_org, v_title, nullif(btrim(p ->> 'description'), ''), v_spec ->> 'dataset', v_spec, nullif(left(btrim(p ->> 'prompt'), 2000), ''), v_me, v_me)
    returning id into v_id;
  else
    select * into r from core.saved_reports where id = v_id and org_id = v_org and archived_at is null for update;
    if r.id is null then raise exception 'Relatório não encontrado' using errcode = 'P0280'; end if;
    if r.created_by is distinct from v_me and not private.has_perm('core.admin') then raise exception 'Só quem criou o relatório (ou o admin) pode alterá-lo' using errcode = 'P0281'; end if;
    update core.saved_reports set title = v_title, description = nullif(btrim(p ->> 'description'), ''), dataset = v_spec ->> 'dataset', spec = v_spec,
           prompt = coalesce(nullif(left(btrim(p ->> 'prompt'), 2000), ''), prompt), updated_by = v_me
    where id = v_id;
  end if;
  return v_id;
end $$;

create or replace function core.report_archive(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r core.saved_reports;
begin
  select * into r from core.saved_reports where id = p_id and org_id = private.org_id() and archived_at is null for update;
  if r.id is null then raise exception 'Relatório não encontrado' using errcode = 'P0280'; end if;
  if r.created_by is distinct from private.member_id() and not private.has_perm('core.admin') then raise exception 'Só quem criou o relatório (ou o admin) pode excluí-lo' using errcode = 'P0281'; end if;
  update core.saved_reports set archived_at = now(), updated_by = private.member_id() where id = p_id;
end $$;

insert into private.internal_functions (fqname) values ('private.report_cond') on conflict do nothing;
select private.lock_functions();
notify pgrst, 'reload schema';
