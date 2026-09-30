-- =====================================================================
-- Integrações: credenciais no Vault (nunca voltam ao navegador), verificação de saúde pelo worker e cadastro de canais.
-- A tela Configurações › Integrações só chama estas funções; o segredo entra por aqui e só sai para o worker (core.integration_secret).
-- Códigos de erro: P0110 dado inválido · P0111 não encontrado · P0112 regra de canal.
-- =====================================================================

do $$
begin
  perform pgmq.create('integration_checks');
  perform pgmq.create('integration_checks_dlq');
end $$;

-- Quem mudou credencial/configuração fica registrado (o log guarda o nome do segredo no Vault, nunca o valor)
drop trigger if exists trg_audit on core.integration_connections;
create trigger trg_audit after insert or update or delete on core.integration_connections for each row execute function private.audit_capture();

-- ---------------------------------------------------------------------
-- 1) Salvar conexão + credencial
-- p = {provider, capability?, legal_entity_id?, config?: {...não sensível...}, secret?: {token|access_token|api_key|...: texto}}
-- Sem `secret`, só a configuração muda (a credencial guardada é mantida).
-- ---------------------------------------------------------------------
create or replace function core.save_integration(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_provider text := upper(trim(coalesce(p ->> 'provider', ''))); v_cap text := upper(trim(coalesce(nullif(p ->> 'capability', ''), 'DEFAULT')));
  v_entity uuid := nullif(p ->> 'legal_entity_id', '')::uuid; c core.integration_connections; v_secret jsonb := p -> 'secret'; v_name text; v_vault uuid; v_hint text; k text; v text;
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  perform private.require_perm('core.admin');
  if v_provider !~ '^[A-Z][A-Z0-9_]{1,29}$' then raise exception 'Provedor inválido' using errcode = 'P0110'; end if;
  if v_cap !~ '^[A-Z][A-Z0-9_]{1,29}$' then raise exception 'Capacidade inválida' using errcode = 'P0110'; end if;
  if v_entity is not null and not exists (select 1 from core.legal_entities where id = v_entity and org_id = v_org) then raise exception 'Empresa inválida' using errcode = 'P0110'; end if;
  if p ? 'config' and jsonb_typeof(p -> 'config') <> 'object' then raise exception 'Configuração inválida' using errcode = 'P0110'; end if;
  if v_secret is not null then
    if jsonb_typeof(v_secret) <> 'object' or v_secret = '{}'::jsonb then raise exception 'Informe a credencial' using errcode = 'P0110'; end if;
    for k, v in select key, value from jsonb_each_text(v_secret) loop
      if length(trim(v)) = 0 or length(v) > 4000 then raise exception 'Credencial inválida: campo % vazio ou grande demais', k using errcode = 'P0110'; end if;
    end loop;
  end if;

  select * into c from core.integration_connections
  where org_id = v_org and provider = v_provider and capability = v_cap and coalesce(legal_entity_id, v_zero) = coalesce(v_entity, v_zero);
  if c.id is null then
    insert into core.integration_connections (org_id, provider, capability, legal_entity_id, config, status)
    values (v_org, v_provider, v_cap, v_entity, coalesce(p -> 'config', '{}'), 'PENDING') returning * into c;
  elsif p ? 'config' then
    update core.integration_connections set config = config || (p -> 'config') where id = c.id returning * into c;
  end if;

  if v_secret is not null then
    v_name := coalesce(c.secret_ref, format('integ/%s/%s/%s/%s', v_org, v_provider, v_cap, c.id));
    select id into v_vault from vault.secrets where name = v_name;
    if v_vault is null then
      perform vault.create_secret(v_secret::text, v_name, 'Credencial de integração ' || v_provider);
    else
      perform vault.update_secret(v_vault, v_secret::text, v_name, null);
    end if;
    -- "…abcd": só os 4 últimos caracteres do valor principal, para a pessoa reconhecer qual chave está guardada
    v_hint := '…' || right(coalesce(v_secret ->> 'token', v_secret ->> 'access_token', v_secret ->> 'api_key', (select value from jsonb_each_text(v_secret) order by key limit 1)), 4);
    update core.integration_connections
    set secret_ref = v_name, status = 'PENDING', last_error = null,
        config = config || jsonb_build_object('secret_hint', v_hint, 'secret_updated_at', now())
    where id = c.id returning * into c;
  end if;

  if c.secret_ref is not null then
    perform private.enqueue('integration_checks', jsonb_build_object('connection_id', c.id, 'org_id', v_org, 'action', 'CHECK'));
  end if;
  return jsonb_build_object('id', c.id, 'provider', c.provider, 'capability', c.capability, 'status', c.status, 'has_secret', c.secret_ref is not null, 'secret_hint', c.config ->> 'secret_hint');
end $$;

-- ---------------------------------------------------------------------
-- 2) Pedir teste agora / registrar webhook (o worker executa — só ele enxerga a credencial)
-- ---------------------------------------------------------------------
create or replace function core.request_integration_check(p_id uuid, p_action text default 'CHECK') returns void
language plpgsql security definer set search_path = '' as $$
declare c core.integration_connections;
begin
  perform private.require_perm('core.admin');
  if p_action not in ('CHECK', 'TELEGRAM_WEBHOOK') then raise exception 'Ação inválida' using errcode = 'P0110'; end if;
  select * into c from core.integration_connections where id = p_id and org_id = private.org_id();
  if c.id is null then raise exception 'Integração não encontrada' using errcode = 'P0111'; end if;
  if c.secret_ref is null then raise exception 'Cadastre a credencial antes de testar' using errcode = 'P0110'; end if;
  perform private.enqueue('integration_checks', jsonb_build_object('connection_id', c.id, 'org_id', c.org_id, 'action', p_action));
end $$;

-- ---------------------------------------------------------------------
-- 3) Remover a credencial (apaga do Vault) / desativar
-- ---------------------------------------------------------------------
create or replace function core.remove_integration_secret(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c core.integration_connections;
begin
  perform private.require_perm('core.admin');
  select * into c from core.integration_connections where id = p_id and org_id = private.org_id();
  if c.id is null then raise exception 'Integração não encontrada' using errcode = 'P0111'; end if;
  if c.secret_ref is not null then delete from vault.secrets where name = c.secret_ref; end if;
  update core.integration_connections set secret_ref = null, status = 'PENDING', last_error = null, config = (config - 'secret_hint' - 'secret_updated_at' - 'health') where id = c.id;
end $$;

create or replace function core.set_integration_enabled(p_id uuid, p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('core.admin');
  update core.integration_connections
  set status = case when p_enabled then 'PENDING' else 'DISABLED' end
  where id = p_id and org_id = private.org_id();
  if not found then raise exception 'Integração não encontrada' using errcode = 'P0111'; end if;
  if p_enabled then
    perform private.enqueue('integration_checks', jsonb_build_object('connection_id', p_id, 'org_id', private.org_id(), 'action', 'CHECK'))
    from core.integration_connections where id = p_id and secret_ref is not null;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4) Resultado da verificação (worker): atualiza a situação e avisa o administrador quando passa a dar erro
-- ---------------------------------------------------------------------
create or replace function core.record_integration_health(p_id uuid, p_ok boolean, p_detail jsonb default '{}', p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c core.integration_connections; v_was text;
begin
  select * into c from core.integration_connections where id = p_id;
  if c.id is null or c.status = 'DISABLED' then return; end if;
  v_was := c.status;
  update core.integration_connections
  set status = case when p_ok then 'ACTIVE' else 'ERROR' end,
      last_error = case when p_ok then null else left(coalesce(p_error, 'falha na verificação'), 500) end,
      last_sync_at = case when p_ok then now() else last_sync_at end,
      config = config || jsonb_build_object('health', jsonb_build_object('ok', p_ok, 'checked_at', now(), 'detail', coalesce(p_detail, '{}')))
  where id = p_id;
  if not p_ok and v_was <> 'ERROR' then
    perform core.notify(c.org_id, 'INTEGRATION_ERROR', 'Integração ' || c.provider || ' com erro: ' || left(coalesce(p_error, 'falha na verificação'), 140),
                        jsonb_build_object('connection_id', c.id, 'provider', c.provider), 'core.admin');
  end if;
end $$;

-- Verificação periódica (pg_cron): todas as conexões com credencial e não desativadas
create or replace function private.enqueue_health_checks() returns int
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select id, org_id from core.integration_connections where secret_ref is not null and status <> 'DISABLED' loop
    perform private.enqueue('integration_checks', jsonb_build_object('connection_id', r.id, 'org_id', r.org_id, 'action', 'CHECK'));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 5) Canais (WhatsApp / Instagram / Telegram): validação do vínculo canal × conexão
-- p = {id?, channel, provider_account_id, display_name, store_id?, default_ai_mode?, default_persona_id?, business_hours?, connection_id?, status?}
-- ---------------------------------------------------------------------
create or replace function omni.save_channel_account(p jsonb) returns omni.channel_accounts
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_channel omni.channel := (p ->> 'channel')::omni.channel; v_conn uuid := nullif(p ->> 'connection_id', '')::uuid;
  v_store uuid := nullif(p ->> 'store_id', '')::uuid; v_persona uuid := nullif(p ->> 'default_persona_id', '')::uuid; a omni.channel_accounts; v_provider text; v_expected text;
  v_mode omni.conv_mode := coalesce(nullif(p ->> 'default_ai_mode', ''), 'AI_COPILOT')::omni.conv_mode;
begin
  perform private.require_perm('core.admin');
  if coalesce(trim(p ->> 'provider_account_id'), '') = '' or coalesce(trim(p ->> 'display_name'), '') = '' then raise exception 'Informe o identificador e o nome do canal' using errcode = 'P0112'; end if;
  if v_mode = 'WAITING_HUMAN' then raise exception 'Modo padrão inválido para o canal' using errcode = 'P0112'; end if;   -- (HUMAN vale: número atendido só por pessoas)
  if v_store is not null and not exists (select 1 from core.stores where id = v_store and org_id = v_org) then raise exception 'Loja inválida' using errcode = 'P0112'; end if;
  if v_persona is not null and not exists (select 1 from ai.personas where id = v_persona and org_id = v_org) then raise exception 'Persona inválida' using errcode = 'P0112'; end if;
  if v_conn is not null then
    select provider into v_provider from core.integration_connections where id = v_conn and org_id = v_org;
    if v_provider is null then raise exception 'Conexão não encontrada' using errcode = 'P0112'; end if;
    v_expected := case v_channel when 'WHATSAPP' then 'META_WA' when 'INSTAGRAM' then 'META_IG' when 'TELEGRAM' then 'TELEGRAM' else 'TIKTOK' end;
    if v_provider <> v_expected then
      raise exception 'A conexão % não serve para o canal %', v_provider, v_channel using errcode = 'P0112';
    end if;
  end if;
  if v_id is null then
    insert into omni.channel_accounts (org_id, channel, provider_account_id, display_name, store_id, default_persona_id, default_ai_mode, business_hours, connection_id, status)
    values (v_org, v_channel, trim(p ->> 'provider_account_id'), trim(p ->> 'display_name'), v_store, v_persona, v_mode, coalesce(p -> 'business_hours', '{}'), v_conn, coalesce(nullif(p ->> 'status', ''), 'ACTIVE'))
    returning * into a;
  else
    update omni.channel_accounts set display_name = trim(p ->> 'display_name'), provider_account_id = trim(p ->> 'provider_account_id'), store_id = v_store, default_persona_id = v_persona,
           default_ai_mode = v_mode, business_hours = coalesce(p -> 'business_hours', business_hours), connection_id = v_conn, status = coalesce(nullif(p ->> 'status', ''), status)
    where id = v_id and org_id = v_org returning * into a;
    if a.id is null then raise exception 'Canal não encontrado' using errcode = 'P0112'; end if;
  end if;
  return a;
exception when unique_violation then
  raise exception 'Já existe um canal % com esse identificador', v_channel using errcode = 'P0112';
end $$;

insert into private.internal_functions (fqname) values ('core.record_integration_health'), ('private.enqueue_health_checks') on conflict do nothing;
select private.lock_functions();

select cron.schedule('sie-integration-health', '*/30 * * * *', $$ select private.enqueue_health_checks() $$);
