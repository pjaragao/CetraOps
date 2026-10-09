-- =====================================================================
-- Cobrança presencial via Maquininha Stone (Smart POS / Connect Stone 2.0)
-- =====================================================================

create table if not exists sales.stone_pos_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  order_id uuid references sales.orders(id) on delete set null,
  stone_order_id text not null,
  terminal_serial text not null,
  display_name text,
  amount numeric(12,2) not null,
  method text not null, -- CREDIT, DEBIT, PIX
  installments int not null default 1,
  status text not null default 'PENDING', -- PENDING, PAID, CANCELLED, FAILED
  nsu text,
  auth_code text,
  card_brand text,
  raw_response jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_stone_pos_orders_stone_id on sales.stone_pos_orders(stone_order_id);
create index if not exists idx_stone_pos_orders_order on sales.stone_pos_orders(order_id);
create index if not exists idx_stone_pos_orders_org_status on sales.stone_pos_orders(org_id, status);

select private.apply_rls('sales', array['stone_pos_orders'], 'sales.read', 'sales.write');

-- Obtém a configuração da Stone (e a secret_key via Vault) para a organização atual
create or replace function sales.get_stone_config() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  c core.integration_connections;
  v_secret text;
  v_key text;
begin
  perform private.require_perm('sales.read');
  select * into c from core.integration_connections
  where org_id = v_org and provider = 'STONE' and status <> 'DISABLED' and secret_ref is not null
  order by updated_at desc limit 1;

  if c.id is not null then
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = c.secret_ref;
    if v_secret is not null then
      if left(v_secret, 1) = '{' then
        v_key := (v_secret::jsonb ->> 'secret_key');
        if v_key is null or v_key = '' then
          v_key := (v_secret::jsonb ->> 'token');
        end if;
      else
        v_key := v_secret;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'has_integration', (c.id is not null and v_key is not null),
    'connection_id', c.id,
    'secret_key', v_key,
    'config', coalesce(c.config, '{}'::jsonb),
    'stone_code', c.config ->> 'stone_code',
    'default_serial_number', c.config ->> 'default_serial_number',
    'environment', coalesce(c.config ->> 'environment', 'producao')
  );
end $$;

-- Registra a ordem enviada para a maquininha
create or replace function sales.record_stone_pos_order(
  p_order_id uuid,
  p_stone_order_id text,
  p_terminal_serial text,
  p_amount numeric,
  p_method text,
  p_installments int,
  p_display_name text default null,
  p_raw jsonb default '{}'::jsonb
) returns sales.stone_pos_orders
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  r sales.stone_pos_orders;
begin
  perform private.require_perm('sales.write');
  insert into sales.stone_pos_orders (
    org_id, order_id, stone_order_id, terminal_serial, display_name,
    amount, method, installments, status, raw_response, created_by
  ) values (
    v_org, p_order_id, p_stone_order_id, p_terminal_serial, p_display_name,
    p_amount, upper(p_method), coalesce(p_installments, 1), 'PENDING', coalesce(p_raw, '{}'::jsonb), private.member_id()
  ) returning * into r;
  return r;
end $$;

-- Conclui o pagamento recebido da Stone (via polling do PDV ou webhook)
create or replace function sales.complete_stone_pos_payment(
  p_stone_order_id text,
  p_nsu text,
  p_auth_code text default null,
  p_card_brand text default null,
  p_raw jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s sales.stone_pos_orders;
  o sales.orders;
begin
  select * into s from sales.stone_pos_orders where stone_order_id = p_stone_order_id for update;
  if s.id is null then
    return jsonb_build_object('ok', false, 'error', 'Ordem Stone não encontrada');
  end if;

  update sales.stone_pos_orders set
    status = 'PAID',
    nsu = coalesce(p_nsu, s.nsu),
    auth_code = coalesce(p_auth_code, s.auth_code),
    card_brand = coalesce(p_card_brand, s.card_brand),
    raw_response = coalesce(p_raw, s.raw_response),
    updated_at = now()
  where id = s.id returning * into s;

  -- Se estava vinculado a um pedido do sistema, registra o pagamento no pedido
  if s.order_id is not null then
    select * into o from sales.orders where id = s.order_id;
    if o.id is not null and o.status in ('PENDING_PAYMENT', 'CONFIRMED', 'DRAFT') then
      perform sales.register_payment(jsonb_build_object(
        'order_id', s.order_id,
        'method', s.method,
        'amount', s.amount,
        'installments', s.installments,
        'acquirer', 'STONE',
        'nsu', s.nsu,
        'auth_code', s.auth_code,
        'brand', s.card_brand,
        'external_id', s.stone_order_id
      ));
    end if;
  end if;

  return jsonb_build_object('ok', true, 'stone_pos_order_id', s.id, 'order_id', s.order_id, 'status', 'PAID', 'nsu', s.nsu);
end $$;

-- Cancela uma ordem de maquininha
create or replace function sales.cancel_stone_pos_order(p_stone_order_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('sales.write');
  update sales.stone_pos_orders set status = 'CANCELLED', updated_at = now()
  where stone_order_id = p_stone_order_id and status = 'PENDING';
  return true;
end $$;
