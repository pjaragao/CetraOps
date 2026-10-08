-- =====================================================================
-- Marketing › Públicos da Meta: manda um público (salvo ou o da campanha) para a Meta como "público personalizado", cria "semelhantes" a partir dele
-- e mantém atualizado todo dia. Só sobe quem deu consentimento para anúncios (MARKETING_ADS) e tem telefone ou e-mail; o worker faz o hash (SHA-256)
-- antes de enviar, então contato em claro nunca sai do servidor. Quem está no grupo de controle de uma campanha não sobe.
-- Códigos de erro: P0270 situação não permite · P0271 dado inválido · P0272 não encontrado.
-- =====================================================================

create table mkt.ad_audiences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  name text not null check (length(name) between 3 and 120),
  kind text not null default 'CUSTOM' check (kind in ('CUSTOM', 'LOOKALIKE')),
  segment_id uuid references mkt.segments(id) on delete set null,
  campaign_id uuid references mkt.campaigns(id) on delete set null,
  definition jsonb,                                              -- filtro direto (ex.: clientes recentes para excluir dos anúncios)
  source_audience_id uuid references mkt.ad_audiences(id) on delete cascade,
  lookalike_ratio numeric(4, 2) check (lookalike_ratio is null or lookalike_ratio between 1 and 10),
  ad_account text,
  meta_audience_id text,
  status text not null default 'PENDING' check (status in ('PENDING', 'SYNCING', 'READY', 'ERROR')),
  auto_sync boolean not null default false,
  uploaded integer,
  matched_estimate integer,
  last_sync_at timestamptz,
  last_error text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ad_audiences_segment_idx on mkt.ad_audiences (segment_id) where segment_id is not null;
create index ad_audiences_campaign_idx on mkt.ad_audiences (campaign_id) where campaign_id is not null;
select private.attach_updated_at('mkt');
select private.apply_rls('mkt', array['ad_audiences'], 'crm.read', 'crm.write');
select private.rpc_only('mkt', array['ad_audiences']);
create trigger trg_audit after insert or update or delete on mkt.ad_audiences for each row execute function private.audit_capture();

create or replace function private.meta_ads_connected(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core.integration_connections where org_id = p_org and provider = 'META_ADS' and status <> 'DISABLED' and secret_ref is not null
                 and coalesce(config ->> 'ad_account_id', '') <> '')
$$;

-- Cria (ou reaproveita) o público da Meta de um público salvo / campanha / filtro e pede o envio.
-- p = {segment_id? | campaign_id? | definition?, name?, auto_sync?}
create or replace function mkt.request_audience_sync(p jsonb) returns mkt.ad_audiences
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_seg uuid := nullif(p ->> 'segment_id', '')::uuid; v_camp uuid := nullif(p ->> 'campaign_id', '')::uuid; v_def jsonb := p -> 'definition';
  v_name text := nullif(trim(coalesce(p ->> 'name', '')), ''); a mkt.ad_audiences; v_auto boolean := coalesce((p ->> 'auto_sync')::boolean, false);
begin
  perform private.require_perm('core.admin');                       -- manda dados de clientes para fora: só sócio
  if (v_seg is not null)::int + (v_camp is not null)::int + (v_def is not null)::int <> 1 then raise exception 'Informe um público salvo, uma campanha ou um filtro' using errcode = 'P0271'; end if;
  if not private.meta_ads_connected(v_org) then raise exception 'Conecte a Meta (Anúncios) com o código da conta de anúncios em Configurações › Integrações' using errcode = 'P0270'; end if;
  if v_seg is not null then
    if not exists (select 1 from mkt.segments where id = v_seg and org_id = v_org) then raise exception 'Público salvo não encontrado' using errcode = 'P0272'; end if;
    v_name := coalesce(v_name, (select 'CentralOps · ' || name from mkt.segments where id = v_seg));
    select * into a from mkt.ad_audiences where org_id = v_org and segment_id = v_seg and kind = 'CUSTOM' order by created_at limit 1;
  elsif v_camp is not null then
    if not exists (select 1 from mkt.campaigns where id = v_camp and org_id = v_org) then raise exception 'Campanha não encontrada' using errcode = 'P0272'; end if;
    v_name := coalesce(v_name, (select 'CentralOps · ' || name from mkt.campaigns where id = v_camp));
    select * into a from mkt.ad_audiences where org_id = v_org and campaign_id = v_camp and kind = 'CUSTOM' order by created_at limit 1;
  else
    perform private.audience_validate(v_def);
    v_name := coalesce(v_name, 'CentralOps · público personalizado');
  end if;
  if a.id is null then
    insert into mkt.ad_audiences (org_id, name, kind, segment_id, campaign_id, definition, auto_sync, created_by)
    values (v_org, left(v_name, 120), 'CUSTOM', v_seg, v_camp, v_def, v_auto, private.member_id()) returning * into a;
  else
    update mkt.ad_audiences set auto_sync = v_auto, status = case when status = 'SYNCING' then status else 'PENDING' end where id = a.id returning * into a;
  end if;
  perform private.enqueue('campaign_tasks', jsonb_build_object('action', 'AUDIENCE_SYNC', 'audience_id', a.id, 'org_id', v_org));
  return a;
end $$;

create or replace function mkt.request_lookalike(p_audience uuid, p_ratio numeric default 1) returns mkt.ad_audiences
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); src mkt.ad_audiences; a mkt.ad_audiences;
begin
  perform private.require_perm('core.admin');
  select * into src from mkt.ad_audiences where id = p_audience and org_id = v_org and kind = 'CUSTOM';
  if src.id is null then raise exception 'Público da Meta não encontrado' using errcode = 'P0272'; end if;
  if src.status <> 'READY' or src.meta_audience_id is null then raise exception 'Envie o público para a Meta primeiro (e espere ficar pronto)' using errcode = 'P0270'; end if;
  if coalesce(src.uploaded, 0) < 100 then raise exception 'A Meta exige ao menos 100 pessoas no público de origem para criar um semelhante (enviadas: %)', coalesce(src.uploaded, 0) using errcode = 'P0270'; end if;
  if p_ratio is null or p_ratio < 1 or p_ratio > 10 then raise exception 'O semelhante vai de 1%% a 10%% da população' using errcode = 'P0271'; end if;
  insert into mkt.ad_audiences (org_id, name, kind, source_audience_id, lookalike_ratio, ad_account, created_by)
  values (v_org, left(src.name || ' · semelhante ' || trim(trailing '.' from trim(trailing '0' from p_ratio::text)) || '%', 120), 'LOOKALIKE', src.id, p_ratio, src.ad_account, private.member_id()) returning * into a;
  perform private.enqueue('campaign_tasks', jsonb_build_object('action', 'LOOKALIKE_CREATE', 'audience_id', a.id, 'org_id', v_org));
  return a;
end $$;

create or replace function mkt.delete_ad_audience(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare a mkt.ad_audiences;
begin
  perform private.require_perm('core.admin');
  select * into a from mkt.ad_audiences where id = p_id and org_id = private.org_id();
  if a.id is null then raise exception 'Público da Meta não encontrado' using errcode = 'P0272'; end if;
  if exists (select 1 from mkt.ad_audiences where source_audience_id = a.id) then raise exception 'Exclua antes os semelhantes criados a partir dele' using errcode = 'P0270'; end if;
  delete from mkt.ad_audiences where id = a.id;
  if a.meta_audience_id is not null then
    perform private.enqueue('campaign_tasks', jsonb_build_object('action', 'AUDIENCE_DELETE', 'meta_audience_id', a.meta_audience_id, 'org_id', a.org_id));
  end if;
end $$;

-- Worker: quem sobe (já filtrado por consentimento). Telefone só dígitos com DDI; e-mail em minúsculas; nome só o primeiro.
create or replace function mkt.audience_upload_rows(p_audience uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a mkt.ad_audiences; s mkt.segments; c mkt.campaigns; v_ids uuid[];
begin
  select * into a from mkt.ad_audiences where id = p_audience;
  if a.id is null then return null; end if;
  if a.campaign_id is not null then
    select array_agg(m.party_id) into v_ids from mkt.campaign_members m where m.campaign_id = a.campaign_id and m.grp = 'TREATMENT';
  elsif a.segment_id is not null then
    select * into s from mkt.segments where id = a.segment_id;
    v_ids := array(select x.party_id from private.audience_q(a.org_id, s.definition, 0, 20000) x);
  else
    v_ids := array(select x.party_id from private.audience_q(a.org_id, coalesce(a.definition, '{}'), 0, 20000) x);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'phone', (select regexp_replace(cp.value_normalized, '\D', '', 'g') from crm.party_contact_points cp where cp.party_id = p.id and cp.type in ('WHATSAPP', 'PHONE') and length(regexp_replace(cp.value_normalized, '\D', '', 'g')) >= 10 order by (cp.type = 'WHATSAPP') desc, cp.is_primary desc limit 1),
        'email', (select lower(cp.value_normalized) from crm.party_contact_points cp where cp.party_id = p.id and cp.type = 'EMAIL' order by cp.is_primary desc limit 1),
        'first_name', split_part(p.display_name, ' ', 1)))
    from crm.parties p
    where p.id = any (coalesce(v_ids, '{}')) and p.org_id = a.org_id
      and coalesce((select cc.granted from crm.v_current_consents cc where cc.party_id = p.id and cc.purpose = 'MARKETING_ADS'), false)
      and (private.party_wa_id(p.id) is not null or exists (select 1 from crm.party_contact_points cp where cp.party_id = p.id and cp.type = 'EMAIL'))), '[]'::jsonb);
end $$;

-- Worker: resultado do envio / criação
create or replace function mkt.ad_audience_set(p_audience uuid, p_status text, p_meta_id text default null, p_uploaded integer default null, p_matched integer default null,
                                               p_account text default null, p_error text default null) returns void
language sql security definer set search_path = '' as $$
  update mkt.ad_audiences set status = p_status, meta_audience_id = coalesce(p_meta_id, meta_audience_id), uploaded = coalesce(p_uploaded, uploaded), matched_estimate = coalesce(p_matched, matched_estimate),
         ad_account = coalesce(p_account, ad_account), last_error = left(p_error, 300), last_sync_at = case when p_status in ('READY', 'ERROR') then now() else last_sync_at end
  where id = p_audience
$$;

-- Todo dia (04:10 BRT): atualiza os públicos marcados para manter em dia
create or replace function private.enqueue_audience_syncs() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select a.id, a.org_id from mkt.ad_audiences a where a.auto_sync and a.kind = 'CUSTOM' and a.status <> 'SYNCING'
           and (a.campaign_id is null or exists (select 1 from mkt.campaigns c where c.id = a.campaign_id and c.status = 'ACTIVE')) and private.meta_ads_connected(a.org_id) loop
    update mkt.ad_audiences set status = 'PENDING' where id = r.id;
    perform private.enqueue('campaign_tasks', jsonb_build_object('action', 'AUDIENCE_SYNC', 'audience_id', r.id, 'org_id', r.org_id));
    n := n + 1;
  end loop;
  return n;
end $$;
select cron.schedule('centralops-audience-sync', '10 7 * * *', $$ select private.enqueue_audience_syncs() $$);

-- Lançar uma campanha com público Meta já cria o público da Meta e pede o envio
create or replace function private.campaign_launch_extras(c mkt.campaigns) returns void
language plpgsql security definer set search_path = '' as $$
declare a_id uuid;
begin
  if c.audience_scope in ('META', 'BOTH') then
    insert into mkt.ad_audiences (org_id, name, kind, campaign_id, auto_sync, created_by)
    values (c.org_id, left('CentralOps · ' || c.name, 120), 'CUSTOM', c.id, true, private.member_id()) returning id into a_id;
    perform private.enqueue('campaign_tasks', jsonb_build_object('action', 'AUDIENCE_SYNC', 'audience_id', a_id, 'org_id', c.org_id));
  end if;
end $$;

-- A venda enviada à Meta leva o código da campanha (dado não pessoal) para a otimização
do $x$
declare v_def text;
begin
  select pg_get_functiondef('mkt.capi_payload(uuid)'::regprocedure) into v_def;
  if position($y$'phones', to_jsonb(v_phones), 'emails', to_jsonb(v_emails), 'consents', v_cons);$y$ in v_def) = 0 then raise exception 'capi_payload mudou: ajuste este patch'; end if;
  v_def := replace(v_def, $y$'phones', to_jsonb(v_phones), 'emails', to_jsonb(v_emails), 'consents', v_cons);$y$,
    $y$'phones', to_jsonb(v_phones), 'emails', to_jsonb(v_emails), 'consents', v_cons,
    'campaign', (select c.code from mkt.campaigns c join mkt.campaign_members m on m.campaign_id = c.id where m.party_id = o.party_id and c.org_id = o.org_id and c.starts_at is not null
                 and c.starts_at <= o.created_at and c.status in ('ACTIVE', 'ENDED') order by c.starts_at desc limit 1));$y$);
  execute v_def;
end $x$;

insert into private.internal_functions (fqname) values ('mkt.audience_upload_rows'), ('mkt.ad_audience_set'), ('private.enqueue_audience_syncs'), ('private.meta_ads_connected') on conflict do nothing;
select private.lock_functions();
