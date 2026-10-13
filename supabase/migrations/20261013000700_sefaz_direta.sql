-- =====================================================================
-- Emissão direta na SEFAZ (provedor SEFAZ, sem API paga); as APIs (Notaas, Focus NFe, Brasil NFe) ficam como segunda opção.
--  • Cofre: o certificado A1 (.pfx em base64) cabe no segredo; salvar só um campo novo (ex.: CSC) mescla com o que já está guardado
--    em vez de apagar o certificado; a "dica" nunca mostra pedaço de senha.
--  • fiscal.numbering: numeração própria da NFC-e por empresa/série/ambiente. Número que não chegou à SEFAZ volta para a fila
--    (released) e é usado na próxima nota, para não deixar buraco a inutilizar.
--  • fiscal.documents.provider: quem emitiu (SEFAZ, NOTAAS, …); record_emission guarda também o XML e os dados do DANFE.
--  • Notas recebidas (MDe) direto no Ambiente Nacional: a varredura respeita a espera de 1 hora da NT 2014.002 (consumo indevido).
--  • Inutilização de número de nota rejeitada que não vai ser reenviada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Cofre de integrações
-- ---------------------------------------------------------------------
create or replace function core.save_integration(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_provider text := upper(trim(coalesce(p ->> 'provider', ''))); v_cap text := upper(trim(coalesce(nullif(p ->> 'capability', ''), 'DEFAULT')));
  v_entity uuid := nullif(p ->> 'legal_entity_id', '')::uuid; c core.integration_connections; v_secret jsonb := p -> 'secret'; v_name text; v_vault uuid; v_hint text; k text; v text;
  v_old text; v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  perform private.require_perm('core.admin');
  if v_provider !~ '^[A-Z][A-Z0-9_]{1,29}$' then raise exception 'Provedor inválido' using errcode = 'P0110'; end if;
  if v_cap !~ '^[A-Z][A-Z0-9_]{1,29}$' then raise exception 'Capacidade inválida' using errcode = 'P0110'; end if;
  if v_entity is not null and not exists (select 1 from core.legal_entities where id = v_entity and org_id = v_org) then raise exception 'Empresa inválida' using errcode = 'P0110'; end if;
  if p ? 'config' and jsonb_typeof(p -> 'config') <> 'object' then raise exception 'Configuração inválida' using errcode = 'P0110'; end if;
  if v_secret is not null then
    if jsonb_typeof(v_secret) <> 'object' or v_secret = '{}'::jsonb then raise exception 'Informe a credencial' using errcode = 'P0110'; end if;
    for k, v in select key, value from jsonb_each_text(v_secret) loop
      -- certificado A1 em base64: o arquivo .pfx tem poucos KB; 200 mil caracteres cobrem qualquer certificado com cadeia
      if length(trim(v)) = 0 or length(v) > (case when k = 'certificate_pfx' then 200000 else 4000 end) then
        raise exception 'Credencial inválida: campo % vazio ou grande demais', k using errcode = 'P0110';
      end if;
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
      -- campos não enviados continuam como estavam (trocar só o CSC não apaga o certificado)
      select decrypted_secret into v_old from vault.decrypted_secrets where id = v_vault;
      if v_old is not null and left(v_old, 1) = '{' then v_secret := v_old::jsonb || v_secret; end if;
      perform vault.update_secret(v_vault, v_secret::text, v_name, null);
    end if;
    -- "…abcd": só os 4 últimos caracteres do valor principal (nunca de senha), para a pessoa reconhecer qual chave está guardada
    v_hint := case when v_secret ? 'certificate_pfx' then 'certificado A1'
                   else '…' || right(coalesce(v_secret ->> 'token', v_secret ->> 'access_token', v_secret ->> 'api_key',
                                              (select value from jsonb_each_text(v_secret) where key !~* '(password|senha)' order by key limit 1), ''), 4) end;
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

-- validade do certificado (tela da empresa e alertas): gravada pelo worker a cada teste da integração
create or replace function fiscal.set_certificate_info(p_entity uuid, p_expires_at timestamptz) returns void
language sql security definer set search_path = '' as $$
  update core.legal_entities set cert_expires_at = p_expires_at, updated_at = now() where id = p_entity;
$$;

-- ---------------------------------------------------------------------
-- 2) Numeração própria (emissão direta)
-- ---------------------------------------------------------------------
create table if not exists fiscal.numbering (
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  model text not null check (model in ('55', '65')),
  series int not null check (series between 0 and 999),
  tp_amb smallint not null check (tp_amb in (1, 2)),
  next_number int not null default 1 check (next_number between 1 and 1000000000),
  released int[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (legal_entity_id, model, series, tp_amb)
);
select private.apply_rls('fiscal', array['numbering'], 'fiscal.read', 'fiscal.write');
select private.rpc_only('fiscal', array['numbering']);

-- Próximo número: primeiro um devolvido (que nunca chegou à SEFAZ), senão o sequencial. p_min_next vem da tela
-- ("último número já usado nesta série" + 1) e só empurra a sequência para frente, nunca para trás.
create or replace function fiscal.reserve_fiscal_number(p_entity uuid, p_model text, p_series int, p_tp_amb int, p_min_next int default 1) returns int
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; r fiscal.numbering; v_n int;
begin
  select org_id into v_org from core.legal_entities where id = p_entity;
  if v_org is null then raise exception 'Empresa não encontrada' using errcode = 'P0002'; end if;
  insert into fiscal.numbering (org_id, legal_entity_id, model, series, tp_amb, next_number)
  values (v_org, p_entity, p_model, p_series, p_tp_amb, greatest(coalesce(p_min_next, 1), 1))
  on conflict (legal_entity_id, model, series, tp_amb) do nothing;
  select * into r from fiscal.numbering where legal_entity_id = p_entity and model = p_model and series = p_series and tp_amb = p_tp_amb for update;
  if cardinality(r.released) > 0 then
    v_n := (select min(x) from unnest(r.released) x);
    update fiscal.numbering set released = array_remove(released, v_n), updated_at = now()
    where legal_entity_id = p_entity and model = p_model and series = p_series and tp_amb = p_tp_amb;
    return v_n;
  end if;
  v_n := greatest(r.next_number, coalesce(p_min_next, 1));
  update fiscal.numbering set next_number = v_n + 1, updated_at = now()
  where legal_entity_id = p_entity and model = p_model and series = p_series and tp_amb = p_tp_amb;
  return v_n;
end $$;

-- Número reservado que não chegou à SEFAZ (falha de conexão antes do envio, ou a nota foi para a API reserva)
create or replace function fiscal.release_fiscal_number(p_entity uuid, p_model text, p_series int, p_tp_amb int, p_number int) returns void
language sql security definer set search_path = '' as $$
  update fiscal.numbering set released = (select array_agg(distinct x order by x) from unnest(released || p_number) x), updated_at = now()
  where legal_entity_id = p_entity and model = p_model and series = p_series and tp_amb = p_tp_amb and p_number < next_number;
$$;

-- ---------------------------------------------------------------------
-- 3) Documento: provedor, XML e dados do DANFE
-- ---------------------------------------------------------------------
alter table fiscal.documents add column if not exists provider text;

create or replace function fiscal.record_emission(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o sales.orders; d fiscal.documents; v_status text := p ->> 'status';
begin
  if v_status not in ('PROCESSING', 'AUTHORIZED', 'REJECTED', 'CANCELLED', 'DENIED', 'NUMBER_VOIDED') then raise exception 'Situação fiscal inválida: %', v_status using errcode = 'P0103'; end if;
  select * into o from sales.orders where id = (p ->> 'order_id')::uuid;
  if o.id is null then raise exception 'Pedido não encontrado' using errcode = 'P0002'; end if;
  insert into fiscal.documents (org_id, legal_entity_id, direction, model, series, number, access_key, status, issue_at, protocol, sefaz_code, sefaz_msg, counterpart_party_id,
                                totals, order_id, provider_ref, xml, xml_path, danfe_path, idempotency_key, events, provider)
  values (o.org_id, o.legal_entity_id, 'OUT', coalesce(p ->> 'model', '65'), (p ->> 'series')::int, (p ->> 'number')::int, nullif(p ->> 'access_key', ''), v_status::text,
          case when v_status = 'AUTHORIZED' then now() end, p ->> 'protocol', p ->> 'sefaz_code', p ->> 'sefaz_msg', o.party_id,
          jsonb_build_object('vNF', o.total) || coalesce(p -> 'totals', '{}'), o.id, p ->> 'provider_ref', p ->> 'xml', p ->> 'xml_path', p ->> 'danfe_path', p ->> 'ref',
          jsonb_build_array(coalesce(p -> 'event', jsonb_build_object('status', v_status, 'at', now()))), p ->> 'provider')
  on conflict (org_id, idempotency_key) where idempotency_key is not null do update set
    status = excluded.status, series = coalesce(excluded.series, fiscal.documents.series), number = coalesce(excluded.number, fiscal.documents.number),
    access_key = coalesce(excluded.access_key, fiscal.documents.access_key), protocol = coalesce(excluded.protocol, fiscal.documents.protocol),
    sefaz_code = excluded.sefaz_code, sefaz_msg = excluded.sefaz_msg, xml = coalesce(excluded.xml, fiscal.documents.xml),
    xml_path = coalesce(excluded.xml_path, fiscal.documents.xml_path), danfe_path = coalesce(excluded.danfe_path, fiscal.documents.danfe_path),
    totals = fiscal.documents.totals || coalesce(p -> 'totals', '{}'), provider = coalesce(excluded.provider, fiscal.documents.provider),
    provider_ref = coalesce(excluded.provider_ref, fiscal.documents.provider_ref),
    issue_at = coalesce(fiscal.documents.issue_at, excluded.issue_at), events = fiscal.documents.events || excluded.events
  returning * into d;
  return d.id;
end $$;

-- A tentativa direta não chegou à SEFAZ e a nota vai pela API reserva: limpa número/chave/XML (o número volta para a fila)
create or replace function fiscal.reset_direct_attempt(p_document uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare d fiscal.documents; v_amb int;
begin
  select * into d from fiscal.documents where id = p_document;
  if d.id is null or d.status not in ('PROCESSING', 'REJECTED') or coalesce(d.provider, '') <> 'SEFAZ' then return; end if;
  if d.number is not null and d.series is not null and d.access_key is not null then
    v_amb := coalesce((substring(d.xml from '<tpAmb>(\d)</tpAmb>'))::int, 2);
    perform fiscal.release_fiscal_number(d.legal_entity_id, d.model, d.series, v_amb, d.number);
  end if;
  -- DRAFT: o caminho da API emite (não fica só consultando como faria com PROCESSING)
  update fiscal.documents set status = 'DRAFT', number = null, series = null, access_key = null, xml = null, provider = null, provider_ref = null, danfe_path = null,
    totals = totals - 'danfe', events = events || jsonb_build_array(jsonb_build_object('type', 'SEFAZ_FALLBACK', 'message', p_reason, 'at', now()))
  where id = d.id;
end $$;

-- Número que a SEFAZ diz já estar em uso por outra nota (rejeição 539): a nota pega um número novo; o antigo não volta para a fila
create or replace function fiscal.discard_direct_number(p_document uuid, p_reason text) returns void
language sql security definer set search_path = '' as $$
  update fiscal.documents set number = null, access_key = null, xml = null, totals = totals - 'danfe',
    events = events || jsonb_build_array(jsonb_build_object('type', 'NUMBER_DISCARDED', 'number', number, 'series', series, 'message', p_reason, 'at', now()))
  where id = p_document and provider = 'SEFAZ' and status in ('PROCESSING', 'REJECTED');
$$;

-- ---------------------------------------------------------------------
-- 4) Inutilização (nota rejeitada que não vai ser reenviada)
-- ---------------------------------------------------------------------
create or replace function fiscal.request_number_void(p_document uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare d fiscal.documents; v_reason text := trim(coalesce(p_reason, ''));
begin
  perform private.require_perm('fiscal.write');
  select * into d from fiscal.documents where id = p_document and org_id = private.org_id() and direction = 'OUT';
  if d.id is null then raise exception 'Nota não encontrada' using errcode = 'P0123'; end if;
  if d.status <> 'REJECTED' or coalesce(d.provider, '') <> 'SEFAZ' or d.number is null then
    raise exception 'Só número de nota rejeitada emitida direto na SEFAZ pode ser inutilizado' using errcode = 'P0120';
  end if;
  if length(v_reason) not between 15 and 255 then raise exception 'A justificativa precisa ter de 15 a 255 caracteres' using errcode = 'P0122'; end if;
  perform private.enqueue('fiscal_emission', jsonb_build_object('org_id', d.org_id, 'document_id', d.id, 'action', 'VOID_NUMBER', 'reason', v_reason));
  update fiscal.documents set events = events || jsonb_build_array(jsonb_build_object('type', 'VOID_REQUESTED', 'by', private.member_id(), 'at', now(), 'reason', v_reason)) where id = d.id;
end $$;

create or replace function fiscal.record_number_void(p_document uuid, p jsonb) returns void
language sql security definer set search_path = '' as $$
  update fiscal.documents set status = 'NUMBER_VOIDED', protocol = coalesce(p ->> 'protocol', protocol), sefaz_code = p ->> 'sefaz_code', sefaz_msg = p ->> 'sefaz_msg',
    events = events || jsonb_build_array(jsonb_build_object('type', 'NUMBER_VOIDED', 'protocol', p ->> 'protocol', 'at', now()))
  where id = p_document and status = 'REJECTED';
$$;

-- ---------------------------------------------------------------------
-- 5) Notas recebidas direto no Ambiente Nacional
-- ---------------------------------------------------------------------
alter table fiscal.dfe_sync_state add column if not exists next_allowed_at timestamptz;

create or replace function fiscal.dfe_set_wait(p_org uuid, p_entity uuid, p_until timestamptz) returns void
language sql security definer set search_path = '' as $$
  insert into fiscal.dfe_sync_state (legal_entity_id, org_id, next_allowed_at) values (p_entity, p_org, p_until)
  on conflict (legal_entity_id) do update set next_allowed_at = p_until;
$$;

-- XML completo de nota recebida (chega pela distribuição depois da ciência/confirmação)
create or replace function fiscal.dfe_attach_xml(p_org uuid, p_key text, p_xml text) returns void
language sql security definer set search_path = '' as $$
  update fiscal.inbound_dfe set xml = p_xml, xml_downloaded = true, updated_at = now() where org_id = p_org and access_key = p_key;
$$;

create or replace function fiscal.request_dfe_sync() returns integer
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fiscal.write');
  if not exists (select 1 from core.integration_connections where org_id = private.org_id() and provider in ('SEFAZ', 'FOCUS_NFE', 'BRASIL_NFE') and status <> 'DISABLED') then
    raise exception 'A busca de notas recebidas usa o certificado (SEFAZ direta), o Focus NFe ou a Brasil NFe: conecte um deles em Configurações › Integrações' using errcode = 'P0251';
  end if;
  perform private.enqueue('fiscal_emission', jsonb_build_object('action', 'DFE_SYNC', 'org_id', private.org_id()));
  return 1;
end $$;

create or replace function private.enqueue_dfe_sync() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select distinct org_id from core.integration_connections where provider in ('SEFAZ', 'FOCUS_NFE', 'BRASIL_NFE') and status <> 'DISABLED' and secret_ref is not null loop
    perform private.enqueue('fiscal_emission', jsonb_build_object('action', 'DFE_SYNC', 'org_id', r.org_id));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 6) DANFE NFC-e e nota do pedido (quem vende imprime e envia o link de consulta da SEFAZ, mesmo sem acesso ao módulo fiscal)
-- ---------------------------------------------------------------------
create or replace function sales.get_order_fiscal_doc(p_order uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  perform private.require_perm('sales.read');
  select d.id, d.model, d.series, d.number, d.access_key, d.status, d.danfe_path, d.xml_path, d.issue_at, d.sefaz_code, d.sefaz_msg, d.provider,
         d.totals -> 'danfe' ->> 'qr_url' as consult_url
  into r
  from fiscal.documents d
  where d.order_id = p_order and d.org_id = private.org_id() and d.direction = 'OUT'
  order by d.created_at desc limit 1;
  if r.id is null then return null; end if;
  return to_jsonb(r);
end $$;

create or replace function sales.get_nfce_print(p_document uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d fiscal.documents;
begin
  if not (private.has_perm('sales.read') or private.has_perm('fiscal.read')) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  select * into d from fiscal.documents where id = p_document and org_id = private.org_id() and direction = 'OUT' and model = '65';
  if d.id is null or d.totals -> 'danfe' is null then return null; end if;
  return jsonb_build_object('id', d.id, 'status', d.status, 'order_id', d.order_id, 'number', d.number, 'series', d.series, 'access_key', d.access_key,
                            'protocol', d.protocol, 'issue_at', d.issue_at, 'danfe', d.totals -> 'danfe');
end $$;

-- ---------------------------------------------------------------------
-- 7) Privilégios
-- ---------------------------------------------------------------------
insert into private.internal_functions (fqname) values
  ('fiscal.set_certificate_info'), ('fiscal.reserve_fiscal_number'), ('fiscal.release_fiscal_number'), ('fiscal.reset_direct_attempt'),
  ('fiscal.discard_direct_number'), ('fiscal.record_number_void'), ('fiscal.dfe_set_wait'), ('fiscal.dfe_attach_xml')
on conflict do nothing;
select private.lock_functions();
