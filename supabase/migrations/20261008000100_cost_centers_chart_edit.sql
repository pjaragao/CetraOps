-- =====================================================================
-- Centros de custo e plano de contas editáveis.
--   • Centros de custo padrão de varejo de vestuário (administrativo, comercial com lojas e canais, marketing, produto e logística,
--     custos financeiros: tarifas bancárias, adquirência/MDR, antecipação, juros e multas, IOF, outros).
--     Criados para as organizações que já existem e para as novas. Códigos que já existirem ficam como estão.
--   • Toda loja vira centro de custo ao ser criada (gatilho em core.stores) e passa a ser o centro de resultado das vendas dela.
--     As lojas que já existem sem centro de custo são ajustadas agora.
--   • core.save_cost_center / core.set_cost_center_archived: criar, editar e arquivar centros de custo (fin.write ou core.admin).
--   • fin.save_chart_account / fin.set_chart_account_archived: criar, editar e arquivar contas do plano (fin.write).
--     Conta com lançamento, papel contábil ou conta bancária não muda de código, tipo, grupo nem conta-mãe (só nome e de-para).
--   • Conta "Stone — conta corrente" no disponível (1.1.1.xx) e, nas despesas financeiras (8.1), IOF e outras despesas financeiras, onde ainda não houver.
-- Códigos de erro: P0490 dado inválido · P0491 não encontrado · P0492 em uso.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Centros de custo padrão
-- ---------------------------------------------------------------------
create or replace function private.seed_default_cost_centers(p_org uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n int := 0; r record; v_parent uuid;
begin
  for r in select * from (values
      (1, 'ADM',         'Administrativo',                 null::text,  'CORPORATE'::core.cost_center_kind, null::text),
      (2, 'ADM-FIN',     'Financeiro e contabilidade',     'ADM',       'CORPORATE', null),
      (2, 'ADM-RH',      'Pessoas (RH)',                   'ADM',       'CORPORATE', null),
      (2, 'ADM-TI',      'Sistemas e tecnologia',          'ADM',       'CORPORATE', null),
      (1, 'COM',         'Comercial',                      null,        'POOL',      null),
      (2, 'COM-LOJAS',   'Lojas físicas',                  'COM',       'POOL',      null),
      (2, 'COM-ECOM',    'E-commerce (site)',              'COM',       'CHANNEL',   'ECOMMERCE'),
      (2, 'COM-SOCIAL',  'WhatsApp e Instagram',           'COM',       'CHANNEL',   'SOCIAL'),
      (2, 'COM-B2B',     'Atacado e B2B',                  'COM',       'CHANNEL',   'B2B'),
      (1, 'MKT',         'Marketing',                      null,        'POOL',      null),
      (2, 'MKT-MIDIA',   'Mídia paga e influenciadores',   'MKT',       'POOL',      null),
      (2, 'MKT-EVENTOS', 'Eventos e ativações',            'MKT',       'POOL',      null),
      (1, 'PROD',        'Produto e logística',            null,        'POOL',      null),
      (2, 'PROD-COLECAO','Compras e coleção',              'PROD',      'POOL',      null),
      (2, 'PROD-ESTOQUE','Estoque e expedição',            'PROD',      'POOL',      null),
      (1, 'FIN',         'Custos financeiros',             null,        'POOL',      null),
      (2, 'FIN-TARIFAS', 'Tarifas bancárias',              'FIN',       'POOL',      null),
      (2, 'FIN-ADQUIRENCIA','Taxas de adquirência (MDR)',  'FIN',       'POOL',      null),
      (2, 'FIN-ANTECIPACAO','Antecipação de recebíveis',   'FIN',       'POOL',      null),
      (2, 'FIN-JUROS',   'Juros e multas',                 'FIN',       'POOL',      null),
      (2, 'FIN-IOF',     'IOF e encargos financeiros',     'FIN',       'POOL',      null),
      (2, 'FIN-OUTROS',  'Outros custos financeiros',      'FIN',       'POOL',      null)
    ) as t(lvl, code, name, parent_code, kind, channel) order by lvl
  loop
    v_parent := null;
    if r.parent_code is not null then select id into v_parent from core.cost_centers where org_id = p_org and code = r.parent_code; end if;
    insert into core.cost_centers (org_id, parent_id, code, name, kind, channel)
    values (p_org, v_parent, r.code, r.name, r.kind, r.channel)
    on conflict (org_id, code) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Centro de custo de uma loja (cria se ainda não tem) — vira o centro de resultado das vendas dela
create or replace function private.ensure_store_cost_center(p_store uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s core.stores; v_cc uuid; v_parent uuid; v_code text; i int := 1;
begin
  select * into s from core.stores where id = p_store;
  if s.id is null then return null; end if;
  if s.cost_center_id is not null then return s.cost_center_id; end if;
  select id into v_cc from core.cost_centers where org_id = s.org_id and store_id = s.id and kind = 'STORE' and archived_at is null order by created_at limit 1;
  if v_cc is null then
    select id into v_parent from core.cost_centers where org_id = s.org_id and code = 'COM-LOJAS';
    v_code := left('LOJA-' || upper(regexp_replace(s.code, '[^A-Za-z0-9_-]', '', 'g')), 30);
    while exists (select 1 from core.cost_centers where org_id = s.org_id and code = v_code) loop
      i := i + 1; v_code := left('LOJA-' || upper(regexp_replace(s.code, '[^A-Za-z0-9_-]', '', 'g')), 27) || '-' || i;
    end loop;
    insert into core.cost_centers (org_id, parent_id, code, name, kind, legal_entity_id, store_id, valid_from)
    values (s.org_id, v_parent, v_code, 'Loja ' || s.name, 'STORE', s.legal_entity_id, s.id, coalesce(s.opened_at, current_date))
    returning id into v_cc;
  end if;
  update core.stores set cost_center_id = v_cc where id = s.id;
  return v_cc;
end $$;

create or replace function private.trg_store_cost_center() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- os dados de desenvolvimento (seed) montam a árvore da loja piloto à mão
  if coalesce(current_setting('centralops.skip_store_cost_center', true), '') = 'on' then return null; end if;
  perform private.ensure_store_cost_center(new.id);
  return null;
end $$;
create trigger trg_store_cost_center after insert on core.stores for each row when (new.cost_center_id is null)
  execute function private.trg_store_cost_center();

create or replace function private.trg_org_cost_centers() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.seed_default_cost_centers(new.id);
  return null;
end $$;
create trigger trg_org_cost_centers after insert on core.orgs for each row execute function private.trg_org_cost_centers();

-- Rotina única: padrões para quem já existe e centro de custo para as lojas já criadas
select private.seed_default_cost_centers(id) from core.orgs;
select private.ensure_store_cost_center(id) from core.stores where cost_center_id is null;
-- lojas com centro de custo próprio solto (sem pai) entram em "Lojas físicas"
update core.cost_centers c set parent_id = l.id
from core.cost_centers l
where l.org_id = c.org_id and l.code = 'COM-LOJAS' and c.kind = 'STORE' and c.parent_id is null;

-- ---------------------------------------------------------------------
-- 2) Centros de custo: criar, editar, arquivar
-- ---------------------------------------------------------------------
-- p = {id?, code, name, kind, parent_id?, legal_entity_id?, store_id?, channel?}
create or replace function core.save_cost_center(p jsonb) returns core.cost_centers
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; c core.cost_centers; v_kind core.cost_center_kind;
        v_code text := upper(trim(coalesce(p ->> 'code', ''))); v_name text := trim(coalesce(p ->> 'name', ''));
        v_parent uuid := nullif(p ->> 'parent_id', '')::uuid; v_le uuid := nullif(p ->> 'legal_entity_id', '')::uuid; v_store uuid := nullif(p ->> 'store_id', '')::uuid;
begin
  if not (private.has_perm('fin.write') or private.has_perm('core.admin')) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{1,29}$' then raise exception 'Código: 2 a 30 letras, números, - ou _' using errcode = 'P0490'; end if;
  if length(v_name) not between 2 and 80 then raise exception 'Nome: 2 a 80 caracteres' using errcode = 'P0490'; end if;
  begin v_kind := upper(coalesce(p ->> 'kind', 'POOL'))::core.cost_center_kind; exception when others then raise exception 'Tipo inválido' using errcode = 'P0490'; end;
  if v_parent is not null then
    if not exists (select 1 from core.cost_centers where id = v_parent and org_id = v_org and archived_at is null) then raise exception 'Centro de custo pai não encontrado' using errcode = 'P0491'; end if;
    if v_id is not null and (v_parent = v_id or exists (
         with recursive up as (select id, parent_id from core.cost_centers where id = v_parent
                               union all select c2.id, c2.parent_id from core.cost_centers c2 join up on c2.id = up.parent_id)
         select 1 from up where id = v_id)) then
      raise exception 'Um centro de custo não pode ficar dentro dele mesmo' using errcode = 'P0490';
    end if;
  end if;
  if v_le is not null and not exists (select 1 from core.legal_entities where id = v_le and org_id = v_org) then raise exception 'Empresa inválida' using errcode = 'P0491'; end if;
  if v_store is not null and not exists (select 1 from core.stores where id = v_store and org_id = v_org) then raise exception 'Loja inválida' using errcode = 'P0491'; end if;
  if v_id is null then
    insert into core.cost_centers (org_id, parent_id, code, name, kind, legal_entity_id, store_id, channel)
    values (v_org, v_parent, v_code, v_name, v_kind, v_le, v_store, nullif(trim(coalesce(p ->> 'channel', '')), ''))
    returning * into c;
  else
    update core.cost_centers set parent_id = v_parent, code = v_code, name = v_name, kind = v_kind, legal_entity_id = v_le, store_id = v_store,
           channel = nullif(trim(coalesce(p ->> 'channel', '')), '')
    where id = v_id and org_id = v_org returning * into c;
    if c.id is null then raise exception 'Centro de custo não encontrado' using errcode = 'P0491'; end if;
  end if;
  return c;
exception when unique_violation then
  raise exception 'Já existe um centro de custo com o código %', v_code using errcode = 'P0490';
end $$;

create or replace function core.set_cost_center_archived(p_id uuid, p_archived boolean) returns core.cost_centers
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); c core.cost_centers;
begin
  if not (private.has_perm('fin.write') or private.has_perm('core.admin')) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if p_archived then
    if exists (select 1 from core.cost_centers where parent_id = p_id and archived_at is null) then raise exception 'Arquive antes os centros de custo que estão dentro deste' using errcode = 'P0492'; end if;
    if exists (select 1 from core.stores where cost_center_id = p_id and status <> 'CLOSED') then raise exception 'É o centro de custo de uma loja ativa' using errcode = 'P0492'; end if;
  end if;
  update core.cost_centers set archived_at = case when p_archived then now() end, valid_to = case when p_archived then current_date end
  where id = p_id and org_id = v_org returning * into c;
  if c.id is null then raise exception 'Centro de custo não encontrado' using errcode = 'P0491'; end if;
  return c;
end $$;

-- ---------------------------------------------------------------------
-- 3) Plano de contas: criar, editar, arquivar
-- ---------------------------------------------------------------------
create or replace function private.chart_account_in_use(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from fin.journal_lines where account_id = p_id)
      or exists (select 1 from fin.account_roles where chart_account_id = p_id)
      or exists (select 1 from fin.bank_accounts where chart_account_id = p_id)
$$;

-- p = {id?, code, name, parent_id?, kind, nature?, group?, dre_line_id?, accountant_code?, cash_flow_group?}
create or replace function fin.save_chart_account(p jsonb) returns fin.chart_accounts
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; a fin.chart_accounts; old fin.chart_accounts; par fin.chart_accounts;
        v_code text := trim(coalesce(p ->> 'code', '')); v_name text := trim(coalesce(p ->> 'name', '')); v_kind text := upper(coalesce(p ->> 'kind', 'ANALYTIC'));
        v_nature text; v_group fin.account_group; v_dre uuid := nullif(p ->> 'dre_line_id', '')::uuid;
begin
  perform private.require_perm('fin.write');
  if v_code !~ '^[0-9]+(\.[0-9]+)*$' then raise exception 'Código: números separados por ponto (ex.: 1.1.1.06)' using errcode = 'P0490'; end if;
  if length(v_name) not between 2 and 120 then raise exception 'Nome: 2 a 120 caracteres' using errcode = 'P0490'; end if;
  if v_kind not in ('SYNTHETIC', 'ANALYTIC') then raise exception 'Tipo: sintética ou analítica' using errcode = 'P0490'; end if;
  if nullif(p ->> 'parent_id', '') is not null then
    select * into par from fin.chart_accounts where id = (p ->> 'parent_id')::uuid and org_id = v_org and archived_at is null;
    if par.id is null then raise exception 'Conta-mãe não encontrada' using errcode = 'P0491'; end if;
    if par.kind <> 'SYNTHETIC' then raise exception 'A conta-mãe precisa ser sintética (agrupadora)' using errcode = 'P0490'; end if;
    if v_code not like par.code || '.%' then raise exception 'O código precisa começar com o da conta-mãe (%.)', par.code using errcode = 'P0490'; end if;
  end if;
  v_nature := upper(coalesce(nullif(p ->> 'nature', ''), par.nature, 'DEBIT'));
  if v_nature not in ('DEBIT', 'CREDIT') then raise exception 'Natureza: devedora ou credora' using errcode = 'P0490'; end if;
  begin v_group := coalesce(nullif(p ->> 'group', ''), par."group"::text)::fin.account_group; exception when others then raise exception 'Grupo inválido' using errcode = 'P0490'; end;
  if v_group is null then raise exception 'Informe o grupo (ativo, passivo, receita, despesa…)' using errcode = 'P0490'; end if;
  if v_dre is not null and not exists (select 1 from fin.dre_lines where id = v_dre and org_id = v_org) then raise exception 'Linha do DRE inválida' using errcode = 'P0491'; end if;

  if v_id is null then
    insert into fin.chart_accounts (org_id, parent_id, code, name, kind, nature, "group", dre_line_id, cash_flow_group, accountant_code)
    values (v_org, par.id, v_code, v_name, v_kind, v_nature, v_group, v_dre, nullif(trim(coalesce(p ->> 'cash_flow_group', '')), ''), nullif(trim(coalesce(p ->> 'accountant_code', '')), ''))
    returning * into a;
  else
    select * into old from fin.chart_accounts where id = v_id and org_id = v_org for update;
    if old.id is null then raise exception 'Conta não encontrada' using errcode = 'P0491'; end if;
    if par.id = old.id then raise exception 'Uma conta não pode ser mãe dela mesma' using errcode = 'P0490'; end if;
    if (old.code <> v_code or old.kind <> v_kind or old."group" <> v_group or old.parent_id is distinct from par.id) then
      if private.chart_account_in_use(old.id) then
        raise exception 'Esta conta já tem lançamentos ou está ligada a uma conta bancária/papel contábil: só o nome, a linha do DRE e o código do contador podem mudar' using errcode = 'P0492';
      end if;
      if exists (select 1 from fin.chart_accounts where parent_id = old.id) and (old.code <> v_code or v_kind = 'ANALYTIC') then
        raise exception 'Esta conta tem subcontas: mude ou arquive as subcontas antes' using errcode = 'P0492';
      end if;
    end if;
    update fin.chart_accounts set parent_id = par.id, code = v_code, name = v_name, kind = v_kind, nature = v_nature, "group" = v_group, dre_line_id = v_dre,
           cash_flow_group = nullif(trim(coalesce(p ->> 'cash_flow_group', '')), ''), accountant_code = nullif(trim(coalesce(p ->> 'accountant_code', '')), '')
    where id = old.id returning * into a;
  end if;
  return a;
exception when unique_violation then
  raise exception 'Já existe uma conta com o código %', v_code using errcode = 'P0490';
end $$;

create or replace function fin.set_chart_account_archived(p_id uuid, p_archived boolean) returns fin.chart_accounts
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); a fin.chart_accounts;
begin
  perform private.require_perm('fin.write');
  if p_archived then
    if exists (select 1 from fin.chart_accounts where parent_id = p_id and archived_at is null) then raise exception 'Arquive antes as subcontas' using errcode = 'P0492'; end if;
    if exists (select 1 from fin.account_roles where chart_account_id = p_id) then raise exception 'A conta é usada pelos lançamentos automáticos (papel contábil): troque o papel antes' using errcode = 'P0492'; end if;
    if exists (select 1 from fin.bank_accounts where chart_account_id = p_id) then raise exception 'A conta está ligada a uma conta bancária' using errcode = 'P0492'; end if;
  end if;
  update fin.chart_accounts set archived_at = case when p_archived then now() end where id = p_id and org_id = v_org returning * into a;
  if a.id is null then raise exception 'Conta não encontrada' using errcode = 'P0491'; end if;
  return a;
end $$;

-- ---------------------------------------------------------------------
-- 4) Stone — conta corrente (no disponível, onde ainda não há)
-- ---------------------------------------------------------------------
do $x$
declare r record; v_next int;
begin
  for r in select a.org_id, a.id as parent_id from fin.chart_accounts a
           where a.code = '1.1.1' and a.kind = 'SYNTHETIC'
             and not exists (select 1 from fin.chart_accounts b where b.org_id = a.org_id and b.code like '1.1.1.%' and b.name ilike '%stone%conta corrente%')
  loop
    select coalesce(max(nullif(regexp_replace(code, '^1\.1\.1\.', ''), '')::int), 0) + 1 into v_next
    from fin.chart_accounts where org_id = r.org_id and code ~ '^1\.1\.1\.[0-9]+$';
    insert into fin.chart_accounts (org_id, parent_id, code, name, kind, nature, "group")
    values (r.org_id, r.parent_id, '1.1.1.' || lpad(v_next::text, 2, '0'), 'Stone — conta corrente', 'ANALYTIC', 'DEBIT', 'ASSET')
    on conflict (org_id, code) do nothing;
  end loop;
end $x$;

-- Despesas financeiras que faltavam no plano padrão (8.1.01 antecipação, 8.1.02 tarifas e 8.1.03 juros e multas já existem)
insert into fin.chart_accounts (org_id, parent_id, code, name, kind, nature, "group", dre_line_id, cash_flow_group)
select ref.org_id, ref.parent_id, x.code, x.name, 'ANALYTIC', 'DEBIT', 'FINANCIAL', ref.dre_line_id, ref.cash_flow_group
from fin.chart_accounts ref   -- mesma conta-mãe e mesma linha do DRE das tarifas bancárias
cross join (values ('8.1.04', 'IOF e encargos sobre operações financeiras'), ('8.1.05', 'Outras despesas financeiras')) as x(code, name)
where ref.code = '8.1.02'
on conflict (org_id, code) do nothing;

insert into private.internal_functions (fqname) values
  ('private.seed_default_cost_centers'), ('private.ensure_store_cost_center'), ('private.trg_store_cost_center'),
  ('private.trg_org_cost_centers'), ('private.chart_account_in_use')
on conflict do nothing;
select private.lock_functions();
