begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

-- ---------- Preparação: cliente com telefone, e-mail e aceite de marketing; pedido pago vindo de anúncio ----------
insert into crm.parties (id, org_id, kind, display_name, lifecycle_stage) values ('00000000-0000-4000-8000-0000000009ca', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Cliente CAPI (teste)', 'CUSTOMER');
insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009ca', 'WHATSAPP', '5548977771234', '+55 48 97777-1234', true),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009ca', 'EMAIL', 'Cliente.Capi@Exemplo.com', 'Cliente.Capi@Exemplo.com', false);
insert into crm.consents (org_id, party_id, purpose, granted, legal_basis) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009ca', 'MARKETING_WHATSAPP', true, 'CONSENT');
insert into sales.orders (id, org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, attribution, subtotal, total, idempotency_key)
values ('00000000-0000-4000-8000-0000000009cb', '00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1',
        'CAPI-1', 'WHATSAPP', 'PAID', '00000000-0000-4000-8000-0000000009ca', '{"referral":{"ctwa_clid":"CLID-XYZ"}}', 350, 350, 'capi-1');

-- ---------- Payload montado pelo banco ----------
select is(mkt.capi_payload('00000000-0000-4000-8000-0000000009cb') ->> 'status', 'PAID', 'status da venda');
select is((mkt.capi_payload('00000000-0000-4000-8000-0000000009cb') ->> 'total')::numeric, 350.00, 'valor');
select is(mkt.capi_payload('00000000-0000-4000-8000-0000000009cb') ->> 'ctwa_clid', 'CLID-XYZ', 'identificador do clique no anúncio');
select is(mkt.capi_payload('00000000-0000-4000-8000-0000000009cb') -> 'phones', '["5548977771234"]'::jsonb, 'telefone só com dígitos (o hash é feito no worker)');
select is(mkt.capi_payload('00000000-0000-4000-8000-0000000009cb') -> 'emails', '["cliente.capi@exemplo.com"]'::jsonb, 'e-mail em minúsculas');
select is(mkt.capi_payload('00000000-0000-4000-8000-0000000009cb') -> 'consents' ->> 'MARKETING_WHATSAPP', 'true', 'consentimentos vigentes');
select is(mkt.capi_payload(gen_random_uuid()), null, 'venda inexistente');

-- ---------- Registro do resultado ----------
select lives_ok($$ select mkt.capi_record('{"order_id":"00000000-0000-4000-8000-0000000009cb","org_id":"00000000-0000-4000-8000-000000000001","status":"SKIPPED","reason":"NOT_CONFIGURED"}') $$, 'registra que não foi enviada');
select lives_ok($$ select mkt.capi_record('{"order_id":"00000000-0000-4000-8000-0000000009cb","org_id":"00000000-0000-4000-8000-000000000001","status":"SENT","response":{"events_received":1}}') $$, 'registra o envio depois (mesma venda, sem duplicar)');
select is((select status || '/' || count(*) over () from mkt.capi_events where order_id = '00000000-0000-4000-8000-0000000009cb'), 'SENT/1', 'uma linha por venda, com a situação mais recente');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is((select count(*)::int from mkt.capi_events), 1, 'equipe com acesso a clientes vê o registro');
select ok(not has_function_privilege('authenticated', 'mkt.capi_payload(uuid)', 'execute') and not has_function_privilege('authenticated', 'mkt.capi_record(jsonb)', 'execute'), 'funções do worker não são chamáveis pela tela');

select * from finish();
rollback;
