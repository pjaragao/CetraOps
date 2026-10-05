-- =====================================================================
-- Favorecidos padrão e recebedor diferente do fornecedor.
-- 1) Cadastro base de favorecidos obrigatórios: tributos (Receita Federal, INSS, Caixa/FGTS, SEF-SC, Prefeitura de Florianópolis),
--    concessionárias de SC (CELESC, CASAN, SCGÁS, Águas de Joinville), telefonia e Correios. CNPJs conferidos na Receita em 05/10/2026.
--    Cada um tem o tipo (payee_kind) e a categoria padrão do plano de contas (default_chart_account_id), usada quando o título
--    é lançado sem escolher a conta. Idempotente: se o CNPJ já existe, só completa tipo, categoria e a etiqueta.
-- 2) Recebedor diferente: fin.titles.party_id é quem forneceu de fato (o restaurante, o mercado); receiver_party_id é quem recebe
--    o dinheiro (o banco do boleto, o intermediador, o marketplace). Os relatórios por fornecedor usam party_id; a conciliação
--    pode bater pelo recebedor.
-- Códigos de erro: P0440 dado inválido · P0442 não encontrado.
-- =====================================================================

alter table crm.parties add column if not exists payee_kind text
  check (payee_kind is null or payee_kind in ('TAX_FEDERAL', 'TAX_STATE', 'TAX_MUNICIPAL', 'PAYROLL_CHARGE', 'UTILITY', 'TELECOM', 'LOGISTICS', 'INTERMEDIARY', 'OTHER'));
alter table crm.parties add column if not exists default_chart_account_id uuid references fin.chart_accounts(id) on delete set null;

alter table fin.titles add column if not exists receiver_party_id uuid references crm.parties(id);
create index if not exists titles_receiver_idx on fin.titles (receiver_party_id) where receiver_party_id is not null;

-- ---------------------------------------------------------------------
-- Favorecidos padrão
-- ---------------------------------------------------------------------
create or replace function private.seed_default_payees(p_org uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; v_party uuid; v_acc uuid; n int := 0;
begin
  if not exists (select 1 from core.orgs where id = p_org) then return 0; end if;
  for r in select * from (values
    -- cnpj, nome, razão social, tipo, conta padrão, o que se paga
    ('00394460005887', 'Receita Federal', 'MINISTERIO DA FAZENDA (RECEITA FEDERAL)', 'TAX_FEDERAL', '2.1.4.01', 'DAS do Simples Nacional, DARF (IRRF, PIS/COFINS, IRPJ/CSLL) e DCTFWeb (INSS e terceiros da folha). Pague pelo código de barras da guia.'),
    ('29979036000140', 'INSS', 'INSTITUTO NACIONAL DO SEGURO SOCIAL', 'PAYROLL_CHARGE', '2.1.3.04', 'GPS de contribuinte individual e débitos antigos. Os encargos da folha atuais saem na DCTFWeb (Receita Federal).'),
    ('00360305000104', 'Caixa — FGTS', 'CAIXA ECONOMICA FEDERAL', 'PAYROLL_CHARGE', '2.1.3.03', 'FGTS mensal e rescisório (guia do FGTS Digital, paga por Pix).'),
    ('82951310000156', 'SEF/SC — Secretaria da Fazenda', 'SECRETARIA DE ESTADO DA FAZENDA', 'TAX_STATE', null, 'ICMS fora do Simples (DIFAL, substituição tributária, antecipação) pelo DARE-SC.'),
    ('82892282000143', 'Prefeitura de Florianópolis', 'MUNICIPIO DE FLORIANOPOLIS', 'TAX_MUNICIPAL', null, 'IPTU e taxa de coleta, alvará e taxas municipais, ISS fora do Simples.'),
    ('08336783000190', 'CELESC — energia', 'CELESC DISTRIBUICAO S.A', 'UTILITY', '7.2.07', 'Conta de energia elétrica.'),
    ('82508433000117', 'CASAN — água e esgoto', 'COMPANHIA CATARINENSE DE AGUAS E SANEAMENTO CASAN', 'UTILITY', '7.2.07', 'Conta de água e esgoto (maior parte de SC).'),
    ('86864543000172', 'SCGÁS — gás canalizado', 'COMPANHIA DE GAS DE SANTA CATARINA', 'UTILITY', '7.2.07', 'Gás natural canalizado.'),
    ('07226794000155', 'Águas de Joinville', 'COMPANHIA AGUAS DE JOINVILLE', 'UTILITY', '7.2.07', 'Água e esgoto em Joinville.'),
    ('02558157000162', 'Vivo', 'TELEFONICA BRASIL S.A.', 'TELECOM', '7.2.07', 'Telefonia, internet e celular.'),
    ('40432544000147', 'Claro', 'CLARO S.A.', 'TELECOM', '7.2.07', 'Telefonia, internet e celular.'),
    ('02421421000111', 'TIM', 'TIM S A', 'TELECOM', '7.2.07', 'Telefonia, internet e celular.'),
    ('76535764000143', 'Oi', 'OI S.A.', 'TELECOM', '7.2.07', 'Telefonia e internet.'),
    ('34028316000103', 'Correios', 'EMPRESA BRASILEIRA DE CORREIOS E TELEGRAFOS', 'LOGISTICS', '7.1.03', 'Envio de pedidos, Sedex e PAC.')
  ) as t(cnpj, name, legal, kind, acc, notes) loop
    select id into v_acc from fin.chart_accounts where org_id = p_org and code = r.acc;
    select id into v_party from crm.parties where org_id = p_org and cnpj = r.cnpj and merged_into_id is null;
    if v_party is null then
      insert into crm.parties (org_id, kind, display_name, legal_name, cnpj, source, tags, preferences, payee_kind, default_chart_account_id)
      values (p_org, 'COMPANY', r.name, r.legal, r.cnpj, 'FAVORECIDO_PADRAO', array['favorecido-padrao'], jsonb_build_object('notes', r.notes), r.kind, v_acc)
      returning id into v_party;
      n := n + 1;
    else
      update crm.parties set payee_kind = coalesce(payee_kind, r.kind), default_chart_account_id = coalesce(default_chart_account_id, v_acc),
             tags = array(select distinct unnest(tags || array['favorecido-padrao']))
      where id = v_party;
    end if;
    insert into crm.party_roles (party_id, org_id, role) values (v_party, p_org, 'SUPPLIER') on conflict do nothing;
  end loop;
  return n;
end $$;

select private.seed_default_payees(id) from core.orgs;

-- Tipo e categoria padrão de um favorecido (ficha da empresa)
create or replace function crm.set_payee_defaults(p_party uuid, p_kind text, p_account uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id();
begin
  perform private.require_perm('crm.write');
  if not exists (select 1 from crm.parties where id = p_party and org_id = v_org) then raise exception 'Cadastro não encontrado' using errcode = 'P0442'; end if;
  if p_account is not null and not exists (select 1 from fin.chart_accounts where id = p_account and org_id = v_org and kind = 'ANALYTIC') then
    raise exception 'Escolha uma conta analítica do plano de contas' using errcode = 'P0440';
  end if;
  update crm.parties set payee_kind = nullif(p_kind, ''), default_chart_account_id = p_account where id = p_party;
end $$;

-- ---------------------------------------------------------------------
-- Títulos: categoria padrão do favorecido e recebedor diferente
-- ---------------------------------------------------------------------
create or replace function fin.create_title(p jsonb) returns fin.titles
language plpgsql security definer set search_path = '' as $$
declare t fin.titles; v_org uuid := private.org_id(); v_party uuid := nullif(p ->> 'party_id', '')::uuid; v_receiver uuid := nullif(p ->> 'receiver_party_id', '')::uuid; v_acc uuid;
begin
  perform private.require_perm('fin.write');
  if not exists (select 1 from core.legal_entities where id = (p ->> 'legal_entity_id')::uuid and org_id = v_org) then
    raise exception 'Empresa inválida';
  end if;
  if v_receiver is not null then
    if v_receiver = v_party then v_receiver := null;   -- igual ao fornecedor: não há recebedor diferente
    elsif not exists (select 1 from crm.parties where id = v_receiver and org_id = v_org and merged_into_id is null) then
      raise exception 'Recebedor não encontrado' using errcode = 'P0442';
    end if;
  end if;
  -- sem conta escolhida (e sem linhas de rateio): usa a categoria padrão do favorecido
  if nullif(p ->> 'chart_account_id', '') is null and jsonb_array_length(coalesce(p -> 'lines', '[]')) = 0 and v_party is not null then
    select default_chart_account_id into v_acc from crm.parties where id = v_party and org_id = v_org;
    if v_acc is not null then p := p || jsonb_build_object('chart_account_id', v_acc); end if;
  end if;
  -- via tela, o cliente não escolhe origem, modo de contabilização nem aprovação
  t := private.insert_title(p - 'origin_type' - 'origin_id' - 'accrual_mode' - 'approval_status' - 'control_account_id' - 'receiver_party_id', private.member_id());
  if v_receiver is not null then
    update fin.titles set receiver_party_id = v_receiver where id = t.id returning * into t;
  end if;
  return t;
end $$;

-- Trocar (ou tirar) o recebedor de um título já lançado
create or replace function fin.set_title_receiver(p_title uuid, p_receiver uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t fin.titles;
begin
  perform private.require_perm('fin.write');
  select * into t from fin.titles where id = p_title and org_id = private.org_id();
  if t.id is null then raise exception 'Título não encontrado' using errcode = 'P0442'; end if;
  if p_receiver is not null and not exists (select 1 from crm.parties where id = p_receiver and org_id = t.org_id and merged_into_id is null) then
    raise exception 'Recebedor não encontrado' using errcode = 'P0442';
  end if;
  update fin.titles set receiver_party_id = case when p_receiver = t.party_id then null else p_receiver end where id = t.id;
end $$;


-- Parcelas em aberto: mostra também o recebedor (colunas novas só no fim)
create or replace view fin.v_open_installments with (security_invoker = true) as
SELECT i.id AS installment_id, i.org_id, t.id AS title_id, t.legal_entity_id, t.store_id, t.direction, t.number AS title_number, t.description, t.document_kind,
       t.document_number, t.origin_type, t.party_id, p.display_name AS party_name, t.approval_status, t.cost_center_id, i.n, i.due_date, i.expected_date, i.amount,
       i.amount_settled, i.amount - i.amount_settled AS balance, i.fee_expected, i.fee_anticipation_expected, i.status,
       GREATEST(private.today_sp() - i.due_date, 0) AS days_overdue,
       t.receiver_party_id, rp.display_name AS receiver_name
  FROM fin.title_installments i
  JOIN fin.titles t ON t.id = i.title_id
  LEFT JOIN crm.parties p ON p.id = t.party_id
  LEFT JOIN crm.parties rp ON rp.id = t.receiver_party_id
 WHERE i.status = ANY (ARRAY['OPEN'::fin.title_status, 'PARTIAL'::fin.title_status]) AND t.status <> ALL (ARRAY['CANCELLED'::fin.title_status, 'RENEGOTIATED'::fin.title_status]);

insert into private.internal_functions (fqname) values ('private.seed_default_payees') on conflict do nothing;
select private.lock_functions();
