-- =====================================================================
-- Equipe › Freelancer PJ/MEI (prestador sem vínculo): para datas especiais e reforços pontuais.
-- NÃO é colaborador: não entra na folha nem gera FGTS/INSS/férias/13º. É um prestador cadastrado (cadastro único, papel
-- SERVICE_PROVIDER) pago por nota fiscal ou recibo, e cada diária vira uma conta a pagar (rascunho para aprovação do financeiro).
-- Alerta de risco trabalhista quando o mesmo prestador é chamado com frequência (rotina, horário fixo e subordinação caracterizam vínculo).
-- Intermitente e Temporário continuam CLT (mesmos encargos do CLT). Códigos de erro: P0380 dado inválido · P0381 situação · P0382 não encontrado.
-- =====================================================================

-- Conta contábil para o gasto (em todas as organizações), copiando os atributos de "Honorários contábeis"
insert into fin.chart_accounts (org_id, parent_id, code, name, kind, nature, "group", dre_line_id, cash_flow_group)
select a.org_id, a.parent_id, '7.2.09', 'Freelancers e prestadores pontuais (PJ/MEI)', a.kind, a.nature, a."group", a.dre_line_id, a.cash_flow_group
from fin.chart_accounts a where a.code = '7.2.05'
and not exists (select 1 from fin.chart_accounts x where x.org_id = a.org_id and x.code = '7.2.09');

create table hr.freelance_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  store_id uuid references core.stores(id),
  kind text not null check (kind in ('PJ', 'MEI')),
  service text not null,
  work_dates date[] not null check (cardinality(work_dates) between 1 and 31),
  amount numeric(14, 2) not null check (amount > 0),
  document_kind text not null default 'NFSE' check (document_kind in ('NFSE', 'RECIBO', 'NF_MEI')),
  title_id uuid references fin.titles(id) on delete set null,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now()
);
create index freelance_party_idx on hr.freelance_jobs (party_id, created_at desc);
select private.apply_rls('hr', array['freelance_jobs'], 'hr.read', 'hr.write');
select private.rpc_only('hr', array['freelance_jobs']);

-- p = {legal_entity_id, store_id?, name, cnpj, kind PJ|MEI, service, work_dates[], amount, due_date, document_kind?, pix?, phone?, email?, cost_center_id?}
create or replace function hr.engage_freelancer(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); le core.legal_entities; v_cnpj text := regexp_replace(coalesce(p ->> 'cnpj', ''), '\D', '', 'g'); v_kind text := upper(coalesce(p ->> 'kind', ''));
  v_party uuid; v_name text := trim(coalesce(p ->> 'name', '')); v_dates date[]; v_amount numeric := round(coalesce((p ->> 'amount')::numeric, 0), 2); v_due date;
  v_doc text := upper(coalesce(nullif(p ->> 'document_kind', ''), case when v_kind = 'MEI' then 'NF_MEI' else 'NFSE' end)); v_cc uuid := nullif(p ->> 'cost_center_id', '')::uuid;
  v_store uuid := nullif(p ->> 'store_id', '')::uuid; t fin.titles; v_acct uuid; v_recent int; v_job uuid; v_service text := trim(coalesce(p ->> 'service', ''));
begin
  perform private.require_perm('hr.write');
  perform private.require_perm('fin.write');
  select * into le from core.legal_entities where id = nullif(p ->> 'legal_entity_id', '')::uuid and org_id = v_org;
  if le.id is null then raise exception 'Empresa inválida' using errcode = 'P0380'; end if;
  if v_kind not in ('PJ', 'MEI') then raise exception 'Informe se é PJ ou MEI' using errcode = 'P0380'; end if;
  if not private.valid_cnpj(v_cnpj) then raise exception 'CNPJ inválido' using errcode = 'P0380'; end if;
  if length(v_name) < 3 then raise exception 'Informe o nome ou a razão social' using errcode = 'P0380'; end if;
  if length(v_service) < 3 then raise exception 'Descreva o serviço (ex.: reforço no atendimento do Drop)' using errcode = 'P0380'; end if;
  if v_amount <= 0 then raise exception 'Informe o valor combinado' using errcode = 'P0380'; end if;
  v_dates := array(select distinct x::date from jsonb_array_elements_text(coalesce(p -> 'work_dates', '[]')) x order by 1);
  if coalesce(cardinality(v_dates), 0) = 0 then raise exception 'Informe ao menos um dia de trabalho' using errcode = 'P0380'; end if;
  v_due := coalesce(nullif(p ->> 'due_date', '')::date, v_dates[cardinality(v_dates)] + 5);
  if v_due < v_dates[1] then raise exception 'O vencimento não pode ser antes do primeiro dia de trabalho' using errcode = 'P0380'; end if;
  if v_store is not null and not exists (select 1 from core.stores where id = v_store and org_id = v_org) then raise exception 'Loja inválida' using errcode = 'P0380'; end if;
  if v_cc is null and v_store is not null then select cost_center_id into v_cc from core.stores where id = v_store; end if;

  -- cadastro único: acha pelo CNPJ ou cria; ganha o papel de prestador
  select id into v_party from crm.parties where org_id = v_org and cnpj = v_cnpj;
  if v_party is null then
    insert into crm.parties (org_id, kind, display_name, legal_name, cnpj, source, tags) values (v_org, 'COMPANY', v_name, v_name, v_cnpj, 'RH', array['freelancer']) returning id into v_party;
  else
    update crm.parties set tags = array(select distinct unnest(tags || array['freelancer'])) where id = v_party;
  end if;
  insert into crm.party_roles (party_id, org_id, role) values (v_party, v_org, 'SERVICE_PROVIDER') on conflict do nothing;
  if nullif(trim(coalesce(p ->> 'phone', '')), '') is not null then
    insert into crm.party_contact_points (org_id, party_id, type, value_display) values (v_org, v_party, 'PHONE', trim(p ->> 'phone')) on conflict (org_id, type, value_normalized) do nothing;
  end if;
  if nullif(trim(coalesce(p ->> 'email', '')), '') is not null then
    insert into crm.party_contact_points (org_id, party_id, type, value_display) values (v_org, v_party, 'EMAIL', trim(p ->> 'email')) on conflict (org_id, type, value_normalized) do nothing;
  end if;

  select id into v_acct from fin.chart_accounts where org_id = v_org and code = '7.2.09';
  t := private.insert_title(jsonb_build_object(
    'direction', 'PAYABLE', 'legal_entity_id', le.id, 'store_id', v_store, 'party_id', v_party,
    'description', format('Freelancer %s — %s (%s)', v_name, v_service, array_to_string(array(select to_char(d, 'DD/MM') from unnest(v_dates) d), ', ')),
    'document_kind', v_doc, 'issue_date', private.today_sp(), 'competence_date', v_dates[1], 'chart_account_id', v_acct, 'cost_center_id', v_cc,
    'origin_type', 'MANUAL', 'approval_status', 'DRAFT', 'tags', jsonb_build_array('freelancer'),
    'installments', jsonb_build_array(jsonb_build_object('due_date', v_due, 'amount', v_amount))), private.member_id());

  insert into hr.freelance_jobs (org_id, party_id, legal_entity_id, store_id, kind, service, work_dates, amount, document_kind, title_id, created_by)
  values (v_org, v_party, le.id, v_store, v_kind, v_service, v_dates, v_amount, v_doc, t.id, private.member_id()) returning id into v_job;
  perform private.timeline(v_org, v_party, 'FREELANCE', 'hr.freelance_jobs', v_job, format('Freelancer: %s em %s dia(s) — R$ %s', v_service, cardinality(v_dates), to_char(v_amount, 'FM999G990D00')));

  select coalesce(sum(cardinality(work_dates)), 0)::int into v_recent from hr.freelance_jobs where party_id = v_party and created_at > now() - interval '90 days';
  return jsonb_build_object('job_id', v_job, 'title_id', t.id, 'party_id', v_party, 'days_last_90', v_recent,
    'risk', case when v_recent >= 12 then 'ALTO: mais de 12 diárias em 90 dias parece rotina; avalie contratar com vínculo (intermitente ou CLT)'
                 when v_recent >= 6 then 'ATENÇÃO: 6 ou mais diárias em 90 dias; evite horário fixo e subordinação para não caracterizar vínculo' end);
end $$;

select private.lock_functions();
