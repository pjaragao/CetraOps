begin;
create extension if not exists pgtap with schema extensions;
select plan(60);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
create temp table ids (k text primary key, v text);
grant all on ids to authenticated;

-- ---------- Preparação (dono do banco): 40 pessoas com WhatsApp e consentimento ----------
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode, public_address) values
  ('00000000-0000-4000-8000-0000000062f8', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PN-HUB-1', 'WhatsApp hub', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT', '5548900000062');
insert into omni.templates (id, org_id, channel_account_id, name, language, category, components, status) values
  ('00000000-0000-4000-8000-0000000062f1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000062f8', 'hub_simples', 'pt_BR', 'MARKETING', '[{"type":"BODY","text":"Oi {{1}}! Novidades na loja."}]', 'APPROVED'),
  ('00000000-0000-4000-8000-0000000062f2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000062f8', 'hub_cupom', 'pt_BR', 'MARKETING', '[{"type":"BODY","text":"Oi {{1}}! Cupom {{2}}: {{3}} de desconto até {{4}}."}]', 'APPROVED'),
  ('00000000-0000-4000-8000-0000000062f3', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000062f8', 'hub_link', 'pt_BR', 'MARKETING', '[{"type":"BODY","text":"Oi {{1}}! Veja: {{2}}"}]', 'APPROVED');
insert into crm.parties (id, org_id, kind, display_name, lifecycle_stage, tags, lead_score)
select ('00000000-0000-4000-8000-00000062' || lpad(n::text, 4, '0'))::uuid, '00000000-0000-4000-8000-000000000001', 'PERSON', 'Pessoa ' || lpad(n::text, 2, '0') || ' Hub (teste)', 'CUSTOMER', '{hub-test}', 100 - n from generate_series(1, 40) n;
insert into crm.party_contact_points (org_id, party_id, type, value_normalized, value_display, is_primary)
select '00000000-0000-4000-8000-000000000001', id, 'WHATSAPP', '+55489' || lpad((70000000 + row_number() over (order by id))::text, 8, '0'), '+55489' || lpad((70000000 + row_number() over (order by id))::text, 8, '0'), true from crm.parties where tags @> '{hub-test}';
insert into crm.consents (org_id, party_id, purpose, granted, legal_basis) select '00000000-0000-4000-8000-000000000001', id, 'MARKETING_WHATSAPP', true, 'CONSENT' from crm.parties where tags @> '{hub-test}';
update crm.parties set tags = tags || array['hub-g2'] where tags @> '{hub-test}' and right(id::text, 4)::int between 1 and 20;
update crm.parties set tags = tags || array['hub-g3'] where tags @> '{hub-test}' and right(id::text, 4)::int between 21 and 25;
update crm.parties set tags = tags || array['hub-g4'] where tags @> '{hub-test}' and right(id::text, 4)::int between 26 and 28;
update crm.parties set tags = tags || array['hub-g5'] where tags @> '{hub-test}' and right(id::text, 4)::int = 30;
create or replace function pg_temp.did(p_camp text, p_seq int default 1) returns uuid language sql as $$
  select id from mkt.campaign_dispatches where campaign_id = (select v from ids where k = p_camp)::uuid and seq = p_seq $$;
grant execute on function pg_temp.did(text, int) to authenticated;
create or replace function pg_temp.disp(p_camp text, p_tpl text, p_vars jsonb, p_extra jsonb default '{}') returns text language sql as $$
  select (mkt.save_dispatch(jsonb_build_object('campaign_id', (select v from ids where k = p_camp), 'channel_account_id', '00000000-0000-4000-8000-0000000062f8', 'template_id', p_tpl, 'variables', p_vars, 'daily_limit', 1000) || p_extra)).id::text $$;
grant execute on function pg_temp.disp(text, text, jsonb, jsonb) to authenticated;

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');

-- ---------- Oferta: validações ----------
insert into ids select 'c1', (mkt.save_campaign('{"name":"Hub controle","objective":"CONVERT","holdout_pct":50,"audience":{"tags":["hub-test"]}}')).id::text;
select throws_ok($$ select mkt.save_campaign_offer(jsonb_build_object('campaign_id', (select v from ids where k = 'c1'), 'mode', 'SHARED', 'kind', 'PERCENT', 'value', 10, 'code', 'x')) $$, 'P0190', null, 'código único precisa de 3 a 20 letras ou números');
select throws_ok($$ select mkt.save_campaign_offer(jsonb_build_object('campaign_id', (select v from ids where k = 'c1'), 'mode', 'SHARED', 'kind', 'PERCENT', 'value', 150, 'code', 'HUB150')) $$, 'P0190', null, 'percentual acima de 100');
select throws_ok($$ select mkt.save_campaign_offer(jsonb_build_object('campaign_id', (select v from ids where k = 'c1'), 'mode', 'PERSONAL', 'kind', 'AMOUNT', 'value', 0)) $$, 'P0190', null, 'valor zero');
select throws_ok($$ select mkt.save_campaign_offer(jsonb_build_object('campaign_id', (select v from ids where k = 'c1'), 'mode', 'PERSONAL', 'kind', 'PERCENT', 'value', 10, 'code_prefix', 'a b')) $$, 'P0190', null, 'prefixo inválido');
select is((mkt.save_campaign_offer(jsonb_build_object('campaign_id', (select v from ids where k = 'c1'), 'mode', 'NONE'))).mode, 'NONE', 'sem oferta');

-- ---------- Grupo de controle ----------
insert into ids select 'd1', pg_temp.disp('c1', '00000000-0000-4000-8000-0000000062f1', '[{"source":"FIRST_NAME"}]');
select is((mkt.launch_campaign((select v from ids where k = 'c1')::uuid)).status, 'ACTIVE', 'lança campanha com grupo de controle de 50%');
select ok((select count(*) filter (where grp = 'HOLDOUT') between 5 and 35 and count(*) = 40 from mkt.campaign_members where campaign_id = (select v from ids where k = 'c1')::uuid), 'o sorteio separa tratamento e controle (40 pessoas)');
select ok((select count(*) = 0 from mkt.campaign_recipients r join mkt.campaign_members m on m.campaign_id = r.campaign_id and m.party_id = r.party_id where r.campaign_id = (select v from ids where k = 'c1')::uuid and m.grp = 'HOLDOUT'), 'o grupo de controle nunca recebe mensagem');
select is((select count(*)::int from mkt.campaign_recipients where campaign_id = (select v from ids where k = 'c1')::uuid), (select count(*)::int from mkt.campaign_members where campaign_id = (select v from ids where k = 'c1')::uuid and grp = 'TREATMENT'), 'só o tratamento vira destinatária');
reset role;
select ok((select bool_and(private.campaign_group(campaign_id, party_id, 50) = grp) from mkt.campaign_members where campaign_id = (select v from ids where k = 'c1')::uuid), 'o sorteio é estável: a mesma pessoa cai sempre no mesmo grupo');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((mkt.cancel_campaign((select v from ids where k = 'c1')::uuid)).status, 'CANCELLED', 'cancelar campanha ativa');
select is((select count(*)::int from mkt.campaign_recipients where campaign_id = (select v from ids where k = 'c1')::uuid and status = 'PENDING'), 0, 'e ninguém mais recebe');

-- ---------- Código único + página da campanha + link na mensagem ----------
insert into ids select 'c2', (mkt.save_campaign('{"name":"Hub código único","objective":"LAUNCH","audience":{"tags":["hub-g2"]},"ends_at":"2099-01-01T12:00:00Z","landing_url":"https://loja.example.com/colecao"}')).id::text;
select is((mkt.save_campaign_offer(jsonb_build_object('campaign_id', (select v from ids where k = 'c2'), 'mode', 'SHARED', 'kind', 'PERCENT', 'value', 10, 'code', 'hub10', 'max_uses', 50))).code, 'HUB10', 'código único em maiúsculas');
insert into ids select 'd2', pg_temp.disp('c2', '00000000-0000-4000-8000-0000000062f2', '[{"source":"FIRST_NAME"},{"source":"COUPON_CODE"},{"source":"COUPON_VALUE"},{"source":"CAMPAIGN_END"}]');
select is((mkt.campaign_checklist((select v from ids where k = 'c2')::uuid) ->> 'can_launch')::boolean, true, 'checklist ok');
select is((mkt.launch_campaign((select v from ids where k = 'c2')::uuid)).status, 'ACTIVE', 'lança com código único');
select is((select source || '/' || code || '/' || coalesce(max_uses::text, '-') from sales.coupons where campaign_id = (select v from ids where k = 'c2')::uuid), 'CAMPAIGN/HUB10/50', 'o cupom da campanha nasce no lançamento');
select ok((select count(*) = 4 from mkt.tracking_links where campaign_id = (select v from ids where k = 'c2')::uuid and active), 'links: story, bio, QR e a página da campanha');
reset role;
select is((mkt.dispatch_send_batch(pg_temp.did('c2'), 100) ->> 'sent')::int, 20, 'envia para as 20 pessoas do público (sem grupo de controle)');
select matches((select m.body from omni.messages m join mkt.campaign_recipients r on r.message_id = m.id where r.dispatch_id = pg_temp.did('c2') order by r.seq limit 1), '^Oi Pessoa! Cupom HUB10: 10% de desconto até 01/01\.$', 'mensagem com código, valor e fim da campanha');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((mkt.set_public_url('https://app.example.com/')), 'https://app.example.com', 'endereço público do sistema');
select is((public.resolve_link((select code || '-web' from mkt.campaigns where id = (select v from ids where k = 'c2')::uuid)) ->> 'target_url'), 'https://loja.example.com/colecao', 'o link curto da página resolve o destino');
select is((public.resolve_link((select code || '-story' from mkt.campaigns where id = (select v from ids where k = 'c2')::uuid)) ->> 'address'), '5548900000062', 'e o do WhatsApp devolve o número do canal');
select is((select count(*)::int from mkt.link_clicks where tracking_link_id in (select id from mkt.tracking_links where campaign_id = (select v from ids where k = 'c2')::uuid)), 2, 'cada resolução registra um clique');
select is(public.resolve_link('nao-existe-aqui'), null, 'código desconhecido não resolve');
select is((mkt.cancel_campaign((select v from ids where k = 'c2')::uuid)).status, 'CANCELLED', 'cancelar desativa o cupom e os links');
select is((select active from sales.coupons where campaign_id = (select v from ids where k = 'c2')::uuid), false, 'cupom da campanha cancelada para de valer');

-- ---------- Cupom pessoal ----------
insert into ids select 'c3', (mkt.save_campaign('{"name":"Hub cupom pessoal","objective":"REACTIVATE","audience":{"tags":["hub-g3"]}}')).id::text;
select is((mkt.save_campaign_offer(jsonb_build_object('campaign_id', (select v from ids where k = 'c3'), 'mode', 'PERSONAL', 'kind', 'PERCENT', 'value', 15, 'valid_days', 10, 'code_prefix', 'hubp'))).code_prefix, 'HUBP', 'cupom pessoal com prefixo');
insert into ids select 'd3', pg_temp.disp('c3', '00000000-0000-4000-8000-0000000062f2', '[{"source":"FIRST_NAME"},{"source":"COUPON_CODE"},{"source":"COUPON_VALUE"},{"source":"COUPON_EXPIRY"}]');
select is((mkt.launch_campaign((select v from ids where k = 'c3')::uuid)).status, 'ACTIVE', 'lança com cupom pessoal');
select is((select count(*)::int from sales.coupons where campaign_id = (select v from ids where k = 'c3')::uuid), 0, 'nenhum cupom é emitido antes do envio');
reset role;
select is((mkt.dispatch_send_batch(pg_temp.did('c3'), 100) ->> 'sent')::int, 5, 'envia para as 5 do público');
select is((select count(*)::int from sales.coupons where campaign_id = (select v from ids where k = 'c3')::uuid and party_id is not null and max_uses = 1 and per_customer_limit = 1 and code like 'HUBP-%' and source = 'CAMPAIGN'), 5, 'um cupom pessoal de uso único para quem recebeu');
select ok((select bool_and(m.coupon_id is not null) from mkt.campaign_members m join mkt.campaign_recipients r on r.campaign_id = m.campaign_id and r.party_id = m.party_id where m.campaign_id = (select v from ids where k = 'c3')::uuid and r.status = 'QUEUED'), 'o cupom fica ligado à pessoa na campanha');
select matches((select m.body from omni.messages m join mkt.campaign_recipients r on r.message_id = m.id where r.dispatch_id = pg_temp.did('c3') limit 1), '^Oi Pessoa! Cupom HUBP-[A-F0-9]{6}: 15% de desconto até \d\d/\d\d\.$', 'a mensagem leva o código pessoal, o valor e a validade');
select ok((select bool_and(valid_to between now() + interval '9 days' and now() + interval '10 days 1 minute') from sales.coupons where campaign_id = (select v from ids where k = 'c3')::uuid), 'validade = 10 dias depois do envio');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select ok((select (sales.party_auto_coupon(m.party_id) ->> 'code') ~ '^HUBP-' and (sales.party_auto_coupon(m.party_id) ->> 'source') = 'CAMPAIGN' and (sales.party_auto_coupon(m.party_id) ->> 'campaign') = 'Hub cupom pessoal'
          from mkt.campaign_members m where m.campaign_id = (select v from ids where k = 'c3')::uuid and m.coupon_id is not null limit 1), 'o cupom entra sozinho no PDV e diz de qual campanha veio');
select is((mkt.end_campaign((select v from ids where k = 'c3')::uuid)).status, 'ENDED', 'encerrar a campanha');
select is((select count(*)::int from sales.coupons where campaign_id = (select v from ids where k = 'c3')::uuid and active), 5, 'cupons pessoais já entregues seguem valendo até a própria validade');

-- ---------- Lembrete ----------
insert into ids select 'c4', (mkt.save_campaign('{"name":"Hub lembrete","objective":"CONVERT","audience":{"tags":["hub-g4"]}}')).id::text;
insert into ids select 'd4', pg_temp.disp('c4', '00000000-0000-4000-8000-0000000062f1', '[{"source":"FIRST_NAME"}]');
insert into ids select 'd4r', pg_temp.disp('c4', '00000000-0000-4000-8000-0000000062f1', '[{"source":"FIRST_NAME"}]', jsonb_build_object('filter', 'NOT_BOUGHT', 'scheduled_at', now() + interval '3 hours', 'label', 'Lembrete'));
select is((select i ->> 'ok' from jsonb_array_elements(mkt.campaign_checklist((select v from ids where k = 'c4')::uuid) -> 'items') i where i ->> 'key' = 'schedule_2'), 'false', 'o lembrete tem de sair 24 h depois do disparo principal');
select mkt.save_dispatch(jsonb_build_object('id', (select v from ids where k = 'd4r'), 'campaign_id', (select v from ids where k = 'c4'), 'channel_account_id', '00000000-0000-4000-8000-0000000062f8', 'template_id', '00000000-0000-4000-8000-0000000062f1',
  'variables', '[{"source":"FIRST_NAME"}]'::jsonb, 'filter', 'NOT_BOUGHT', 'scheduled_at', now() + interval '2 days', 'daily_limit', 1000));
select is((mkt.launch_campaign((select v from ids where k = 'c4')::uuid)).status, 'ACTIVE', 'lança com lembrete');
select is((select status from mkt.campaign_dispatches where id = (select v from ids where k = 'd4r')::uuid), 'SCHEDULED', 'o lembrete fica agendado');
select is((select count(*)::int from mkt.campaign_recipients where dispatch_id = (select v from ids where k = 'd4r')::uuid and status = 'PENDING'), 3, 'e já tem as 3 destinatárias');
reset role;
select is((mkt.dispatch_send_batch((select v from ids where k = 'd4')::uuid, 100) ->> 'sent')::int, 3, 'disparo principal envia para 3');
insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, subtotal, total, cost_total, idempotency_key, created_at)
  values ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'HUB-1', 'POS', 'PAID', '00000000-0000-4000-8000-000000620026'::uuid, 300, 300, 100, 'hub-1', now() + interval '1 minute');
select is((mkt.dispatch_send_batch((select v from ids where k = 'd4r')::uuid, 100) ->> 'sent')::int, 2, 'o lembrete vai só para quem não comprou (mesmo com o intervalo entre mensagens: a campanha é a mesma)');
select is((select skip_reason from mkt.campaign_recipients where dispatch_id = (select v from ids where k = 'd4r')::uuid and party_id = '00000000-0000-4000-8000-000000620026'), 'ALREADY_BOUGHT', 'quem comprou fica de fora do lembrete');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');

-- ---------- Lembrete novo numa campanha ativa e cancelar disparo ----------
insert into ids select 'd4x', pg_temp.disp('c4', '00000000-0000-4000-8000-0000000062f1', '[{"source":"FIRST_NAME"}]', jsonb_build_object('filter', 'NOT_REPLIED', 'scheduled_at', now() + interval '5 days'));
select is((mkt.activate_dispatch((select v from ids where k = 'd4x')::uuid)).status, 'SCHEDULED', 'agenda um lembrete novo depois do lançamento');
select throws_ok($$ select pg_temp.disp('c4', '00000000-0000-4000-8000-0000000062f1', '[{"source":"FIRST_NAME"}]', jsonb_build_object('filter', 'NOT_READ', 'scheduled_at', now() + interval '6 days')) $$, 'P0190', null, 'no máximo 2 lembretes');
select is((mkt.cancel_dispatch((select v from ids where k = 'd4x')::uuid)).status, 'CANCELLED', 'cancela só o disparo');
select is((select status from mkt.campaigns where id = (select v from ids where k = 'c4')::uuid), 'ACTIVE', 'a campanha continua ativa');

-- ---------- Afiliadas: link próprio e oferta de afiliada ----------
insert into ids select 'aff', (aff.save_affiliate(jsonb_build_object('party_id', '00000000-0000-4000-8000-000000620035', 'coupon_code', 'TRAINHUB', 'student_discount_pct', 10, 'commission_pct', 8))).id::text;
select is((select code from mkt.tracking_links where affiliate_party_id = '00000000-0000-4000-8000-000000620035' and kind = 'TRAINER' and campaign_id is null), 'trainhub', 'o cadastro da afiliada cria o link dela (código = cupom)');
insert into ids select 'c5', (mkt.save_campaign('{"name":"Hub afiliadas","objective":"LAUNCH","audience":{"tags":["hub-g5"]}}')).id::text;
select is((mkt.save_campaign_offer(jsonb_build_object('campaign_id', (select v from ids where k = 'c5'), 'mode', 'AFFILIATE'))).mode, 'AFFILIATE', 'oferta de afiliada');
insert into ids select 'd5', pg_temp.disp('c5', '00000000-0000-4000-8000-0000000062f1', '[{"source":"FIRST_NAME"}]');
select is((mkt.launch_campaign((select v from ids where k = 'c5')::uuid)).status, 'ACTIVE', 'lança com oferta de afiliada');
select ok(exists (select 1 from mkt.tracking_links where campaign_id = (select v from ids where k = 'c5')::uuid and affiliate_party_id = '00000000-0000-4000-8000-000000620035' and code like '%-trainhub'), 'cada afiliada ativa ganha um link da campanha');

-- ---------- Cupons: cadastro por RPC ----------
select is((sales.save_coupon('{"code":"avulso10","kind":"PERCENT","value":10,"min_order":100}')).code, 'AVULSO10', 'cria cupom avulso (código em maiúsculas)');
select throws_ok($$ select sales.save_coupon('{"code":"AVULSO10","kind":"PERCENT","value":5}') $$, 'P0190', null, 'código repetido');
select throws_ok($$ select sales.save_coupon('{"code":"AB","kind":"PERCENT","value":5}') $$, 'P0190', null, 'código curto');
select throws_ok($$ select sales.save_coupon('{"code":"SEMVALOR","kind":"PERCENT","value":0}') $$, 'P0190', null, 'valor zero');
select throws_ok($$ select sales.save_coupon(jsonb_build_object('id', (select id from sales.coupons where campaign_id = (select v from ids where k = 'c2')::uuid), 'code', 'HUB10', 'kind', 'PERCENT', 'value', 20)) $$, 'P0191', null, 'cupom de campanha só muda pela campanha');
select is((sales.save_coupon(jsonb_build_object('id', (select id from sales.coupons where code = 'AVULSO10'), 'code', 'AVULSO10', 'kind', 'PERCENT', 'value', 12))).value, 12.00, 'edita o cupom avulso');

-- ---------- Privilégios ----------
select ok(not has_function_privilege('authenticated', 'private.issue_personal_coupon(uuid,uuid,text,numeric,numeric,timestamptz,timestamptz,text,uuid,text)', 'execute') and not has_function_privilege('authenticated', 'private.close_campaigns()', 'execute'), 'emissão de cupom e fechamento são internos');
select ok(has_function_privilege('anon', 'public.resolve_link(text,jsonb)', 'execute'), 'o link curto é público');

select * from finish();
rollback;
