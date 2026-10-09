-- =====================================================================
-- Suporte a múltiplas maquininhas Stone (com nome/apelido) e gestão de POS
-- =====================================================================

alter table sales.stone_pos_orders add column if not exists terminal_name text;

-- 1) Função para obter configuração da Stone com array de maquininhas cadastradas
create or replace function sales.get_stone_config() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  c core.integration_connections;
  v_secret text;
  v_key text;
  v_terminals jsonb;
  v_default_serial text;
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

  v_terminals := coalesce(c.config -> 'terminals', '[]'::jsonb);
  v_default_serial := c.config ->> 'default_serial_number';

  -- Se não houver array de terminais mas houver default_serial_number anterior, sintetiza
  if jsonb_array_length(v_terminals) = 0 and v_default_serial is not null and v_default_serial <> '' then
    v_terminals := jsonb_build_array(
      jsonb_build_object(
        'id', 'default',
        'name', 'Maquininha Padrão',
        'serial', v_default_serial,
        'is_default', true
      )
    );
  end if;

  return jsonb_build_object(
    'has_integration', (c.id is not null and v_key is not null),
    'connection_id', c.id,
    'secret_key', v_key,
    'config', coalesce(c.config, '{}'::jsonb),
    'stone_code', c.config ->> 'stone_code',
    'default_serial_number', v_default_serial,
    'terminals', v_terminals,
    'environment', coalesce(c.config ->> 'environment', 'producao')
  );
end $$;

-- 2) Função para salvar / atualizar a lista de maquininhas Stone com nomes
create or replace function sales.save_stone_terminals(p_terminals jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  c core.integration_connections;
  v_default_serial text := null;
  elem jsonb;
begin
  perform private.require_perm('sales.write');
  select * into c from core.integration_connections
  where org_id = v_org and provider = 'STONE'
  order by updated_at desc limit 1;

  if c.id is null then
    insert into core.integration_connections (org_id, provider, capability, config, status)
    values (v_org, 'STONE', 'ACQUIRER', jsonb_build_object('terminals', p_terminals), 'PENDING')
    returning * into c;
  end if;

  if jsonb_typeof(p_terminals) = 'array' then
    for elem in select * from jsonb_array_elements(p_terminals) loop
      if (elem ->> 'is_default')::boolean is true and v_default_serial is null then
        v_default_serial := (elem ->> 'serial');
      end if;
    end loop;

    if v_default_serial is null and jsonb_array_length(p_terminals) > 0 then
      v_default_serial := (p_terminals -> 0 ->> 'serial');
    end if;
  end if;

  update core.integration_connections
  set config = coalesce(config, '{}'::jsonb) || jsonb_build_object(
    'terminals', coalesce(p_terminals, '[]'::jsonb),
    'default_serial_number', v_default_serial
  ),
  updated_at = now()
  where id = c.id
  returning * into c;

  return jsonb_build_object('ok', true, 'terminals', c.config -> 'terminals', 'default_serial', v_default_serial);
end $$;

-- 3) Atualiza record_stone_pos_order para suportar terminal_name
create or replace function sales.record_stone_pos_order(
  p_order_id uuid,
  p_stone_order_id text,
  p_terminal_serial text,
  p_amount numeric,
  p_method text,
  p_installments int,
  p_display_name text default null,
  p_raw jsonb default '{}'::jsonb,
  p_terminal_name text default null
) returns sales.stone_pos_orders
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  r sales.stone_pos_orders;
begin
  perform private.require_perm('sales.write');
  insert into sales.stone_pos_orders (
    org_id, order_id, stone_order_id, terminal_serial, terminal_name, amount, method, installments, display_name, raw_response, created_by
  ) values (
    v_org, p_order_id, p_stone_order_id, p_terminal_serial, p_terminal_name, p_amount, p_method, p_installments, p_display_name, p_raw, auth.uid()
  ) returning * into r;

  return r;
end $$;

revoke all on function sales.save_stone_terminals(jsonb) from public;
grant execute on function sales.save_stone_terminals(jsonb) to authenticated;
