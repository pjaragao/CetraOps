-- =====================================================================
-- App do PDV na própria maquininha (Smart POS Stone, integração por Deeplink do SDK Android)
--
-- A cobrança acontece no app de pagamento da Stone, dentro do terminal: não há ordem no Pagar.me para o servidor conferir.
-- Por isso o resultado só é aceito de uma maquininha PAREADA (token próprio do aparelho, guardado só como hash) e
-- com quem está logado com sales.write; o valor aprovado tem de ser o valor aberto, e cada ATK (chave da Stone) vale uma vez.
-- A conferência com a Stone fica para a conciliação do adquirente (ATK/autorização no pagamento).
--
-- 1) sales.pos_devices: maquininhas com o app (loja, série, modelo, hash do token, código de pareamento de 15 min)
-- 2) sales.stone_pos_orders: origem (CONNECT = Pagar.me/POI · DEEPLINK = app no terminal), aparelho, ATK e ITK
-- 3) RPCs: pareamento (sócio cria o código; servidor troca o código pelo token), cobrança Deeplink (abrir, confirmar, desistir/estornar)
-- Códigos de erro: P0002 não encontrado · P0005 pagamento · 22023 dado inválido · 42501 permissão.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Maquininhas com o app
-- ---------------------------------------------------------------------
create table if not exists sales.pos_devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  store_id uuid not null references core.stores(id),
  name text not null,
  serial text,
  model text,
  app_version text,
  token_hash text,                                             -- sha256 (hex) do token do aparelho; o token só existe no terminal
  pairing_code_hash text,                                      -- sha256 (hex) do código mostrado ao sócio; some ao parear
  pairing_expires_at timestamptz,
  paired_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists pos_devices_token_uq on sales.pos_devices (token_hash) where token_hash is not null;
create unique index if not exists pos_devices_pairing_uq on sales.pos_devices (pairing_code_hash) where pairing_code_hash is not null;
create index if not exists pos_devices_org_idx on sales.pos_devices (org_id, store_id);

select private.apply_rls('sales', array['pos_devices'], 'core.admin', 'core.admin');
select private.rpc_only('sales', array['pos_devices']);
revoke select on sales.pos_devices from authenticated;            -- os hashes não saem do banco: a tela usa sales.list_pos_devices

-- ---------------------------------------------------------------------
-- 2) Cobranças da maquininha: origem, aparelho e chaves da Stone
-- ---------------------------------------------------------------------
alter table sales.stone_pos_orders add column if not exists source text not null default 'CONNECT';
alter table sales.stone_pos_orders add column if not exists device_id uuid references sales.pos_devices(id);
alter table sales.stone_pos_orders add column if not exists atk text;
alter table sales.stone_pos_orders add column if not exists itk text;
do $$ begin
  alter table sales.stone_pos_orders add constraint stone_pos_orders_source_ck check (source in ('CONNECT', 'DEEPLINK'));
exception when duplicate_object then null; end $$;
create unique index if not exists stone_pos_orders_atk_uq on sales.stone_pos_orders (org_id, atk) where atk is not null;

-- ---------------------------------------------------------------------
-- 3a) Pareamento
-- ---------------------------------------------------------------------
-- Sócio: cria a maquininha (ou renova o código de uma já cadastrada). O código é gerado no servidor web; aqui só chega o hash.
create or replace function sales.create_pos_device_pairing(p_store uuid, p_name text, p_code_hash text, p_device uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); d sales.pos_devices;
begin
  perform private.require_perm('core.admin');
  if coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'Código de pareamento inválido' using errcode = '22023'; end if;
  if p_device is null then
    if not exists (select 1 from core.stores where id = p_store and org_id = v_org) then raise exception 'Loja inválida' using errcode = '22023'; end if;
    insert into sales.pos_devices (org_id, store_id, name, pairing_code_hash, pairing_expires_at, created_by)
    values (v_org, p_store, left(coalesce(nullif(trim(p_name), ''), 'Maquininha'), 60), p_code_hash, now() + interval '15 minutes', private.member_id())
    returning * into d;
  else
    -- novo pareamento de um aparelho já cadastrado (troca de terminal, app reinstalado): o token antigo deixa de valer
    update sales.pos_devices set pairing_code_hash = p_code_hash, pairing_expires_at = now() + interval '15 minutes', token_hash = null, revoked_at = null,
           name = left(coalesce(nullif(trim(p_name), ''), name), 60), updated_at = now()
    where id = p_device and org_id = v_org returning * into d;
    if d.id is null then raise exception 'Maquininha não encontrada' using errcode = 'P0002'; end if;
  end if;
  return jsonb_build_object('id', d.id, 'expires_at', d.pairing_expires_at);
end $$;

-- Sócio: lista sem os hashes
create or replace function sales.list_pos_devices() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'store_id', d.store_id, 'store_name', s.name, 'name', d.name, 'serial', d.serial, 'model', d.model, 'app_version', d.app_version,
           'paired', d.token_hash is not null, 'pairing_pending', d.pairing_code_hash is not null and d.pairing_expires_at > now(),
           'pairing_expires_at', d.pairing_expires_at, 'paired_at', d.paired_at, 'last_seen_at', d.last_seen_at, 'revoked', d.revoked_at is not null
         ) order by d.revoked_at nulls first, d.created_at), '[]'::jsonb)
  from sales.pos_devices d join core.stores s on s.id = d.store_id
  where d.org_id = private.org_id() and private.has_perm('core.admin')
$$;

create or replace function sales.revoke_pos_device(p_device uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('core.admin');
  update sales.pos_devices set revoked_at = now(), token_hash = null, pairing_code_hash = null, updated_at = now()
  where id = p_device and org_id = private.org_id() and revoked_at is null;
  return found;
end $$;

-- Servidor (service_role): o app manda o código; o servidor gera o token e grava o hash. Uma vez só, dentro dos 15 minutos.
create or replace function sales.pair_pos_device(p_code_hash text, p_token_hash text, p_serial text, p_model text, p_app_version text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d sales.pos_devices; v_store core.stores;
begin
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'Token inválido' using errcode = '22023'; end if;
  update sales.pos_devices set token_hash = p_token_hash, pairing_code_hash = null, pairing_expires_at = null, paired_at = now(), last_seen_at = now(),
         serial = left(nullif(trim(p_serial), ''), 40), model = left(nullif(trim(p_model), ''), 60), app_version = left(nullif(trim(p_app_version), ''), 20), updated_at = now()
  where pairing_code_hash = p_code_hash and pairing_expires_at > now() and revoked_at is null
  returning * into d;
  if d.id is null then return jsonb_build_object('ok', false, 'error', 'Código inválido ou vencido: gere outro em Configurações › Integrações › Stone'); end if;
  select * into v_store from core.stores where id = d.store_id;
  return jsonb_build_object('ok', true, 'device_id', d.id, 'org_id', d.org_id, 'store_id', d.store_id, 'store_name', v_store.name, 'name', d.name);
end $$;

-- Servidor (service_role): identifica o aparelho pelo token (e marca o último contato)
create or replace function sales.pos_device_by_token(p_token_hash text, p_app_version text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d sales.pos_devices; v_store core.stores;
begin
  update sales.pos_devices set last_seen_at = now(), app_version = coalesce(left(nullif(trim(p_app_version), ''), 20), app_version)
  where token_hash = p_token_hash and revoked_at is null returning * into d;
  if d.id is null then return null; end if;
  select * into v_store from core.stores where id = d.store_id;
  return jsonb_build_object('device_id', d.id, 'org_id', d.org_id, 'store_id', d.store_id, 'store_name', v_store.name, 'name', d.name, 'serial', d.serial);
end $$;

-- ---------------------------------------------------------------------
-- 3b) Cobrança pelo Deeplink (quem chama: o operador logado no app, com o token da maquininha conferido pelo servidor)
-- ---------------------------------------------------------------------
create or replace function private.pos_device_for_user(p_token_hash text) returns sales.pos_devices
language plpgsql stable security definer set search_path = '' as $$
declare d sales.pos_devices;
begin
  select * into d from sales.pos_devices where token_hash = p_token_hash and revoked_at is null and org_id = private.org_id();
  if d.id is null then raise exception 'Maquininha não pareada ou desativada' using errcode = '42501'; end if;
  if not private.can_store(d.store_id) then raise exception 'Sem acesso à loja desta maquininha' using errcode = '42501'; end if;
  return d;
end $$;

-- Abre a cobrança antes de chamar o app de pagamento: o valor e a forma ficam gravados aqui
create or replace function sales.open_stone_deeplink_charge(p_device_token_hash text, p_amount numeric, p_method text, p_installments integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d sales.pos_devices; r sales.stone_pos_orders; v_method text := upper(coalesce(p_method, ''));
begin
  perform private.require_perm('sales.write');
  d := private.pos_device_for_user(p_device_token_hash);
  if p_amount is null or p_amount <= 0 or p_amount > 999999.99 then raise exception 'Valor inválido' using errcode = '22023'; end if;
  if v_method not in ('CREDIT', 'DEBIT', 'PIX') then raise exception 'Forma de pagamento inválida' using errcode = '22023'; end if;
  if coalesce(p_installments, 1) not between 1 and 12 or (v_method <> 'CREDIT' and coalesce(p_installments, 1) <> 1) then
    raise exception 'Parcelas inválidas' using errcode = '22023';
  end if;
  insert into sales.stone_pos_orders (org_id, stone_order_id, terminal_serial, terminal_name, display_name, amount, method, installments, status, source, device_id, created_by)
  values (d.org_id, 'dl_' || replace(gen_random_uuid()::text, '-', ''), coalesce(d.serial, d.id::text), d.name, 'Venda no app da maquininha',
          round(p_amount, 2), v_method, greatest(coalesce(p_installments, 1), 1), 'PENDING', 'DEEPLINK', d.id, auth.uid())
  returning * into r;
  return jsonb_build_object('charge_id', r.stone_order_id, 'amount', r.amount, 'method', r.method, 'installments', r.installments);
end $$;

-- O app de pagamento da Stone aprovou: grava o retorno (valor tem de bater; ATK único)
create or replace function sales.confirm_stone_deeplink_charge(p_device_token_hash text, p_charge text, p_paid_amount numeric, p_atk text, p_itk text,
                                                               p_auth_code text, p_brand text, p_installments integer, p_raw jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d sales.pos_devices; s sales.stone_pos_orders;
begin
  perform private.require_perm('sales.write');
  d := private.pos_device_for_user(p_device_token_hash);
  select * into s from sales.stone_pos_orders where stone_order_id = p_charge and org_id = d.org_id and source = 'DEEPLINK' for update;
  if s.id is null or s.device_id is distinct from d.id then raise exception 'Cobrança não encontrada nesta maquininha' using errcode = 'P0002'; end if;
  if s.status = 'PAID' then
    if s.atk = p_atk then return jsonb_build_object('ok', true, 'already', true, 'charge_id', s.stone_order_id, 'amount', s.amount); end if;
    raise exception 'Cobrança já paga com outra transação' using errcode = 'P0005';
  end if;
  if s.status <> 'PENDING' then raise exception 'Cobrança em situação %', s.status using errcode = 'P0005'; end if;
  if coalesce(p_atk, '') !~ '^[A-Za-z0-9._-]{4,64}$' then raise exception 'Retorno da Stone sem ATK' using errcode = '22023'; end if;
  if round(coalesce(p_paid_amount, 0), 2) <> s.amount then
    -- grava a falha (com o ATK, para o estorno) e devolve o erro sem desfazer a gravação
    update sales.stone_pos_orders set status = 'FAILED', itk = left(p_itk, 80), raw_response = coalesce(p_raw, '{}') || jsonb_build_object('atk', p_atk), updated_at = now() where id = s.id;
    return jsonb_build_object('ok', false, 'error', format('Valor aprovado (%s) diferente do cobrado (%s): estorne na maquininha', p_paid_amount, s.amount));
  end if;
  begin
    update sales.stone_pos_orders set status = 'PAID', atk = p_atk, itk = left(p_itk, 80), nsu = p_atk, auth_code = left(nullif(p_auth_code, ''), 20),
           card_brand = left(nullif(p_brand, ''), 30), installments = case when s.method = 'CREDIT' then greatest(coalesce(p_installments, s.installments), 1) else 1 end,
           raw_response = coalesce(p_raw, '{}'), updated_at = now()
    where id = s.id returning * into s;
  exception when unique_violation then
    raise exception 'Esta transação da Stone já foi usada em outra cobrança' using errcode = 'P0005';
  end;
  return jsonb_build_object('ok', true, 'charge_id', s.stone_order_id, 'amount', s.amount, 'method', s.method, 'installments', s.installments,
                            'nsu', s.nsu, 'auth_code', s.auth_code, 'brand', s.card_brand);
end $$;

-- Desistência (o app de pagamento voltou sem aprovar) ou estorno feito na maquininha de uma cobrança que não entrou em venda
create or replace function sales.close_stone_deeplink_charge(p_device_token_hash text, p_charge text, p_status text, p_raw jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d sales.pos_devices; s sales.stone_pos_orders; v_status text := upper(coalesce(p_status, ''));
begin
  perform private.require_perm('sales.write');
  d := private.pos_device_for_user(p_device_token_hash);
  if v_status not in ('CANCELLED', 'FAILED', 'REFUNDED') then raise exception 'Situação inválida' using errcode = '22023'; end if;
  select * into s from sales.stone_pos_orders where stone_order_id = p_charge and org_id = d.org_id and source = 'DEEPLINK' and device_id = d.id for update;
  if s.id is null then raise exception 'Cobrança não encontrada nesta maquininha' using errcode = 'P0002'; end if;
  if v_status = 'REFUNDED' then
    if s.status <> 'PAID' then raise exception 'Só uma cobrança paga pode ser estornada' using errcode = 'P0005'; end if;
    if s.order_id is not null then raise exception 'Cobrança já está numa venda: cancele ou devolva pela venda' using errcode = 'P0005'; end if;
  elsif s.status <> 'PENDING' then
    return jsonb_build_object('ok', true, 'status', s.status);
  end if;
  update sales.stone_pos_orders set status = v_status, raw_response = raw_response || jsonb_build_object('close', coalesce(p_raw, '{}')), updated_at = now()
  where id = s.id;
  return jsonb_build_object('ok', true, 'status', v_status);
end $$;

-- ---------------------------------------------------------------------
-- 4) Privilégios
-- ---------------------------------------------------------------------
insert into private.internal_functions (fqname) values
  ('sales.pair_pos_device'), ('sales.pos_device_by_token'), ('private.pos_device_for_user')
on conflict do nothing;
select private.lock_functions();
