-- =====================================================================
-- Central: a assistente de IA da equipe (plano em docs/plano-ia-integrada.md).
--
-- A Central roda no servidor web com o JWT de quem está usando: RLS e permissões valem como nas telas.
--   • Ler é livre (dentro das permissões). GRAVAR é sempre em dois passos: a IA PROPÕE (ai.assistant_propose grava a ação e a prévia
--     calculada pelo banco) e uma PESSOA confirma com um clique (ai.assistant_execute executa o que está gravado, uma vez só,
--     dentro da validade, chamando as mesmas funções de negócio das telas, que conferem as permissões de novo).
--   • CPF da cliente: criptografado (pgcrypto, chave no Vault) + HMAC para achar sem descriptografar; só o final aparece.
--   • sales.quote_order: prévia de venda (preço vigente, cupom, total e estoque) sem gravar nada.
--   • Custos: cada chamada ao modelo vira linha em ai.runs (com a pessoa) e respeita o orçamento diário da rota.
-- Códigos de erro: P0460 dado inválido · P0461 situação não permite · P0462 não encontrado · P0470 CPF inválido · P0471 CPF de outra pessoa.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Permissão, rotas de IA, políticas e chave liga/desliga
-- ---------------------------------------------------------------------
insert into core.permission_catalog (key, area, label, description, position) values
  ('ai.assistant', 'Inteligência', 'Usar a Central (assistente de IA)', 'Conversar com a Central por texto, voz, foto e código de barras. Ela só faz o que a pessoa já pode fazer e pede confirmação antes de gravar.', 102)
on conflict (key) do update set area = excluded.area, label = excluded.label, description = excluded.description, position = excluded.position;
insert into core.role_permissions (role_id, permission_key)
select id, 'ai.assistant' from core.roles where key in ('seller', 'finance', 'hr', 'accountant') on conflict do nothing;

insert into ai.model_routes (org_id, task, primary_model, fallback_models, params, requires_tools, requires_json_schema, daily_budget_usd)
select o.id, r.task, r.model, r.fallbacks, r.params, r.tools, r.schema, r.budget
from core.orgs o, (values
  ('assistant', 'anthropic/claude-sonnet-4.5', '{}'::text[], '{"temperature": 0.2, "max_tokens": 1200}'::jsonb, true, false, 5.00),
  ('vision_extract', 'google/gemini-2.5-flash', '{}'::text[], '{"temperature": 0}'::jsonb, false, true, 3.00)
) as r(task, model, fallbacks, params, tools, schema, budget)
on conflict (org_id, task) do nothing;

insert into core.settings (org_id, key, value)
select id, 'assistant_policies', '{"action_ttl_minutes": 15, "max_settle_amount": 5000, "max_messages_per_day": 300, "keep_threads_days": 90}'::jsonb from core.orgs
on conflict (org_id, key) do nothing;

insert into core.feature_flags (org_id, key, enabled) select id, 'ai.assistant', true from core.orgs on conflict (org_id, key) do nothing;

alter table ai.runs add column if not exists member_id uuid references core.members(id) on delete set null;
create index if not exists runs_member_idx on ai.runs (org_id, member_id, created_at desc) where member_id is not null;

-- ---------------------------------------------------------------------
-- 2) Conversas, mensagens, ações propostas e arquivos enviados
-- ---------------------------------------------------------------------
create table ai.assistant_threads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  member_id uuid not null references core.members(id) on delete cascade,
  title text,
  context jsonb not null default '{}',                                 -- tela/registro de onde a conversa começou
  channel text not null default 'WEB' check (channel in ('WEB', 'WHATSAPP', 'TELEGRAM')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index assistant_threads_member_idx on ai.assistant_threads (org_id, member_id, updated_at desc);

create table ai.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  thread_id uuid not null references ai.assistant_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content jsonb not null,                                              -- {text?, transcript?, cards?, tool_calls?, uploads?}
  run_id uuid references ai.runs(id) on delete set null,
  created_at timestamptz not null default now()
);
create index assistant_messages_thread_idx on ai.assistant_messages (thread_id, created_at);

create table ai.assistant_actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  thread_id uuid references ai.assistant_threads(id) on delete set null,
  member_id uuid not null references core.members(id),
  tool text not null,
  args jsonb not null,
  preview jsonb not null default '{}',                                 -- o que o cartão mostrou (valores do banco)
  summary text,
  status text not null default 'PROPOSED' check (status in ('PROPOSED', 'EXECUTED', 'FAILED', 'CANCELLED', 'EXPIRED')),
  idempotency_key uuid not null default gen_random_uuid(),
  expires_at timestamptz not null,
  result jsonb,
  target_type text,
  target_id uuid,
  error text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index assistant_actions_member_idx on ai.assistant_actions (org_id, member_id, created_at desc);
create index assistant_actions_open_idx on ai.assistant_actions (expires_at) where status = 'PROPOSED';

create table ai.assistant_uploads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  member_id uuid not null references core.members(id) on delete cascade,
  thread_id uuid references ai.assistant_threads(id) on delete set null,
  path text,                                                           -- bucket assistant-uploads; nulo quando o arquivo já foi apagado
  mime text not null,
  kind text not null default 'OTHER' check (kind in ('ID_DOC', 'ADDRESS_PROOF', 'BOLETO', 'PIX', 'RECEIPT', 'NFE', 'CONTRACT', 'LABEL', 'AUDIO', 'OTHER')),
  sha256 text,
  extracted jsonb,
  created_at timestamptz not null default now()
);
create index assistant_uploads_member_idx on ai.assistant_uploads (org_id, member_id, created_at desc);

select private.attach_updated_at('ai');

-- Cada pessoa só vê (e escreve) as próprias conversas; as ações só mudam pelas funções abaixo.
alter table ai.assistant_threads enable row level security;
alter table ai.assistant_messages enable row level security;
alter table ai.assistant_actions enable row level security;
alter table ai.assistant_uploads enable row level security;
create policy p_own on ai.assistant_threads for all to authenticated
  using (org_id = (select private.org_id()) and member_id = (select private.member_id()))
  with check (org_id = (select private.org_id()) and member_id = (select private.member_id()));
create policy p_own on ai.assistant_messages for all to authenticated
  using (exists (select 1 from ai.assistant_threads t where t.id = thread_id and t.member_id = (select private.member_id())))
  with check (org_id = (select private.org_id()) and exists (select 1 from ai.assistant_threads t where t.id = thread_id and t.member_id = (select private.member_id())));
create policy p_own on ai.assistant_actions for select to authenticated
  using (org_id = (select private.org_id()) and member_id = (select private.member_id()));
create policy p_own on ai.assistant_uploads for all to authenticated
  using (org_id = (select private.org_id()) and member_id = (select private.member_id()))
  with check (org_id = (select private.org_id()) and member_id = (select private.member_id()));
grant select, insert, update, delete on ai.assistant_threads, ai.assistant_messages, ai.assistant_uploads to authenticated;
grant select on ai.assistant_actions to authenticated;

-- Arquivos enviados à Central: bucket privado, pasta <org>/<pessoa>/...; documento de identidade é apagado logo após a leitura
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('assistant-uploads', 'assistant-uploads', false, 15728640,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf', 'application/xml', 'text/xml',
              'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-m4a'])
on conflict (id) do nothing;
create policy assistant_uploads_rw on storage.objects for all to authenticated
  using (bucket_id = 'assistant-uploads' and (storage.foldername(name))[1] = (select private.org_id())::text
         and (storage.foldername(name))[2] = (select private.member_id())::text)
  with check (bucket_id = 'assistant-uploads' and (storage.foldername(name))[1] = (select private.org_id())::text
              and (storage.foldername(name))[2] = (select private.member_id())::text);

-- ---------------------------------------------------------------------
-- 3) CPF da cliente: criptografado, com HMAC para busca e só o final visível
-- ---------------------------------------------------------------------
-- A chave nasce aqui, uma vez por banco (no Vault, nunca em arquivo). Perder a chave = perder os CPFs: ela entra no backup do banco.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'crm_cpf_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'crm_cpf_key', 'Chave do CPF das clientes (criptografia e HMAC)');
  end if;
end $$;

create or replace function private.cpf_key() returns text
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = 'crm_cpf_key';
  if v is null then raise exception 'Chave do CPF ausente no Vault (crm_cpf_key)'; end if;
  return v;
end $$;

create or replace function private.cpf_hmac(p_cpf text) returns text
language sql stable security definer set search_path = '' as $$
  select encode(extensions.hmac(regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'), private.cpf_key(), 'sha256'), 'hex')
$$;

-- Grava o CPF de uma pessoa. Quem tem crm.write grava o CPF de quem ainda não tem; trocar um CPF já gravado exige crm.sensitive.
create or replace function private.set_party_cpf(p_party uuid, p_cpf text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'); v_hmac text; v_other record; v_old crm.party_sensitive;
begin
  if not private.valid_cpf(v_cpf) then raise exception 'CPF inválido (confira os dígitos)' using errcode = 'P0470'; end if;
  if not exists (select 1 from crm.parties where id = p_party and org_id = v_org and kind = 'PERSON' and merged_into_id is null) then
    raise exception 'Pessoa não encontrada' using errcode = 'P0462';
  end if;
  v_hmac := private.cpf_hmac(v_cpf);
  select p.id, p.display_name into v_other from crm.party_sensitive s join crm.parties p on p.id = s.party_id
  where s.org_id = v_org and s.cpf_hmac = v_hmac and s.party_id <> p_party;
  if v_other.id is not null then
    raise exception 'Este CPF já está no cadastro de %', v_other.display_name using errcode = 'P0471', detail = v_other.id::text;
  end if;
  select * into v_old from crm.party_sensitive where party_id = p_party;
  if v_old.cpf_hmac is not null and v_old.cpf_hmac <> v_hmac and not private.has_perm('crm.sensitive') then
    raise exception 'Trocar um CPF já cadastrado exige a permissão de dados sensíveis' using errcode = '42501';
  end if;
  insert into crm.party_sensitive (party_id, org_id, cpf_encrypted, cpf_hmac, cpf_last4, updated_at)
  values (p_party, v_org, extensions.pgp_sym_encrypt(v_cpf, private.cpf_key()), v_hmac, right(v_cpf, 4), now())
  on conflict (party_id) do update set cpf_encrypted = excluded.cpf_encrypted, cpf_hmac = excluded.cpf_hmac, cpf_last4 = excluded.cpf_last4, updated_at = now();
  insert into audit.log (org_id, actor_type, actor_id, action, table_name, record_id, after)
  values (v_org, 'USER', private.member_id(), case when v_old.party_id is null then 'CPF_SET' else 'CPF_CHANGED' end, 'crm.party_sensitive', p_party::text,
          jsonb_build_object('cpf_last4', right(v_cpf, 4)));
  return jsonb_build_object('party_id', p_party, 'cpf_last4', right(v_cpf, 4));
end $$;

create or replace function crm.set_cpf(p_party uuid, p_cpf text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('crm.write');
  return private.set_party_cpf(p_party, p_cpf);
end $$;

-- Busca pelo CPF sem expor o número: devolve quem é e o final do CPF
create or replace function crm.find_by_cpf(p_cpf text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'); r record;
begin
  perform private.require_perm('crm.read');
  if not private.valid_cpf(v_cpf) then raise exception 'CPF inválido (confira os dígitos)' using errcode = 'P0470'; end if;
  select p.id, p.display_name, p.tier, s.cpf_last4 into r from crm.party_sensitive s join crm.parties p on p.id = s.party_id
  where s.org_id = private.org_id() and s.cpf_hmac = private.cpf_hmac(v_cpf) and p.merged_into_id is null;
  if r.id is null then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'party_id', r.id, 'display_name', r.display_name, 'tier', r.tier, 'cpf_last4', r.cpf_last4);
end $$;

-- Interno: o CPF completo só sai para a nota fiscal, dentro da execução de uma venda
create or replace function private.party_cpf(p_party uuid) returns text
language sql stable security definer set search_path = '' as $$
  select extensions.pgp_sym_decrypt(cpf_encrypted, private.cpf_key()) from crm.party_sensitive where party_id = p_party and cpf_encrypted is not null
$$;

-- ---------------------------------------------------------------------
-- 4) Buscas da Central (e de quem mais precisar): pessoas e produtos
-- ---------------------------------------------------------------------
-- Pessoas por nome, telefone (4+ dígitos), @ do Instagram ou CPF. Devolve o que diferencia homônimas (cidade, final do telefone, última compra).
create or replace function crm.search_people(p_query text, p_limit int default 6) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_q text := trim(coalesce(p_query, '')); v_digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
  v_norm text := private.norm(trim(coalesce(p_query, ''))); v_out jsonb; v_cpf jsonb;
begin
  perform private.require_perm('crm.read');
  if length(v_q) < 2 then return '[]'::jsonb; end if;
  if length(v_digits) = 11 and private.valid_cpf(v_digits) then
    v_cpf := crm.find_by_cpf(v_digits);
    if (v_cpf ->> 'found')::boolean then
      v_q := null;                                                     -- achou pelo CPF: é ela
    end if;
  end if;
  select coalesce(jsonb_agg(x.j order by x.score desc, x.last_purchase_at desc nulls last), '[]') into v_out from (
    select p.last_purchase_at,
           case when v_cpf is not null and (v_cpf ->> 'party_id')::uuid = p.id then 2
                else greatest(extensions.similarity(private.norm(p.display_name), v_norm),
                              case when length(v_digits) >= 4 and exists (select 1 from crm.party_contact_points cp where cp.party_id = p.id and cp.value_normalized like '%' || v_digits || '%') then 0.9 else 0 end,
                              case when p.instagram_handle is not null and p.instagram_handle = ltrim(lower(v_q), '@') then 1 else 0 end) end as score,
           jsonb_build_object('party_id', p.id, 'name', p.display_name, 'kind', p.kind, 'tier', p.tier, 'city', p.city, 'stage', p.lifecycle_stage,
             'phone_last4', (select right(cp.value_normalized, 4) from crm.party_contact_points cp where cp.party_id = p.id and cp.type in ('WHATSAPP', 'PHONE') order by cp.is_primary desc, cp.created_at limit 1),
             'cpf_last4', (select s.cpf_last4 from crm.party_sensitive s where s.party_id = p.id),
             'last_purchase_at', p.last_purchase_at, 'sizes', p.sizes) as j
    from crm.parties p
    where p.org_id = v_org and p.merged_into_id is null and p.archived_at is null and p.anonymized_at is null
      and ((v_cpf is not null and (v_cpf ->> 'party_id')::uuid = p.id)
           or (v_q is not null and (private.norm(p.display_name) like '%' || v_norm || '%'
                                    or extensions.similarity(private.norm(p.display_name), v_norm) > 0.35
                                    or (length(v_digits) >= 4 and exists (select 1 from crm.party_contact_points cp where cp.party_id = p.id and cp.value_normalized like '%' || v_digits || '%'))
                                    or (p.instagram_handle is not null and p.instagram_handle = ltrim(lower(v_q), '@')))))
    order by score desc limit greatest(1, least(coalesce(p_limit, 6), 20))) x;
  return v_out;
end $$;

-- Produtos por texto (nome, referência, cor), EAN/SKU exato, cor e tamanho. Devolve as variantes com preço e estoque disponível na loja.
-- p = {query?, code?, color?, size?, store_id?, limit?}
create or replace function catalog.search_products(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_store uuid := nullif(p ->> 'store_id', '')::uuid; v_code text := upper(trim(coalesce(p ->> 'code', '')));
  v_q text := private.norm(coalesce(p ->> 'query', '')); v_tokens text[]; v_size text := upper(trim(coalesce(p ->> 'size', '')));
  v_color text := regexp_replace(private.norm(coalesce(p ->> 'color', '')), '(as|os|es|a|o|e|s)$', ''); v_out jsonb;
begin
  perform private.require_perm('catalog.read');
  v_tokens := array(select '%' || case when length(t) >= 5 then regexp_replace(t, '(as|os|es|a|o|e|s)$', '') else t end || '%'
                    from unnest(regexp_split_to_array(v_q, '\s+')) t where length(t) >= 2);
  if v_code = '' and cardinality(v_tokens) = 0 then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(x.j order by x.total_available desc, x.name), '[]') into v_out from (
    select p2.name, coalesce(sum(st.avail), 0) as total_available,
           jsonb_build_object('product_id', p2.id, 'name', p2.name, 'reference', p2.reference_code, 'gender', p2.gender,
             'variants', jsonb_agg(jsonb_build_object('variant_id', v.id, 'sku', v.sku, 'gtin', v.gtin, 'size', v.size, 'color', col.name, 'color_id', col.id,
                                                      'price', catalog.current_price(v.id), 'available', st.avail) order by col.name, v.size)) as j
    from catalog.products p2
    join catalog.variants v on v.product_id = p2.id and v.active
    left join catalog.colors col on col.id = v.color_id
    left join lateral (select coalesce(sum(sl.available), 0) as avail from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable
                       and (v_store is null or l.store_id = v_store) where sl.variant_id = v.id) st on true
    where p2.org_id = v_org and p2.status <> 'DISCONTINUED'
      and (v_code = '' or v.gtin = v_code or upper(v.sku) = v_code or upper(p2.reference_code) = v_code)
      and (cardinality(v_tokens) = 0 or private.norm(p2.name || ' ' || p2.reference_code || ' ' || coalesce(col.name, '')) like all (v_tokens))
      and (v_color = '' or private.norm(col.name) like '%' || v_color || '%')
      and (v_size = '' or upper(v.size) = v_size)
    group by p2.id, p2.name, p2.reference_code, p2.gender
    order by coalesce(sum(st.avail), 0) desc, p2.name
    limit greatest(1, least(coalesce((p ->> 'limit')::int, 6), 20))) x;
  return v_out;
end $$;

-- ---------------------------------------------------------------------
-- 5) Prévia de venda: o mesmo cálculo de preço e cupom do PDV (sales.create_pos_order), sem gravar
-- p = {store_id, party_id?, coupon_code?, items:[{variant_id, qty}]}
-- ---------------------------------------------------------------------
create or replace function sales.quote_order(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_store core.stores; v_org uuid := private.org_id(); v_price_list uuid; it jsonb; v_qty numeric; v_list numeric; v_avail numeric; v_subtotal numeric := 0;
  v_coupon sales.coupons; v_coupon_disc numeric := 0; v_lines jsonb := '[]'; v_warnings text[] := '{}'; r record;
begin
  perform private.require_perm('sales.read');
  select * into v_store from core.stores where id = nullif(p ->> 'store_id', '')::uuid and org_id = v_org;
  if v_store.id is null then raise exception 'Loja inválida' using errcode = 'P0460'; end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Pedido sem itens' using errcode = 'P0460'; end if;
  select id into v_price_list from catalog.price_lists where org_id = v_org and is_default;
  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := coalesce((it ->> 'qty')::numeric, 1);
    if v_qty <= 0 or v_qty <> trunc(v_qty) then raise exception 'Quantidade inválida' using errcode = 'P0460'; end if;
    select v.id, v.sku, v.size, pr.name, pr.reference_code, col.name as color into r
    from catalog.variants v join catalog.products pr on pr.id = v.product_id left join catalog.colors col on col.id = v.color_id
    where v.id = nullif(it ->> 'variant_id', '')::uuid and v.org_id = v_org;
    if r.id is null then raise exception 'Produto não encontrado' using errcode = 'P0462'; end if;
    v_list := catalog.current_price(r.id, v_price_list);
    if v_list is null then raise exception 'Variante % sem preço vigente', r.sku using errcode = 'P0007'; end if;
    select coalesce(sum(sl.available), 0) into v_avail from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable and l.store_id = v_store.id
    where sl.variant_id = r.id;
    if v_avail < v_qty then v_warnings := v_warnings || format('%s %s %s: só %s disponível na loja', r.name, coalesce(r.color, ''), r.size, trim_scale(v_avail)); end if;
    v_lines := v_lines || jsonb_build_object('variant_id', r.id, 'sku', r.sku, 'name', r.name, 'reference', r.reference_code, 'color', r.color, 'size', r.size,
                                            'qty', v_qty, 'unit_price', v_list, 'total', round(v_list * v_qty, 2), 'available', trim_scale(v_avail));
    v_subtotal := v_subtotal + v_list * v_qty;
  end loop;
  if coalesce(p ->> 'coupon_code', '') <> '' then
    select * into v_coupon from sales.coupons
    where org_id = v_org and upper(code) = upper(p ->> 'coupon_code') and active and valid_from <= now() and (valid_to is null or valid_to > now());
    if v_coupon.id is null then
      v_warnings := v_warnings || 'Cupom inválido ou expirado'::text;
    elsif v_coupon.min_order is not null and v_subtotal < v_coupon.min_order then
      v_warnings := v_warnings || 'Pedido abaixo do mínimo do cupom'::text;
      v_coupon.id := null;
    else
      v_coupon_disc := round(case when v_coupon.kind = 'PERCENT' then v_subtotal * v_coupon.value / 100 else least(v_coupon.value, v_subtotal) end, 2);
    end if;
  end if;
  return jsonb_build_object('store_id', v_store.id, 'store_name', v_store.name, 'items', v_lines, 'subtotal', round(v_subtotal, 2),
                            'coupon', case when v_coupon.id is not null then jsonb_build_object('code', v_coupon.code, 'discount', v_coupon_disc) end,
                            'discount_total', v_coupon_disc, 'total', round(v_subtotal - v_coupon_disc, 2), 'warnings', to_jsonb(v_warnings));
end $$;

-- ---------------------------------------------------------------------
-- 6) Rotas e custos (a web chama o modelo; o banco guarda o custo e controla o orçamento)
-- ---------------------------------------------------------------------
create or replace function ai.assistant_route(p_task text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); r ai.model_routes; v_spent numeric; v_today int; v_pol jsonb;
begin
  perform private.require_perm('ai.assistant');
  if p_task not in ('assistant', 'vision_extract', 'classify', 'summarize', 'extract') then raise exception 'Rota não permitida' using errcode = 'P0460'; end if;
  if not coalesce((select enabled from core.feature_flags where org_id = v_org and key = 'ai.assistant'), true) then
    return jsonb_build_object('available', false, 'reason', 'A Central está desligada (Configurações › chaves de recurso).');
  end if;
  select * into r from ai.model_routes where org_id = v_org and task = p_task;
  if r.id is null or not r.active then return jsonb_build_object('available', false, 'reason', format('A rota de IA «%s» não está ativa (Inteligência › Modelos & custos).', p_task)); end if;
  select coalesce(sum(cost_usd), 0) into v_spent from ai.runs
  where org_id = v_org and route_task = p_task and created_at >= date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
  if r.daily_budget_usd is not null and v_spent >= r.daily_budget_usd then
    return jsonb_build_object('available', false, 'reason', format('O orçamento diário da rota «%s» acabou (US$ %s).', p_task, r.daily_budget_usd));
  end if;
  v_pol := coalesce((select value from core.settings where org_id = v_org and key = 'assistant_policies'), '{}');
  select count(*) into v_today from ai.runs
  where org_id = v_org and member_id = private.member_id() and route_task = 'assistant'
    and created_at >= date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
  if p_task = 'assistant' and v_today >= coalesce((v_pol ->> 'max_messages_per_day')::int, 300) then
    return jsonb_build_object('available', false, 'reason', 'Você chegou ao limite de mensagens da Central hoje.');
  end if;
  return jsonb_build_object('available', true, 'model', r.primary_model, 'fallback_models', to_jsonb(r.fallback_models), 'params', r.params,
                            'provider_prefs', r.provider_prefs, 'spent_today_usd', v_spent, 'daily_budget_usd', r.daily_budget_usd);
end $$;

-- p = {task, model?, tokens_in?, tokens_out?, cache_read_tokens?, cost_usd?, latency_ms?, status?, error?, tool_calls:[{tool, args, result, ok, ms}]}
create or replace function ai.assistant_log_run(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; tc jsonb;
begin
  perform private.require_perm('ai.assistant');
  if coalesce(p ->> 'task', '') not in ('assistant', 'vision_extract', 'transcribe', 'classify', 'summarize', 'extract') then raise exception 'Rota inválida' using errcode = 'P0460'; end if;
  insert into ai.runs (org_id, member_id, route_task, model, provider, tokens_in, tokens_out, cache_read_tokens, cost_usd, latency_ms, status, error)
  values (private.org_id(), private.member_id(), p ->> 'task', left(p ->> 'model', 120), left(p ->> 'provider', 60),
          nullif(p ->> 'tokens_in', '')::int, nullif(p ->> 'tokens_out', '')::int, nullif(p ->> 'cache_read_tokens', '')::int,
          greatest(coalesce(nullif(p ->> 'cost_usd', '')::numeric, 0), 0), nullif(p ->> 'latency_ms', '')::int,
          case when p ->> 'status' in ('OK', 'ERROR') then p ->> 'status' else 'OK' end, left(p ->> 'error', 500))
  returning id into v_id;
  for tc in select * from jsonb_array_elements(coalesce(p -> 'tool_calls', '[]')) loop
    insert into ai.tool_calls (run_id, tool, args, result_digest, ok, ms)
    values (v_id, left(tc ->> 'tool', 80), coalesce(tc -> 'args', '{}'), tc -> 'result', coalesce((tc ->> 'ok')::boolean, false), nullif(tc ->> 'ms', '')::int);
  end loop;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 7) Ações: propor → (pessoa confirma) → executar
-- Ferramentas de escrita, cada uma com a permissão que a tela exige (a função de negócio confere de novo):
--   venda_pdv            sales.write   sales.create_pos_order (com cliente nova opcional: cadastro + CPF + aceite, na mesma transação)
--   cadastrar_pessoa     crm.write     crm.create_party + CPF + aceite de marketing
--   reserva              sales.write   inv.reserve
--   avise_me             crm.write     crm.add_interest
--   tarefa               crm.write     crm.save_task
--   preferencias         crm.write     crm.update_profile
--   conta_pagar          fin.write     fin.create_title
--   baixa                fin.write     fin.settle_installment (até o teto da política; acima, só pela tela)
--   abrir_caixa          sales.write   sales.open_cash_session
--   fechar_caixa         sales.write   sales.close_cash_session
-- ---------------------------------------------------------------------
create or replace function private.assistant_tool_perm(p_tool text) returns text
language sql immutable as $$
  select case p_tool
    when 'venda_pdv' then 'sales.write' when 'cadastrar_pessoa' then 'crm.write' when 'reserva' then 'sales.write' when 'avise_me' then 'crm.write'
    when 'tarefa' then 'crm.write' when 'preferencias' then 'crm.write' when 'conta_pagar' then 'fin.write' when 'baixa' then 'fin.write'
    when 'abrir_caixa' then 'sales.write' when 'fechar_caixa' then 'sales.write' end
$$;

-- p = {thread_id?, tool, args, preview?, summary?}
create or replace function ai.assistant_propose(p jsonb) returns ai.assistant_actions
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_member uuid := private.member_id(); v_perm text := private.assistant_tool_perm(p ->> 'tool'); a ai.assistant_actions; v_ttl int;
begin
  perform private.require_perm('ai.assistant');
  if v_perm is null then raise exception 'Ação desconhecida: %', p ->> 'tool' using errcode = 'P0460'; end if;
  perform private.require_perm(v_perm);
  if jsonb_typeof(p -> 'args') is distinct from 'object' then raise exception 'Ação sem dados' using errcode = 'P0460'; end if;
  if nullif(p ->> 'thread_id', '') is not null and not exists (select 1 from ai.assistant_threads where id = (p ->> 'thread_id')::uuid and member_id = v_member) then
    raise exception 'Conversa não encontrada' using errcode = 'P0462';
  end if;
  v_ttl := coalesce((select (value ->> 'action_ttl_minutes')::int from core.settings where org_id = v_org and key = 'assistant_policies'), 15);
  insert into ai.assistant_actions (org_id, thread_id, member_id, tool, args, preview, summary, expires_at)
  values (v_org, nullif(p ->> 'thread_id', '')::uuid, v_member, p ->> 'tool', p -> 'args', coalesce(p -> 'preview', '{}'), left(p ->> 'summary', 300),
          now() + make_interval(mins => greatest(1, least(v_ttl, 120))))
  returning * into a;
  return a;
end $$;

-- Cliente nova a partir dos dados do cartão: {display_name, phone?, email?, cpf?, birth_date?, gender?, marketing_whatsapp?, notes?}
create or replace function private.assistant_new_party(n jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare x crm.parties;
begin
  x := crm.create_party(jsonb_strip_nulls(jsonb_build_object(
         'kind', 'PERSON', 'display_name', n ->> 'display_name', 'birth_date', nullif(n ->> 'birth_date', ''), 'gender', nullif(n ->> 'gender', ''),
         'phones', case when coalesce(n ->> 'phone', '') <> '' then jsonb_build_array(n ->> 'phone') end,
         'emails', case when coalesce(n ->> 'email', '') <> '' then jsonb_build_array(n ->> 'email') end,
         'roles', jsonb_build_array('CUSTOMER'), 'source', 'CENTRAL', 'notes', nullif(n ->> 'notes', ''))));
  if coalesce(n ->> 'cpf', '') <> '' then perform private.set_party_cpf(x.id, n ->> 'cpf'); end if;
  if n ? 'marketing_whatsapp' and coalesce(n ->> 'phone', '') <> '' then
    perform crm.set_consent(x.id, 'MARKETING_WHATSAPP', (n ->> 'marketing_whatsapp')::boolean, 'BALCAO');
  end if;
  return x.id;
end $$;

create or replace function private.assistant_dispatch(a ai.assistant_actions) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g jsonb := a.args; v_party uuid; v_quote jsonb; o sales.orders; t fin.titles; r inv.reservations; tk crm.tasks; i record; v_pol jsonb; v_max numeric;
  v_cpf text; cs sales.cash_sessions; v_amount numeric;
begin
  case a.tool
  when 'venda_pdv' then
    v_party := nullif(g ->> 'party_id', '')::uuid;
    if v_party is null and jsonb_typeof(g -> 'new_party') = 'object' then v_party := private.assistant_new_party(g -> 'new_party'); end if;
    -- o total confirmado no cartão precisa ser o mesmo de agora (preço ou cupom podem ter mudado)
    v_quote := sales.quote_order(jsonb_build_object('store_id', g ->> 'store_id', 'coupon_code', g ->> 'coupon_code', 'items', g -> 'items'));
    if (v_quote ->> 'total')::numeric is distinct from (a.preview ->> 'total')::numeric then
      raise exception 'O total mudou de % para %: refaça o cartão', a.preview ->> 'total', v_quote ->> 'total' using errcode = 'P0461';
    end if;
    v_cpf := case when coalesce((g ->> 'cpf_on_invoice')::boolean, false) then
                    coalesce(nullif(regexp_replace(coalesce(g -> 'new_party' ->> 'cpf', ''), '\D', '', 'g'), ''), private.party_cpf(v_party)) end;
    o := sales.create_pos_order(jsonb_strip_nulls(jsonb_build_object(
           'idempotency_key', a.idempotency_key::text, 'store_id', g ->> 'store_id', 'party_id', v_party, 'cash_session_id', g ->> 'cash_session_id',
           'cpf_on_invoice', v_cpf, 'coupon_code', nullif(g ->> 'coupon_code', ''), 'items', g -> 'items', 'payments', g -> 'payments',
           'attribution', jsonb_build_object('assisted_by', 'CENTRAL'))));
    return jsonb_build_object('target_type', 'sales.orders', 'target_id', o.id, 'number', o.number, 'total', o.total, 'party_id', v_party, 'href', '/vender/pedidos/' || o.id);
  when 'cadastrar_pessoa' then
    v_party := private.assistant_new_party(g);
    return jsonb_build_object('target_type', 'crm.parties', 'target_id', v_party, 'href', '/cadastros/' || v_party);
  when 'reserva' then
    r := inv.reserve(jsonb_build_object('variant_id', g ->> 'variant_id', 'qty', coalesce(g ->> 'qty', '1'), 'party_id', g ->> 'party_id', 'store_id', g ->> 'store_id',
                                        'reason', coalesce(nullif(g ->> 'reason', ''), 'TRY_ON'), 'hold_hours', g ->> 'hold_hours'));
    return jsonb_build_object('target_type', 'inv.reservations', 'target_id', r.id, 'expires_at', r.expires_at, 'href', '/vender/reservas');
  when 'avise_me' then
    perform crm.add_interest((g ->> 'party_id')::uuid, (g ->> 'product_id')::uuid, g ->> 'size', nullif(g ->> 'color_id', '')::uuid, nullif(g ->> 'note', ''));
    return jsonb_build_object('target_type', 'crm.parties', 'target_id', (g ->> 'party_id')::uuid, 'href', '/clientes/' || (g ->> 'party_id'));
  when 'tarefa' then
    tk := crm.save_task(g - 'id');
    return jsonb_build_object('target_type', 'crm.tasks', 'target_id', tk.id, 'href', '/clientes/tarefas');
  when 'preferencias' then
    perform crm.update_profile((g ->> 'party_id')::uuid, g - 'party_id');
    return jsonb_build_object('target_type', 'crm.parties', 'target_id', (g ->> 'party_id')::uuid, 'href', '/clientes/' || (g ->> 'party_id'));
  when 'conta_pagar' then
    t := fin.create_title(g || jsonb_build_object('direction', 'PAYABLE'));
    return jsonb_build_object('target_type', 'fin.titles', 'target_id', t.id, 'number', t.number, 'href', '/financeiro/pagar?titulo=' || t.id);
  when 'baixa' then
    select it.id, it.amount - it.amount_settled as balance into i from fin.title_installments it where it.id = (g ->> 'installment_id')::uuid and it.org_id = a.org_id;
    if i.id is null then raise exception 'Parcela não encontrada' using errcode = 'P0462'; end if;
    v_amount := coalesce(nullif(g ->> 'amount', '')::numeric, i.balance);
    v_pol := coalesce((select value from core.settings where org_id = a.org_id and key = 'assistant_policies'), '{}');
    v_max := coalesce((v_pol ->> 'max_settle_amount')::numeric, 5000);
    if v_amount > v_max then raise exception 'Baixas acima de R$ % são feitas pela tela de baixa', v_max using errcode = 'P0461'; end if;
    perform fin.settle_installment(i.id, v_amount);
    return jsonb_build_object('target_type', 'fin.title_installments', 'target_id', i.id, 'amount', v_amount, 'href', '/financeiro/pagar');
  when 'abrir_caixa' then
    cs := sales.open_cash_session((g ->> 'register_id')::uuid, coalesce((g ->> 'opening_float')::numeric, 0));
    return jsonb_build_object('target_type', 'sales.cash_sessions', 'target_id', cs.id, 'href', '/vender/caixa');
  when 'fechar_caixa' then
    cs := sales.close_cash_session((g ->> 'session_id')::uuid, (g ->> 'counted')::numeric, nullif(g ->> 'notes', ''));
    return jsonb_build_object('target_type', 'sales.cash_sessions', 'target_id', cs.id, 'href', '/vender/caixa');
  else
    raise exception 'Ação desconhecida: %', a.tool using errcode = 'P0460';
  end case;
end $$;

-- Executa a proposta (uma vez, dentro da validade, só por quem a recebeu). Erro de negócio volta como {ok:false} e fica registrado.
create or replace function ai.assistant_execute(p_action uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a ai.assistant_actions; v_res jsonb; v_err text; v_code text;
begin
  perform private.require_perm('ai.assistant');
  select * into a from ai.assistant_actions where id = p_action and org_id = private.org_id() and member_id = private.member_id() for update;
  if a.id is null then raise exception 'Ação não encontrada' using errcode = 'P0462'; end if;
  if a.status = 'EXECUTED' then return jsonb_build_object('ok', true, 'already', true, 'result', a.result); end if;
  if a.status <> 'PROPOSED' then raise exception 'Esta ação já foi %', lower(case a.status when 'CANCELLED' then 'cancelada' when 'EXPIRED' then 'expirada' else 'recusada' end) using errcode = 'P0461'; end if;
  if a.expires_at < now() then
    update ai.assistant_actions set status = 'EXPIRED', decided_at = now() where id = a.id;
    return jsonb_build_object('ok', false, 'error', 'O cartão expirou: peça de novo à Central.', 'code', 'EXPIRED');
  end if;
  perform private.require_perm(private.assistant_tool_perm(a.tool));
  begin
    v_res := private.assistant_dispatch(a);
  exception when others then
    get stacked diagnostics v_err = message_text, v_code = returned_sqlstate;
    update ai.assistant_actions set status = 'FAILED', error = left(v_err, 500), decided_at = now() where id = a.id;
    return jsonb_build_object('ok', false, 'error', v_err, 'code', v_code);
  end;
  update ai.assistant_actions set status = 'EXECUTED', result = v_res, target_type = v_res ->> 'target_type', target_id = nullif(v_res ->> 'target_id', '')::uuid,
         decided_at = now() where id = a.id;
  return jsonb_build_object('ok', true, 'result', v_res);
end $$;

create or replace function ai.assistant_cancel(p_action uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('ai.assistant');
  update ai.assistant_actions set status = 'CANCELLED', decided_at = now()
  where id = p_action and org_id = private.org_id() and member_id = private.member_id() and status = 'PROPOSED';
end $$;

-- Limpeza: propostas vencidas expiram; conversas antigas saem (política keep_threads_days)
create or replace function private.assistant_sweep() returns integer
language plpgsql security definer set search_path = '' as $$
declare n int; m int;
begin
  update ai.assistant_actions set status = 'EXPIRED', decided_at = now() where status = 'PROPOSED' and expires_at < now();
  get diagnostics n = row_count;
  delete from ai.assistant_threads t using core.settings s
  where s.org_id = t.org_id and s.key = 'assistant_policies' and t.updated_at < now() - make_interval(days => coalesce((s.value ->> 'keep_threads_days')::int, 90));
  get diagnostics m = row_count;
  return n + m;
end $$;
select cron.schedule('centralops-assistant-sweep', '40 6 * * *', $$ select private.assistant_sweep() $$);   -- 03:40 BRT

insert into private.internal_functions (fqname) values
  ('private.cpf_key'), ('private.cpf_hmac'), ('private.set_party_cpf'), ('private.party_cpf'), ('private.assistant_tool_perm'),
  ('private.assistant_new_party'), ('private.assistant_dispatch'), ('private.assistant_sweep')
on conflict do nothing;
select private.lock_functions();
