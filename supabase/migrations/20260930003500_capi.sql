-- =====================================================================
-- Meta Conversions API (CAPI): cada venda concluída vira um evento Purchase para a Meta otimizar os anúncios (plano §7).
-- O banco monta o que pode ser enviado (valor, horário, contatos e consentimentos) e registra o resultado; o worker faz o HTTP e o hash (SHA-256).
-- Regras de privacidade (aplicadas no worker e registradas aqui): venda vinda de anúncio no WhatsApp (ctwa_clid) vai sem dado pessoal;
-- venda sem anúncio só vai com consentimento de marketing e com telefone/e-mail já com hash.
-- =====================================================================

create table mkt.capi_events (
  order_id uuid primary key references sales.orders(id) on delete cascade,
  org_id uuid not null references core.orgs(id),
  event_name text not null default 'Purchase',
  status text not null check (status in ('SENT', 'SKIPPED', 'FAILED')),
  reason text,                                                    -- NOT_CONFIGURED | NOT_PAID | NO_CONSENT | NO_IDENTIFIERS | provider error
  response jsonb,
  attempted_at timestamptz not null default now()
);
create index capi_events_status_idx on mkt.capi_events (org_id, status, attempted_at desc);
select private.apply_rls('mkt', array['capi_events'], 'crm.read', 'crm.write');
select private.rpc_only('mkt', array['capi_events']);

-- Dados da venda para o worker (sem hash: quem faz o hash é o código que envia)
create or replace function mkt.capi_payload(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o sales.orders; v_phones text[]; v_emails text[]; v_cons jsonb;
begin
  select * into o from sales.orders where id = p_order;
  if o.id is null then return null; end if;
  select coalesce(array_agg(distinct regexp_replace(value_normalized, '\D', '', 'g')) filter (where type in ('WHATSAPP', 'PHONE') and length(regexp_replace(value_normalized, '\D', '', 'g')) >= 10), '{}'),
         coalesce(array_agg(distinct lower(value_normalized)) filter (where type = 'EMAIL'), '{}') into v_phones, v_emails
  from crm.party_contact_points where party_id = o.party_id;
  select coalesce(jsonb_object_agg(purpose::text, granted), '{}') into v_cons from crm.v_current_consents where party_id = o.party_id;
  return jsonb_build_object('order_id', o.id, 'org_id', o.org_id, 'status', o.status, 'total', o.total, 'currency', 'BRL',
    'event_time', extract(epoch from coalesce(o.completed_at, o.created_at))::bigint, 'party_id', o.party_id,
    'ctwa_clid', o.attribution #>> '{referral,ctwa_clid}', 'ctwa_clid_alt', o.attribution ->> 'ctwa_clid',
    'phones', to_jsonb(v_phones), 'emails', to_jsonb(v_emails), 'consents', v_cons);
end $$;

create or replace function mkt.capi_record(p jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into mkt.capi_events (order_id, org_id, event_name, status, reason, response)
  values ((p ->> 'order_id')::uuid, (p ->> 'org_id')::uuid, coalesce(p ->> 'event_name', 'Purchase'), p ->> 'status', left(p ->> 'reason', 300), p -> 'response')
  on conflict (order_id) do update set status = excluded.status, reason = excluded.reason, response = excluded.response, attempted_at = now()
$$;

insert into private.internal_functions (fqname) values ('mkt.capi_payload'), ('mkt.capi_record') on conflict do nothing;
select private.lock_functions();
