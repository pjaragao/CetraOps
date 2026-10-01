-- =====================================================================
-- RPCs usadas pelo app web: inbox (envio humano, rascunhos), cliente rápido no PDV, caixa
-- =====================================================================

-- Regra de janela no SERVIDOR (espelha packages/domain/src/messaging.ts)
create or replace function omni.check_send_window(p_conversation uuid, p_author text)
returns table (allowed boolean, mode text, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare
  c record;
  v_elapsed interval;
  v_tiktok boolean;
begin
  select cv.last_inbound_at, ca.channel, cv.org_id into c
  from omni.conversations cv join omni.channel_accounts ca on ca.id = cv.channel_account_id
  where cv.id = p_conversation;
  v_elapsed := case when c.last_inbound_at is null then interval '100 years' else now() - c.last_inbound_at end;

  if c.channel = 'WHATSAPP' then
    if v_elapsed <= interval '24 hours' then return query select true, 'FREE_FORM', null::text;
    else return query select false, 'TEMPLATE_ONLY', 'Janela de 24h do WhatsApp fechada: use um template aprovado'; end if;
  elsif c.channel = 'INSTAGRAM' then
    if v_elapsed <= interval '24 hours' then return query select true, 'FREE_FORM', null::text;
    elsif v_elapsed <= interval '7 days' and p_author = 'HUMAN' then return query select true, 'HUMAN_AGENT_TAG', null::text;
    elsif v_elapsed <= interval '7 days' then return query select false, 'BLOCKED', 'Entre 24h e 7 dias só um humano pode responder';
    else return query select false, 'BLOCKED', 'Janela do Instagram encerrada (mais de 7 dias)'; end if;
  elsif c.channel = 'TELEGRAM' then
    if c.last_inbound_at is not null then return query select true, 'FREE_FORM', null::text;
    else return query select false, 'BLOCKED', 'O bot só fala com quem iniciou a conversa'; end if;
  else
    select enabled into v_tiktok from core.feature_flags where org_id = c.org_id and key = 'channel.tiktok';
    if coalesce(v_tiktok, false) and v_elapsed <= interval '48 hours' then return query select true, 'FREE_FORM', null::text;
    else return query select false, 'BLOCKED', 'Canal TikTok indisponível'; end if;
  end if;
end $$;

-- Envio por humano: valida janela, grava a mensagem QUEUED e enfileira para o worker enviar
create or replace function omni.send_message(p_conversation uuid, p_body text, p_draft uuid default null, p_edited boolean default false)
returns omni.messages
language plpgsql security definer set search_path = '' as $$
declare
  c omni.conversations;
  w record;
  m omni.messages;
begin
  perform private.require_perm('omni.write');
  select * into c from omni.conversations where id = p_conversation;
  if c.id is null or (coalesce(auth.role(), '') = 'authenticated' and c.org_id <> private.org_id()) then
    raise exception 'Conversa não encontrada' using errcode = 'P0002';
  end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Mensagem vazia' using errcode = '22023'; end if;

  select * into w from omni.check_send_window(p_conversation, 'HUMAN');
  if not w.allowed then raise exception '%', w.reason using errcode = 'P0010'; end if;

  insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, author_member_id,
                             body, status, client_dedupe_key, payload)
  values (c.org_id, c.id, c.channel_account_id, 'OUT', 'HUMAN', private.member_id(), trim(p_body), 'QUEUED',
          gen_random_uuid()::text, jsonb_build_object('send_mode', w.mode))
  returning * into m;

  if p_draft is not null then
    update omni.message_drafts set status = case when p_edited then 'EDITED_SENT' else 'SENT' end,
           final_message_id = m.id, decided_by = private.member_id()
    where id = p_draft and conversation_id = c.id;
  end if;

  perform private.enqueue('outbound_messages', jsonb_build_object('message_id', m.id, 'org_id', c.org_id));
  return m;
end $$;

create or replace function omni.discard_draft(p_draft uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('omni.write');
  update omni.message_drafts set status = 'DISCARDED', discard_reason = p_reason, decided_by = private.member_id()
  where id = p_draft and status = 'PENDING'
    and (coalesce(auth.role(), '') <> 'authenticated' or org_id = private.org_id());
end $$;

create or replace function omni.mark_read(p_conversation uuid)
returns void language sql security definer set search_path = '' as $$
  update omni.conversations set unread_count = 0
  where id = p_conversation and org_id = private.org_id() and private.has_perm('omni.read');
$$;

-- PDV: identifica/cadastra cliente pelo telefone e registra consentimentos marcados no balcão
create or replace function crm.quick_customer(p_phone text, p_name text default null, p_marketing_whatsapp boolean default false)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_party uuid; v_org uuid := private.org_id();
begin
  perform private.require_perm('crm.write');
  if v_org is null then raise exception 'Sem organização no token' using errcode = '42501'; end if;
  v_party := crm.resolve_identity(v_org, 'WHATSAPP', p_phone, p_name, 'PDV');
  if p_name is not null and trim(p_name) <> '' then
    update crm.parties set display_name = trim(p_name) where id = v_party and display_name = p_phone;
  end if;
  insert into crm.consents (org_id, party_id, purpose, granted, legal_basis, evidence, recorded_by)
  values (v_org, v_party, 'TRANSACTIONAL', true, 'CONTRACT', '{"channel": "PDV"}', private.member_id());
  if p_marketing_whatsapp then
    insert into crm.consents (org_id, party_id, purpose, granted, legal_basis, evidence, recorded_by)
    values (v_org, v_party, 'MARKETING_WHATSAPP', true, 'CONSENT', '{"channel": "PDV", "text_version": "v1"}', private.member_id());
  end if;
  return v_party;
end $$;

-- Caixa: abrir e fechar (fechamento cego: operadora informa o contado, sistema calcula a diferença)
create or replace function sales.open_cash_session(p_register uuid, p_opening_float numeric)
returns sales.cash_sessions
language plpgsql security definer set search_path = '' as $$
declare r sales.cash_registers; s sales.cash_sessions;
begin
  perform private.require_perm('sales.write');
  select * into r from sales.cash_registers where id = p_register;
  if r.id is null or not private.can_store(r.store_id) then raise exception 'Caixa inválido' using errcode = '42501'; end if;
  insert into sales.cash_sessions (org_id, register_id, store_id, opened_by, opening_float)
  values (r.org_id, r.id, r.store_id, private.member_id(), coalesce(p_opening_float, 0))
  returning * into s;
  return s;
end $$;

create or replace function sales.cash_session_expected(p_session uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select s.opening_float + coalesce((select sum(m.amount) from sales.cash_session_movements m where m.session_id = s.id), 0)
  from sales.cash_sessions s where s.id = p_session
$$;

create or replace function sales.cash_movement(p_session uuid, p_type text, p_amount numeric, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare s sales.cash_sessions;
begin
  perform private.require_perm('sales.write');
  if p_type not in ('SUPRIMENTO', 'SANGRIA') then raise exception 'Tipo inválido'; end if;
  select * into s from sales.cash_sessions where id = p_session and status = 'OPEN';
  if s.id is null or not private.can_store(s.store_id) then raise exception 'Caixa não está aberto' using errcode = 'P0002'; end if;
  insert into sales.cash_session_movements (org_id, session_id, type, amount, reason, created_by)
  values (s.org_id, s.id, p_type, case when p_type = 'SANGRIA' then -abs(p_amount) else abs(p_amount) end, p_reason, private.member_id());
end $$;

create or replace function sales.close_cash_session(p_session uuid, p_counted numeric, p_notes text default null)
returns sales.cash_sessions
language plpgsql security definer set search_path = '' as $$
declare s sales.cash_sessions; v_expected numeric;
begin
  perform private.require_perm('sales.write');
  select * into s from sales.cash_sessions where id = p_session and status = 'OPEN' for update;
  if s.id is null or not private.can_store(s.store_id) then raise exception 'Caixa não está aberto' using errcode = 'P0002'; end if;
  v_expected := sales.cash_session_expected(s.id);
  update sales.cash_sessions set status = 'CLOSED', closed_at = now(), closed_by = private.member_id(),
         expected_cash = v_expected, counted_cash = p_counted, difference = p_counted - v_expected, notes = p_notes
  where id = s.id returning * into s;
  return s;
end $$;

-- Importação de catálogo (planilha dos sócios): upsert idempotente de produto/variante/preço
-- p = [{reference_code, name, gender, category?, ncm?, color, color_code?, size, gtin?, price, collection?}]
create or replace function catalog.import_rows(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id();
  r jsonb;
  v_cat uuid; v_color uuid; v_prod uuid; v_var uuid; v_pl uuid; v_grid uuid;
  v_products int := 0; v_variants int := 0; v_prices int := 0;
  v_errors jsonb := '[]';
  v_i int := 0;
  v_sku text;
begin
  perform private.require_perm('catalog.write');
  if v_org is null then raise exception 'Sem organização no token' using errcode = '42501'; end if;
  select id into v_pl from catalog.price_lists where org_id = v_org and is_default;

  for r in select * from jsonb_array_elements(p) loop
    v_i := v_i + 1;
    begin
      if coalesce(r ->> 'reference_code', '') = '' or coalesce(r ->> 'size', '') = '' or coalesce(r ->> 'name', '') = '' then
        raise exception 'referência, nome e tamanho são obrigatórios';
      end if;
      if upper(r ->> 'gender') not in ('FEM', 'MASC', 'UNISSEX') then
        raise exception 'gênero deve ser FEM, MASC ou UNISSEX';
      end if;

      v_cat := null;
      if coalesce(r ->> 'category', '') <> '' then
        insert into catalog.categories (org_id, name, ncm_default) values (v_org, trim(r ->> 'category'), nullif(r ->> 'ncm', ''))
        on conflict (org_id, parent_id, name) do nothing;
        select id into v_cat from catalog.categories where org_id = v_org and name = trim(r ->> 'category') and parent_id is null;
      end if;

      insert into catalog.colors (org_id, name, code) values (v_org, trim(coalesce(r ->> 'color', 'Única')),
        upper(coalesce(nullif(r ->> 'color_code', ''), left(regexp_replace(private.norm(coalesce(r ->> 'color', 'UN')), '[^a-z]', '', 'g'), 3))))
      on conflict (org_id, name) do nothing;
      select id into v_color from catalog.colors where org_id = v_org and name = trim(coalesce(r ->> 'color', 'Única'));

      select id into v_grid from catalog.size_grids where org_id = v_org
        and name = case upper(r ->> 'gender') when 'MASC' then 'Masculino P-GG' else 'Feminino PP-GG' end;

      insert into catalog.products (org_id, category_id, size_grid_id, reference_code, name, gender, ncm, status)
      values (v_org, v_cat, v_grid, upper(trim(r ->> 'reference_code')), trim(r ->> 'name'),
              upper(r ->> 'gender')::catalog.gender, nullif(regexp_replace(coalesce(r ->> 'ncm', ''), '\D', '', 'g'), ''), 'ACTIVE')
      on conflict (org_id, reference_code) do update set name = excluded.name, category_id = coalesce(excluded.category_id, catalog.products.category_id),
        ncm = coalesce(excluded.ncm, catalog.products.ncm)
      returning id into v_prod;
      v_products := v_products + 1;

      v_sku := upper(trim(r ->> 'reference_code')) || '-' || (select code from catalog.colors where id = v_color) || '-' || upper(trim(r ->> 'size'));
      insert into catalog.variants (org_id, product_id, color_id, size, sku, gtin)
      values (v_org, v_prod, v_color, upper(trim(r ->> 'size')), v_sku, nullif(trim(coalesce(r ->> 'gtin', '')), ''))
      on conflict (product_id, color_id, size) do update set gtin = coalesce(excluded.gtin, catalog.variants.gtin)
      returning id into v_var;
      v_variants := v_variants + 1;

      if (r ->> 'price') is not null and (r ->> 'price') <> '' then
        update catalog.prices set valid_to = now()
        where price_list_id = v_pl and product_id = v_prod and valid_to is null and price <> (r ->> 'price')::numeric;
        if not exists (select 1 from catalog.prices where price_list_id = v_pl and product_id = v_prod and valid_to is null) then
          insert into catalog.prices (org_id, price_list_id, product_id, price) values (v_org, v_pl, v_prod, (r ->> 'price')::numeric);
          v_prices := v_prices + 1;
        end if;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_object('linha', v_i, 'erro', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('linhas', v_i, 'produtos', v_products, 'variantes', v_variants, 'precos', v_prices, 'erros', v_errors);
end $$;
