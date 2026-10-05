-- =====================================================================
-- Fiscal › Notas recebidas (MDe): descobre as NF-e emitidas contra o CNPJ da empresa (pelo provedor fiscal), registra a manifestação do
-- destinatário (ciência, confirmação, desconhecimento, não realizada) e guarda o XML quando a SEFAZ libera. A varredura roda a cada 2 h;
-- a manifestação é decisão de uma pessoa (tem efeito legal): nada é manifestado automaticamente.
-- Códigos de erro: P0250 dado inválido · P0251 situação não permite · P0252 não encontrado.
-- =====================================================================

alter table fiscal.inbound_dfe
  add column if not exists xml text,
  add column if not exists manifest_requested text check (manifest_requested in ('CIENCIA', 'CONFIRMADA', 'DESCONHECIDA', 'NAO_REALIZADA')),
  add column if not exists manifest_reason text,
  add column if not exists manifest_requested_by uuid references core.members(id),
  add column if not exists last_error text,
  add column if not exists updated_at timestamptz not null default now();
create index if not exists inbound_dfe_entity_issue_idx on fiscal.inbound_dfe (legal_entity_id, issue_at desc);

-- Até onde a varredura já leu em cada CNPJ (o provedor devolve só o que é novo depois da "versão")
create table fiscal.dfe_sync_state (
  legal_entity_id uuid primary key references core.legal_entities(id),
  org_id uuid not null references core.orgs(id),
  last_version bigint not null default 0,
  last_run_at timestamptz,
  last_found integer not null default 0,
  last_error text
);
select private.apply_rls('fiscal', array['dfe_sync_state'], 'fiscal.read', 'fiscal.write');
select private.rpc_only('fiscal', array['dfe_sync_state']);

-- ---------------------------------------------------------------------
-- Servidor (worker): grava o que o provedor devolveu
-- ---------------------------------------------------------------------
create or replace function fiscal.dfe_upsert(p_org uuid, p_entity uuid, p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare r jsonb; v_new int := 0; v_id uuid; v_ins boolean;
begin
  for r in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    if (r ->> 'access_key') !~ '^\d{44}$' then continue; end if;
    insert into fiscal.inbound_dfe (org_id, legal_entity_id, access_key, nsu, issuer_cnpj, issuer_name, amount, issue_at, manifest_status)
    values (p_org, p_entity, r ->> 'access_key', r ->> 'nsu', r ->> 'issuer_cnpj', r ->> 'issuer_name', (r ->> 'amount')::numeric, (r ->> 'issue_at')::timestamptz,
            coalesce(r ->> 'manifest_status', 'PENDING'))
    on conflict (org_id, access_key) do update set
      issuer_name = coalesce(excluded.issuer_name, fiscal.inbound_dfe.issuer_name), amount = coalesce(excluded.amount, fiscal.inbound_dfe.amount),
      manifest_status = case when excluded.manifest_status <> 'PENDING' then excluded.manifest_status else fiscal.inbound_dfe.manifest_status end, updated_at = now()
    returning id, (xmax = 0) into v_id, v_ins;
    if v_ins then v_new := v_new + 1; end if;
  end loop;
  if v_new > 0 then
    perform core.notify(p_org, 'DFE', format('%s nota(s) nova(s) emitida(s) contra o seu CNPJ na SEFAZ', v_new), jsonb_build_object('legal_entity_id', p_entity), 'fiscal.write', null);
  end if;
  return v_new;
end $$;

create or replace function fiscal.dfe_set_state(p_org uuid, p_entity uuid, p_version bigint, p_found integer, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into fiscal.dfe_sync_state (legal_entity_id, org_id, last_version, last_run_at, last_found, last_error)
  values (p_entity, p_org, coalesce(p_version, 0), now(), coalesce(p_found, 0), p_error)
  on conflict (legal_entity_id) do update set last_version = greatest(fiscal.dfe_sync_state.last_version, coalesce(excluded.last_version, 0)), last_run_at = now(),
    last_found = coalesce(p_found, 0), last_error = p_error;
end $$;

create or replace function fiscal.dfe_mark(p_id uuid, p_status text, p_error text default null, p_xml text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update fiscal.inbound_dfe set manifest_status = coalesce(p_status, manifest_status), last_error = p_error, xml = coalesce(p_xml, xml), xml_downloaded = xml_downloaded or p_xml is not null, updated_at = now()
  where id = p_id;
end $$;

-- ---------------------------------------------------------------------
-- Telas
-- ---------------------------------------------------------------------
create or replace function fiscal.request_dfe_sync() returns integer
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('fiscal.write');
  if not exists (select 1 from core.integration_connections where org_id = private.org_id() and provider = 'FOCUS_NFE' and status <> 'DISABLED') then
    raise exception 'Conecte o Focus NFe em Configurações › Integrações para buscar as notas na SEFAZ' using errcode = 'P0251';
  end if;
  perform private.enqueue('fiscal_emission', jsonb_build_object('action', 'DFE_SYNC', 'org_id', private.org_id()));
  return 1;
end $$;

create or replace function fiscal.request_manifest(p_id uuid, p_type text, p_reason text default null) returns fiscal.inbound_dfe
language plpgsql security definer set search_path = '' as $$
declare d fiscal.inbound_dfe; v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  perform private.require_perm('fiscal.write');
  if p_type not in ('CIENCIA', 'CONFIRMADA', 'DESCONHECIDA', 'NAO_REALIZADA') then raise exception 'Tipo de manifestação inválido' using errcode = 'P0250'; end if;
  if p_type in ('DESCONHECIDA', 'NAO_REALIZADA') and (v_reason is null or length(v_reason) not between 15 and 255) then
    raise exception 'A SEFAZ exige uma justificativa de 15 a 255 caracteres' using errcode = 'P0250';
  end if;
  select * into d from fiscal.inbound_dfe where id = p_id and org_id = private.org_id() for update;
  if d.id is null then raise exception 'Nota não encontrada' using errcode = 'P0252'; end if;
  if d.manifest_status in ('CONFIRMADA', 'DESCONHECIDA', 'NAO_REALIZADA') then raise exception 'Esta nota já tem manifestação conclusiva (%): não dá para mudar', d.manifest_status using errcode = 'P0251'; end if;
  if p_type = 'CIENCIA' and d.manifest_status = 'CIENCIA' then raise exception 'A ciência já foi registrada' using errcode = 'P0251'; end if;
  update fiscal.inbound_dfe set manifest_requested = p_type, manifest_reason = v_reason, manifest_requested_by = private.member_id(), last_error = null where id = d.id returning * into d;
  perform private.enqueue('fiscal_emission', jsonb_build_object('action', 'DFE_MANIFEST', 'org_id', d.org_id, 'dfe_id', d.id));
  return d;
end $$;

-- ---------------------------------------------------------------------
-- Varredura a cada 2 h: uma tarefa por organização com Focus NFe conectado
-- ---------------------------------------------------------------------
create or replace function private.enqueue_dfe_sync() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select distinct org_id from core.integration_connections where provider = 'FOCUS_NFE' and status <> 'DISABLED' and secret_ref is not null loop
    perform private.enqueue('fiscal_emission', jsonb_build_object('action', 'DFE_SYNC', 'org_id', r.org_id));
    n := n + 1;
  end loop;
  return n;
end $$;
select cron.schedule('centralops-dfe-sync', '15 */2 * * *', $$ select private.enqueue_dfe_sync() $$);

insert into private.internal_functions (fqname) values ('fiscal.dfe_upsert'), ('fiscal.dfe_set_state'), ('fiscal.dfe_mark'), ('private.enqueue_dfe_sync') on conflict do nothing;
select private.lock_functions();
