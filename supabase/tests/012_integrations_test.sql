begin;
create extension if not exists pgtap with schema extensions;
select plan(41);

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
create temp table q0 as select coalesce((select queue_length from pgmq.metrics('integration_checks')), 0) as n;

-- ---------- Permissão ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (sem core.admin)
select throws_ok($$ select core.save_integration('{"provider":"META_WA","secret":{"token":"x"}}') $$, '42501', null, 'vendedora não cadastra integração');
select throws_ok($$ select core.request_integration_check('00000000-0000-4000-8000-000000000000') $$, '42501', null, 'vendedora não pede teste');
select throws_ok($$ select vault.create_secret('x', 'hack') $$, '42501', null, 'usuário não acessa o Vault direto');
select throws_ok($$ select * from vault.decrypted_secrets $$, '42501', null, 'usuário não lê segredos decifrados');

-- ---------- Salvar credencial ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
insert into ids select 'wa', (core.save_integration('{"provider":"meta_wa","capability":"messaging","config":{"phone_number_id":"123456789","waba_id":"WABA1"},"secret":{"token":"EAAG-token-de-teste-9f3c"}}'))->>'id';
select is((select status from core.integration_connections where id = (select v from ids where k = 'wa')::uuid), 'PENDING', 'nova conexão fica pendente até a verificação');
select is((select secret_ref is not null from core.integration_connections where id = (select v from ids where k = 'wa')::uuid), true, 'referência do segredo gravada');
select is((select config ->> 'secret_hint' from core.integration_connections where id = (select v from ids where k = 'wa')::uuid), '…9f3c', 'só os 4 últimos caracteres aparecem');
select is((select config ->> 'phone_number_id' from core.integration_connections where id = (select v from ids where k = 'wa')::uuid), '123456789', 'configuração não sensível guardada');
select is((select provider || '/' || capability from core.integration_connections where id = (select v from ids where k = 'wa')::uuid), 'META_WA/MESSAGING', 'provedor e capacidade normalizados');
select ok(not (core.save_integration('{"provider":"FOCUS_NFE","capability":"FISCAL","secret":{"token":"focus-tok-abcd"}}')::text like '%focus-tok-abcd%'), 'a resposta nunca devolve o segredo');

-- o segredo está no Vault, cifrado, e só o servidor (dono/service) consegue ler
reset role;
select is((select queue_length from pgmq.metrics('integration_checks')) - (select n from q0), 2::bigint, 'cada salvamento com credencial pede uma verificação ao worker');
select is((select decrypted_secret::jsonb ->> 'token' from vault.decrypted_secrets where name = (select secret_ref from core.integration_connections where id = (select v from ids where k = 'wa')::uuid)), 'EAAG-token-de-teste-9f3c', 'credencial guardada no Vault');
select is(core.integration_secret((select v from ids where k = 'wa')::uuid) ->> 'token', 'EAAG-token-de-teste-9f3c', 'o servidor recupera a credencial pela função interna');
select is((select count(*)::int from audit.log where table_name = 'core.integration_connections' and record_id = (select v from ids where k = 'wa') and after::text like '%EAAG-token-de-teste%'), 0, 'o log de auditoria não contém o segredo');
select ok((select count(*) from audit.log where table_name = 'core.integration_connections' and record_id = (select v from ids where k = 'wa')) >= 1, 'mudanças de integração ficam auditadas');

-- ---------- Validações ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select core.save_integration('{"provider":"x y"}') $$, 'P0110', null, 'provedor inválido');
select throws_ok($$ select core.save_integration('{"provider":"META_WA","capability":"MESSAGING","secret":{}}') $$, 'P0110', null, 'credencial vazia');
select throws_ok($$ select core.save_integration('{"provider":"META_WA","capability":"MESSAGING","secret":{"token":"   "}}') $$, 'P0110', null, 'campo da credencial em branco');
select throws_ok($$ select core.save_integration('{"provider":"META_WA","legal_entity_id":"00000000-0000-4000-8000-0000000000ff"}') $$, 'P0110', null, 'empresa de outra organização/inexistente');

-- ---------- Atualizar só a configuração mantém a credencial ----------
select core.save_integration('{"provider":"META_WA","capability":"MESSAGING","config":{"waba_id":"WABA2"}}');
select is((select config ->> 'waba_id' || '/' || (config ->> 'secret_hint') from core.integration_connections where id = (select v from ids where k = 'wa')::uuid), 'WABA2/…9f3c', 'configuração mesclada e credencial mantida');
select is((select count(*)::int from core.integration_connections where provider = 'META_WA' and capability = 'MESSAGING'), 1, 'mesma conexão (upsert), sem duplicar');

-- ---------- Pedir teste ----------
select lives_ok($$ select core.request_integration_check((select v from ids where k = 'wa')::uuid) $$, 'pede verificação');
select lives_ok($$ select core.request_integration_check((select v from ids where k = 'wa')::uuid, 'TELEGRAM_WEBHOOK') $$, 'pede registro de webhook');
select throws_ok($$ select core.request_integration_check((select v from ids where k = 'wa')::uuid, 'DROP') $$, 'P0110', null, 'ação desconhecida é recusada');
insert into ids select 'nosec', (core.save_integration('{"provider":"TELEGRAM","capability":"MESSAGING","config":{"bot_id":"555"}}'))->>'id';
select throws_ok($$ select core.request_integration_check((select v from ids where k = 'nosec')::uuid) $$, 'P0110', null, 'sem credencial não há o que testar');

-- ---------- Resultado da verificação (worker) ----------
reset role;
select core.record_integration_health((select v from ids where k = 'wa')::uuid, true, '{"verified_name":"Loja Demo"}');
select is((select status from core.integration_connections where id = (select v from ids where k = 'wa')::uuid), 'ACTIVE', 'verificação ok ativa a conexão');
select is((select config -> 'health' -> 'detail' ->> 'verified_name' from core.integration_connections where id = (select v from ids where k = 'wa')::uuid), 'Loja Demo', 'detalhes da verificação guardados');
select core.record_integration_health((select v from ids where k = 'wa')::uuid, false, '{}', 'token expirado');
select is((select status || '/' || last_error from core.integration_connections where id = (select v from ids where k = 'wa')::uuid), 'ERROR/token expirado', 'falha marca erro e guarda o motivo');
select ok((select count(*)::int from core.notifications where kind = 'INTEGRATION_ERROR' and payload ->> 'connection_id' = (select v from ids where k = 'wa')) >= 1, 'administradores são avisados quando a integração passa a dar erro');
create temp table err_before as select count(*)::int as n from core.notifications where kind = 'INTEGRATION_ERROR' and payload ->> 'connection_id' = (select v from ids where k = 'wa');
select core.record_integration_health((select v from ids where k = 'wa')::uuid, false, '{}', 'token expirado');
select is((select count(*)::int from core.notifications where kind = 'INTEGRATION_ERROR' and payload ->> 'connection_id' = (select v from ids where k = 'wa')), (select n from err_before), 'sem avisar de novo enquanto continua com erro');

-- ---------- Canais ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((omni.save_channel_account(jsonb_build_object('channel', 'WHATSAPP', 'provider_account_id', 'PN-INT-1', 'display_name', 'WhatsApp da loja (teste)', 'connection_id', (select v from ids where k = 'wa'),
  'store_id', '00000000-0000-4000-8000-0000000000a1', 'default_ai_mode', 'AI_AUTOPILOT'))).default_ai_mode::text, 'AI_AUTOPILOT', 'canal criado com a conexão certa');
select throws_ok($$ select omni.save_channel_account(jsonb_build_object('channel', 'INSTAGRAM', 'provider_account_id', 'IG-1', 'display_name', 'IG', 'connection_id', (select v from ids where k = 'wa'))) $$, 'P0112', null, 'conexão do WhatsApp não serve para o Instagram');
select throws_ok($$ select omni.save_channel_account(jsonb_build_object('channel', 'WHATSAPP', 'provider_account_id', 'PN-INT-1', 'display_name', 'Duplicado')) $$, 'P0112', null, 'mesmo identificador não cadastra duas vezes');
select throws_ok($$ select omni.save_channel_account(jsonb_build_object('channel', 'WHATSAPP', 'provider_account_id', 'PN-INT-2', 'display_name', 'X', 'default_ai_mode', 'WAITING_HUMAN')) $$, 'P0112', null, 'WAITING_HUMAN não é modo padrão');
select throws_ok($$ select omni.save_channel_account(jsonb_build_object('channel', 'WHATSAPP', 'provider_account_id', 'PN-INT-3', 'display_name', 'X', 'store_id', '00000000-0000-4000-8000-0000000000ff')) $$, 'P0112', null, 'loja inválida');

-- ---------- Remover credencial / desativar / verificação periódica ----------
select core.remove_integration_secret((select v from ids where k = 'wa')::uuid);
reset role;
select is((select count(*)::int from vault.secrets where name like 'integ/%/META_WA/%'), 0, 'credencial apagada do Vault');
select is((select status || '/' || coalesce(secret_ref, 'sem') || '/' || coalesce(config ->> 'secret_hint', 'sem') from core.integration_connections where id = (select v from ids where k = 'wa')::uuid), 'PENDING/sem/sem', 'conexão volta a pendente, sem referência nem pista');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select core.set_integration_enabled((select v from ids where k = 'nosec')::uuid, false);
reset role;
select is((select status from core.integration_connections where id = (select v from ids where k = 'nosec')::uuid), 'DISABLED', 'integração desativada');
select ok(private.enqueue_health_checks() >= 1, 'verificação periódica enfileira as conexões com credencial');   -- a da Focus NFe criada acima
select ok(not has_function_privilege('authenticated', 'core.record_integration_health(uuid,boolean,jsonb,text)', 'execute') and not has_function_privilege('authenticated', 'private.enqueue_health_checks()', 'execute'), 'resultado da verificação só pelo servidor');
select is((select count(*)::int from cron.job where jobname = 'centralops-integration-health' and active), 1, 'verificação a cada 30 minutos agendada');

select * from finish();
rollback;
