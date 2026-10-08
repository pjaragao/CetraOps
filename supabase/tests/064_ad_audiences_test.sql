begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

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

-- ---------- Preparação: 4 pessoas; 2 aceitam anúncios (uma só com e-mail), 1 aceita mas sem contato, 1 não aceita ----------
insert into crm.parties (id, org_id, kind, display_name, lifecycle_stage, tags, lead_score) values
  ('00000000-0000-4000-8000-000000640001', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Ana Anuncio (teste)', 'CUSTOMER', '{ads-test}', 90),
  ('00000000-0000-4000-8000-000000640002', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Bia Email (teste)', 'CUSTOMER', '{ads-test}', 80),
  ('00000000-0000-4000-8000-000000640003', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Cris SemContato (teste)', 'CUSTOMER', '{ads-test}', 70),
  ('00000000-0000-4000-8000-000000640004', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Duda SemAceite (teste)', 'CUSTOMER', '{ads-test}', 60);
insert into crm.party_contact_points (org_id, party_id, type, value_display, value_normalized, is_primary) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000640001', 'WHATSAPP', '+5548991110001', '+5548991110001', true),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000640002', 'EMAIL', 'Bia@Exemplo.com', 'bia@exemplo.com', true),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000640004', 'WHATSAPP', '+5548991110004', '+5548991110004', true);
insert into crm.consents (org_id, party_id, purpose, granted, legal_basis) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000640001', 'MARKETING_ADS', true, 'CONSENT'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000640002', 'MARKETING_ADS', true, 'CONSENT'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000640003', 'MARKETING_ADS', true, 'CONSENT'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000640004', 'MARKETING_ADS', true, 'CONSENT');
insert into crm.consents (org_id, party_id, purpose, granted, legal_basis, created_at) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000640004', 'MARKETING_ADS', false, 'CONSENT', now() + interval '1 second');   -- a Duda retirou o aceite
create temp table q0 as select (select queue_length from pgmq.metrics('campaign_tasks')) as t;

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into ids select 'seg', (mkt.save_segment('{"name":"Públicos Meta (teste)","definition":{"tags":["ads-test"]}}')).id::text;
select throws_ok($$ select mkt.request_audience_sync(jsonb_build_object('segment_id', (select v from ids where k = 'seg'))) $$, 'P0270', null, 'sem a Meta conectada não envia');
reset role;
insert into core.integration_connections (org_id, provider, capability, secret_ref, status, config) values ('00000000-0000-4000-8000-000000000001', 'META_ADS', 'ADS', 'segredo-teste', 'ACTIVE', '{"ad_account_id":"555"}');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select mkt.request_audience_sync('{}') $$, 'P0271', null, 'precisa de um público salvo, campanha ou filtro');
insert into ids select 'aud', (mkt.request_audience_sync(jsonb_build_object('segment_id', (select v from ids where k = 'seg'), 'auto_sync', true))).id::text;
select is((select status || '/' || name from mkt.ad_audiences where id = (select v from ids where k = 'aud')::uuid), 'PENDING/CentralOps · Públicos Meta (teste)', 'pede o envio do público salvo');
select is((mkt.request_audience_sync(jsonb_build_object('segment_id', (select v from ids where k = 'seg')))).id::text, (select v from ids where k = 'aud'), 'pedir de novo reaproveita o mesmo público da Meta');
reset role;
select is((select queue_length from pgmq.metrics('campaign_tasks')) - (select t from q0), 2::bigint, 'cada pedido vai para a fila do worker');

-- ---------- O que sobe ----------
select is(jsonb_array_length(mkt.audience_upload_rows((select v from ids where k = 'aud')::uuid)), 2, 'só sobe quem aceitou anúncios e tem telefone ou e-mail (a sem contato e a que retirou o aceite ficam de fora)');
select is((select string_agg(coalesce(x ->> 'phone', '-') || '|' || coalesce(x ->> 'email', '-') || '|' || (x ->> 'first_name'), ' ; ' order by x ->> 'first_name') from jsonb_array_elements(mkt.audience_upload_rows((select v from ids where k = 'aud')::uuid)) x),
  '5548991110001|-|Ana ; -|bia@exemplo.com|Bia', 'telefone só com dígitos, e-mail em minúsculas e só o primeiro nome');

-- ---------- Resultado do envio e semelhante ----------
select throws_ok($$ select mkt.request_lookalike((select v from ids where k = 'aud')::uuid, 1) $$, 'P0270', null, 'semelhante só depois de o público estar pronto');
select mkt.ad_audience_set((select v from ids where k = 'aud')::uuid, 'READY', 'META-AUD-1', 50, 48, 'act_555', null);
select throws_ok($$ select mkt.request_lookalike((select v from ids where k = 'aud')::uuid, 1) $$, 'P0270', null, 'a Meta exige 100 pessoas na origem');
select mkt.ad_audience_set((select v from ids where k = 'aud')::uuid, 'READY', null, 150, 140, null, null);
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select mkt.request_lookalike((select v from ids where k = 'aud')::uuid, 20) $$, 'P0271', null, 'semelhante vai de 1% a 10%');
insert into ids select 'look', (mkt.request_lookalike((select v from ids where k = 'aud')::uuid, 2)).id::text;
select is((select kind || '/' || lookalike_ratio::text || '/' || ad_account from mkt.ad_audiences where id = (select v from ids where k = 'look')::uuid), 'LOOKALIKE/2.00/act_555', 'semelhante de 2% criado');
select throws_ok($$ select mkt.delete_ad_audience((select v from ids where k = 'aud')::uuid) $$, 'P0270', null, 'não exclui o público que tem semelhante');
select lives_ok($$ select mkt.delete_ad_audience((select v from ids where k = 'look')::uuid) $$, 'exclui o semelhante');
select lives_ok($$ select mkt.delete_ad_audience((select v from ids where k = 'aud')::uuid) $$, 'e depois o público');

-- ---------- Atualização diária ----------
select mkt.request_audience_sync(jsonb_build_object('definition', '{"bought_within_days":60}'::jsonb, 'name', 'Clientes recentes (excluir dos anúncios)', 'auto_sync', true));
reset role;
select is(private.enqueue_audience_syncs(), 1, 'a rotina diária atualiza só os públicos marcados');

-- ---------- Campanha com público Meta ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into ids select 'camp', (mkt.save_campaign('{"name":"Campanha Meta (teste)","audience_scope":"META","holdout_pct":0,"audience":{"tags":["ads-test"]}}')).id::text;
select is((mkt.campaign_checklist((select v from ids where k = 'camp')::uuid) -> 'preview' ->> 'ads')::int, 2, 'a prévia conta quem aceitou anúncios e tem contato (2 de 4: a Cris não tem contato e a Duda retirou o aceite)');
select is((mkt.campaign_checklist((select v from ids where k = 'camp')::uuid) ->> 'can_launch')::boolean, true, 'público Meta basta como canal');
select is((mkt.launch_campaign((select v from ids where k = 'camp')::uuid)).status, 'ACTIVE', 'lança a campanha com público Meta');
select is((select count(*)::int from mkt.ad_audiences where campaign_id = (select v from ids where k = 'camp')::uuid and auto_sync), 1, 'o lançamento já cria o público da Meta da campanha');
reset role;
-- quem está no controle não sobe
update mkt.campaign_members set grp = 'HOLDOUT' where campaign_id = (select v from ids where k = 'camp')::uuid and party_id = '00000000-0000-4000-8000-000000640001';
select is(jsonb_array_length(mkt.audience_upload_rows((select id from mkt.ad_audiences where campaign_id = (select v from ids where k = 'camp')::uuid))), 1, 'o grupo de controle da campanha nunca sobe para a Meta');
select ok(not has_function_privilege('authenticated', 'mkt.audience_upload_rows(uuid)', 'execute') and not has_function_privilege('authenticated', 'mkt.ad_audience_set(uuid,text,text,integer,integer,text,text)', 'execute'), 'envio de contatos e gravação do resultado são só do worker');

select * from finish();
rollback;
