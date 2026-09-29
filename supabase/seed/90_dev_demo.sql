-- =====================================================================
-- Seed de DESENVOLVIMENTO (somente ambiente local). Dados FICTÍCIOS para testar telas e fluxos.
-- NUNCA rodar em produção: o catálogo real é importado pela tela de importação.
-- Usuários de teste: socio@sie.test e vendedora@sie.test — senha: sie-dev-2026
-- =====================================================================

-- Empresa e lojas de teste (CNPJ fictício)
insert into core.legal_entities (id, org_id, cnpj, razao_social, nome_fantasia, cnae_principal, cnaes_secundarios, nfce_series, nfe_series, address)
values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000001', '11222333000181',
        'EMPRESA DE TESTE LTDA', 'SIÉ JOY (dev)', '4781400', '{4763602,4782201,4782202,4772500,4789099,4642701,7319002,8230001}', 1, 1,
        '{"city": "Florianópolis", "uf": "SC"}')
on conflict (id) do nothing;

insert into core.cost_centers (id, org_id, code, name, kind, legal_entity_id) values
  ('00000000-0000-4000-8000-0000000000c0', '00000000-0000-4000-8000-000000000001', 'CORP', 'Corporativo', 'CORPORATE', null),
  ('00000000-0000-4000-8000-0000000000c9', '00000000-0000-4000-8000-000000000001', 'CORP-DIGITAL', 'Digital sem loja de origem', 'CHANNEL', null)
on conflict (id) do nothing;
insert into core.cost_centers (id, org_id, parent_id, code, name, kind, legal_entity_id) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c0', 'CNPJ-01', 'CNPJ de teste', 'LEGAL_ENTITY', '00000000-0000-4000-8000-0000000000e1')
on conflict (id) do nothing;

insert into core.stores (id, org_id, legal_entity_id, code, name, format, status, opened_at, business_hours)
values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1',
        'JOY', 'Boutique JOY (dev)', 'SHOP_IN_SHOP', 'ACTIVE', '2026-10-01',
        '{"mon-fri": ["07:00", "21:00"], "sat": ["08:00", "14:00"]}')
on conflict (id) do nothing;

insert into core.cost_centers (id, org_id, parent_id, code, name, kind, legal_entity_id, store_id, channel) values
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'LOJA-JOY', 'Loja JOY', 'STORE', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', null),
  ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c2', 'JOY-BALCAO', 'JOY — Balcão', 'CHANNEL', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', 'POS'),
  ('00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c2', 'JOY-DIGITAL', 'JOY — Digital', 'CHANNEL', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', 'DIGITAL')
on conflict (id) do nothing;
update core.stores set cost_center_id = '00000000-0000-4000-8000-0000000000c3' where id = '00000000-0000-4000-8000-0000000000a1';

insert into inv.locations (id, org_id, store_id, legal_entity_id, name, kind, is_sellable) values
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000e1', 'Salão de vendas', 'SALES_FLOOR', true),
  ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000e1', 'Armários VIP', 'VIP_LOCKERS', false)
on conflict (id) do nothing;

insert into sales.cash_registers (id, org_id, store_id, name)
values ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'Caixa 1')
on conflict (id) do nothing;

-- Usuários de teste (só local). Senha: sie-dev-2026
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change, email_change_token_new)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
       extensions.crypt('sie-dev-2026', extensions.gen_salt('bf')), now(),
       '{"provider": "email", "providers": ["email"]}', jsonb_build_object('name', u.name), now(), now(), '', '', '', ''
from (values
  ('00000000-0000-4000-8000-0000000000f1'::uuid, 'socio@sie.test', 'Sócio (teste)'),
  ('00000000-0000-4000-8000-0000000000f2'::uuid, 'vendedora@sie.test', 'Vendedora (teste)')
) as u(id, email, name)
on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text, jsonb_build_object('sub', u.id::text, 'email', u.email), 'email', now(), now(), now()
from auth.users u where u.email in ('socio@sie.test', 'vendedora@sie.test')
  and not exists (select 1 from auth.identities i where i.user_id = u.id);

insert into core.members (id, org_id, user_id, display_name, default_store_id) values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000f1', 'Sócio (teste)', '00000000-0000-4000-8000-0000000000a1'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000f2', 'Vendedora (teste)', '00000000-0000-4000-8000-0000000000a1')
on conflict (id) do nothing;

insert into core.member_roles (member_id, role_id)
select m.id, r.id from core.members m join core.roles r on r.org_id = m.org_id
where (m.id = '00000000-0000-4000-8000-000000000101' and r.key = 'owner')
   or (m.id = '00000000-0000-4000-8000-000000000102' and r.key = 'seller')
on conflict do nothing;

insert into core.member_store_access (member_id, store_id, all_stores) values
  ('00000000-0000-4000-8000-000000000101', null, true),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-0000000000a1', false)
on conflict do nothing;

-- Catálogo de exemplo (FICTÍCIO): 2 femininos + 1 masculino, com grade e preço
insert into catalog.categories (id, org_id, name, ncm_default) values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001', 'Leggings', '61046200'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000001', 'Tops', '61099000'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000001', 'Camisetas', '61091000')
on conflict (id) do nothing;

insert into catalog.colors (id, org_id, name, code, hex) values
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000001', 'Preto', 'PRT', '#111111'),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000001', 'Off-white', 'OFW', '#F4F1EA')
on conflict (id) do nothing;

insert into catalog.products (id, org_id, category_id, size_grid_id, reference_code, name, gender, assortment_class, ncm, status, activities)
select p.id, '00000000-0000-4000-8000-000000000001', p.cat, g.id, p.ref, p.name, p.gender::catalog.gender, 'CORE', p.ncm, 'ACTIVE', p.act
from (values
  ('00000000-0000-4000-8000-000000000401'::uuid, '00000000-0000-4000-8000-000000000201'::uuid, 'DEMO-LEG01', 'Legging Demo Sculpt', 'FEM', '61046200', 'Feminino PP-GG', '{pilates,musculação}'::text[]),
  ('00000000-0000-4000-8000-000000000402'::uuid, '00000000-0000-4000-8000-000000000202'::uuid, 'DEMO-TOP01', 'Top Demo Strappy', 'FEM', '61099000', 'Feminino PP-GG', '{pilates,yoga}'::text[]),
  ('00000000-0000-4000-8000-000000000403'::uuid, '00000000-0000-4000-8000-000000000203'::uuid, 'DEMO-TEE01', 'Camiseta Demo Dry Masculina', 'MASC', '61091000', 'Masculino P-GG', '{corrida,musculação}'::text[])
) as p(id, cat, ref, name, gender, ncm, grid, act)
join catalog.size_grids g on g.org_id = '00000000-0000-4000-8000-000000000001' and g.name = p.grid
on conflict (id) do nothing;

insert into catalog.variants (org_id, product_id, color_id, size, sku, gtin)
select '00000000-0000-4000-8000-000000000001', p.id, c.id, s, p.reference_code || '-' || c.code || '-' || s, null
from catalog.products p
join catalog.size_grids g on g.id = p.size_grid_id
cross join unnest(g.sizes) as s
join catalog.colors c on c.org_id = p.org_id
where p.reference_code like 'DEMO-%'
on conflict (org_id, sku) do nothing;

insert into catalog.prices (org_id, price_list_id, product_id, price)
select '00000000-0000-4000-8000-000000000001', pl.id, p.id, x.price
from (values ('DEMO-LEG01', 429.00), ('DEMO-TOP01', 289.00), ('DEMO-TEE01', 249.00)) as x(ref, price)
join catalog.products p on p.reference_code = x.ref
join catalog.price_lists pl on pl.org_id = p.org_id and pl.is_default
where not exists (select 1 from catalog.prices pr where pr.product_id = p.id);

-- Saldo inicial fictício com custo (entrada de compra) no salão
insert into inv.movements (org_id, variant_id, location_id, qty, unit_cost, movement_type, source_type, notes)
select '00000000-0000-4000-8000-000000000001', v.id, '00000000-0000-4000-8000-0000000000b1', 5,
       round(pr.price / 2.4, 2), 'PURCHASE_RECEIPT', 'seed', 'saldo fictício de desenvolvimento'
from catalog.variants v
join catalog.prices pr on pr.product_id = v.product_id
where v.sku like 'DEMO-%'
  and not exists (select 1 from inv.movements m where m.variant_id = v.id);

-- Cliente e canal de teste
insert into crm.parties (id, org_id, display_name, city, uf, lifecycle_stage, home_store_id, sizes, profession)
values ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000001', 'Cliente Teste', 'Florianópolis', 'SC',
        'PROSPECT', '00000000-0000-4000-8000-0000000000a1', '{"top": "P", "bottom": "M"}', 'arquiteta')
on conflict (id) do nothing;
insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000501', 'WHATSAPP', 'x', '48 99999-0001', true)
on conflict do nothing;

insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id)
values ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'dev-phone-number-id', 'WhatsApp SIÉ (dev)', '00000000-0000-4000-8000-0000000000a1')
on conflict (id) do nothing;
insert into omni.channel_identities (id, org_id, channel_account_id, external_id, party_id)
values ('00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000601', '5548999990001', '00000000-0000-4000-8000-000000000501')
on conflict (id) do nothing;
insert into omni.conversations (id, org_id, party_id, channel_account_id, channel_identity_id, mode)
values ('00000000-0000-4000-8000-000000000621', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000501',
        '00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000611', 'AI_COPILOT')
on conflict (id) do nothing;
insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, body, provider_message_id)
select '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000621', '00000000-0000-4000-8000-000000000601',
       'IN', 'CUSTOMER', 'Oi! Vocês têm a legging preta no M?', 'dev-wamid-1'
where not exists (select 1 from omni.messages where provider_message_id = 'dev-wamid-1');
