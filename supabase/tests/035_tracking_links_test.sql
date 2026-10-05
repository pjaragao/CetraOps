begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;

insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode) values
  ('00000000-0000-4000-8000-0000000009c1', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PNID-LINKS', 'WhatsApp (links)', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT'),
  ('00000000-0000-4000-8000-0000000009c2', '00000000-0000-4000-8000-000000000001', 'INSTAGRAM', 'IGID-LINKS', 'Instagram (links)', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT');

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
select lives_ok($$ select omni.set_channel_public_address('00000000-0000-4000-8000-0000000009c1', '+55 (48) 99999-0000') $$, 'número público do WhatsApp');
select is((select public_address from omni.channel_accounts where id = '00000000-0000-4000-8000-0000000009c1'), '5548999990000', 'só dígitos, com DDI');
select throws_ok($$ select omni.set_channel_public_address('00000000-0000-4000-8000-0000000009c1', '1234') $$, 'P0310', null, 'número curto é recusado');

select lives_ok($$ insert into ids select 'qr', (mkt.save_tracking_link('{"code":"QR-Recepcao","name":"QR da recepção","kind":"QR","channel_account_id":"00000000-0000-4000-8000-0000000009c1"}')).id $$, 'cria o link do QR');
select is((select code from mkt.tracking_links where id = (select v from ids where k = 'qr')), 'qr-recepcao', 'código em minúsculas');
select throws_ok($$ select mkt.save_tracking_link('{"code":"qr-recepcao","name":"Outro","channel_account_id":"00000000-0000-4000-8000-0000000009c1"}') $$, 'P0310', null, 'código repetido é recusado');
select throws_ok($$ select mkt.save_tracking_link('{"code":"ig-bio","name":"Bio","channel_account_id":"00000000-0000-4000-8000-0000000009c2"}') $$, 'P0310', null, 'Instagram não tem link direto');
select throws_ok($$ select mkt.save_tracking_link('{"code":"a b","name":"Ruim","channel_account_id":"00000000-0000-4000-8000-0000000009c1"}') $$, 'P0310', null, 'código com espaço é recusado');

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (crm.write)
select lives_ok($$ insert into ids select 'tr', (mkt.save_tracking_link('{"code":"trainer-bia","name":"Trainer Bia","kind":"TRAINER","channel_account_id":"00000000-0000-4000-8000-0000000009c1"}')).id $$, 'vendedora cria link de trainer');
reset role;

-- mensagem com o código: primeiro toque, origem e etiqueta
select lives_ok($$ insert into ids select 'conv', ((omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-LINKS',
  'external_id', '5548977770001', 'phone', '5548977770001', 'display_name', 'Lia (teste)', 'provider_message_id', 'wamid.L1', 'type', 'TEXT',
  'body', 'Oi! Vim pelo QR da recepção. (ref: qr-recepcao)')))->>'conversation_id')::uuid $$, 'mensagem com o código do QR');
insert into ids select 'lia', party_id from omni.conversations where id = (select v from ids where k = 'conv');
select is((select count(*)::int || '/' || bool_and(is_first)::text from mkt.attribution_touches where party_id = (select v from ids where k = 'lia')), '1/true', 'primeiro toque gravado');
select is((select source from crm.parties where id = (select v from ids where k = 'lia')), 'LINK:qr-recepcao', 'origem da pessoa = o link');
select ok((select 'origem-qr-recepcao' = any (tags) from crm.parties where id = (select v from ids where k = 'lia')), 'etiqueta de origem');
-- de novo no mesmo dia: não duplica; outro link: novo toque, não é o primeiro e não troca a origem
select omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-LINKS', 'external_id', '5548977770001',
  'provider_message_id', 'wamid.L2', 'type', 'TEXT', 'body', 'ref: qr-recepcao'));
select omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-LINKS', 'external_id', '5548977770001',
  'provider_message_id', 'wamid.L3', 'type', 'TEXT', 'body', 'oi (ref: trainer-bia)'));
select is((select count(*)::int from mkt.attribution_touches where party_id = (select v from ids where k = 'lia')), 2, 'mesmo link no mesmo dia conta uma vez; outro link soma');
select is((select source from crm.parties where id = (select v from ids where k = 'lia')), 'LINK:qr-recepcao', 'a origem continua sendo o primeiro toque');
-- anúncio que abre o WhatsApp também vira toque
select omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-LINKS', 'external_id', '5548977770002', 'phone', '5548977770002',
  'provider_message_id', 'wamid.L4', 'type', 'TEXT', 'body', 'Quero saber do anúncio', 'referral', jsonb_build_object('source_id', 'AD-123', 'ctwa_clid', 'clid-1')));
select is((select kind || '/' || ad_id from mkt.attribution_touches a join crm.party_contact_points c on c.party_id = a.party_id where c.value_normalized = '+5548977770002'), 'AD/AD-123', 'anúncio CTWA vira toque');

-- vendas depois do toque entram no resultado do link
insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, subtotal, discount_total, total, cost_total, idempotency_key)
values ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1',
        'LNK-1', 'POS', 'PAID', (select v from ids where k = 'lia'), 450, 0, 450, 180, 'lnk-1');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((select new_leads || '/' || buyers || '/' || revenue from mkt.tracking_link_stats(current_date, current_date) where code = 'qr-recepcao'), '1/1/450.00', 'resultado do link: lead nova, compradora e receita');
select ok(exists (select 1 from crm.lead_sources(current_date, current_date) where source = 'LINK:qr-recepcao'), 'origem das leads novas');

select * from finish();
rollback;
