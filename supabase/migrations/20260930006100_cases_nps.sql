-- =====================================================================
-- Retenção/Recuperação (plano de marketing e atendimento, Fase 4): casos de reclamação, vale de cortesia e NPS.
-- • Caso: reclamação, defeito ou nota baixa vira um caso com dona, prazo de 1ª resposta (1 h) e de solução (48 h), solução registrada,
--   vale de cortesia opcional (contabilizado) e retorno em 7 dias. Enquanto há caso aberto a cliente fica fora das réguas de marketing.
-- • NPS: pergunta de 0 a 10 depois da compra (aviso automático NPS_ASK: texto, template ou tarefa); a resposta (só o número) é gravada;
--   nota até 6 abre caso (detratora) e 9 ou 10 vira tarefa de convite para indicar uma amiga.
-- Códigos de erro: P0400 dado inválido · P0401 situação não permite · P0402 não encontrado.
-- =====================================================================

-- Conta e papel contábil das cortesias
insert into fin.chart_accounts (org_id, parent_id, code, name, kind, nature, "group", dre_line_id, cash_flow_group)
select a.org_id, a.parent_id, '7.3.05', 'Cortesias e indicações (vales-troca)', a.kind, a.nature, a."group", a.dre_line_id, a.cash_flow_group
from fin.chart_accounts a where a.code = '7.3.03' and not exists (select 1 from fin.chart_accounts x where x.org_id = a.org_id and x.code = '7.3.05');
insert into fin.account_roles (org_id, role, chart_account_id)
select a.org_id, 'GOODWILL_EXPENSE', a.id from fin.chart_accounts a where a.code = '7.3.05' on conflict (org_id, role) do nothing;

-- Vale-troca de cortesia (ou de indicação): despesa × passivo de vale, no centro de custo da loja da cliente
create or replace function private.issue_credit(p_org uuid, p_party uuid, p_amount numeric, p_source_type text, p_source uuid, p_memo text, p_months int default 12) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_entity uuid; v_cc uuid; v_name text; v_id bigint; v_amount numeric := round(p_amount, 2);
begin
  if v_amount <= 0 then raise exception 'Valor do vale deve ser positivo' using errcode = 'P0400'; end if;
  select s.legal_entity_id, s.cost_center_id into v_entity, v_cc from crm.parties p join core.stores s on s.id = p.home_store_id where p.id = p_party;
  if v_entity is null then
    select e.id, (select s.cost_center_id from core.stores s where s.legal_entity_id = e.id and s.status = 'ACTIVE' order by s.created_at limit 1) into v_entity, v_cc
    from core.legal_entities e where e.org_id = p_org order by e.created_at limit 1;
  end if;
  if v_entity is null then raise exception 'Cadastre uma empresa antes de emitir vales' using errcode = 'P0401'; end if;
  select display_name into v_name from crm.parties where id = p_party;
  perform private.post_entry(v_entity, private.today_sp(), 'STORE_CREDIT_GOODWILL', p_source_type, p_source,
    p_memo || ' — ' || coalesce(v_name, ''),
    jsonb_build_array(jsonb_build_object('role', 'GOODWILL_EXPENSE', 'debit', v_amount, 'cost_center_id', v_cc, 'party_id', p_party, 'memo', p_memo),
                      jsonb_build_object('role', 'STORE_CREDIT_LIABILITY', 'credit', v_amount, 'party_id', p_party, 'memo', p_memo)));
  insert into sales.store_credit_ledger (org_id, party_id, amount, reason, source_type, source_id, expires_at, created_by)
  values (p_org, p_party, v_amount, 'GOODWILL', p_source_type, p_source, private.today_sp() + make_interval(months => p_months), private.member_id()) returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 1) Casos
-- ---------------------------------------------------------------------
create table crm.cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  number text not null,
  party_id uuid not null references crm.parties(id),
  conversation_id uuid references omni.conversations(id) on delete set null,
  kind text not null check (kind in ('COMPLAINT', 'DEFECT', 'DELIVERY', 'SERVICE', 'CSAT', 'NPS', 'OTHER')),
  title text not null,
  description text,
  status text not null default 'OPEN' check (status in ('OPEN', 'IN_PROGRESS', 'RESOLVED')),
  source text not null default 'MANUAL' check (source in ('MANUAL', 'CSAT', 'NPS', 'AI')),
  source_ref uuid,
  owner_member_id uuid references core.members(id),
  opened_by uuid references core.members(id),
  opened_at timestamptz not null default now(),
  first_response_due timestamptz not null,
  first_response_at timestamptz,
  resolve_due timestamptz not null,
  resolved_at timestamptz,
  solution text,
  courtesy_amount numeric(14, 2) not null default 0,
  courtesy_ledger_id bigint references sales.store_credit_ledger(id) on delete set null,
  followup_task_id uuid references crm.tasks(id) on delete set null,
  late_alerted boolean not null default false,
  unique (org_id, number)
);
create index cases_open_idx on crm.cases (org_id, status, resolve_due) where status <> 'RESOLVED';
create index cases_party_idx on crm.cases (party_id, opened_at desc);
select private.apply_rls('crm', array['cases'], 'crm.read', 'crm.write');
select private.rpc_only('crm', array['cases']);

create or replace function private.cases_cfg(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('first_response_hours', 1, 'resolve_hours', 48, 'followup_days', 7, 'max_courtesy', 200) || coalesce((select value from core.settings where org_id = p_org and key = 'cases'), '{}')
$$;

create or replace function private.open_case_core(p_org uuid, p_party uuid, p_conv uuid, p_kind text, p_title text, p_desc text, p_owner uuid, p_source text, p_ref uuid, p_task boolean) returns crm.cases
language plpgsql security definer set search_path = '' as $$
declare c jsonb := private.cases_cfg(p_org); x crm.cases; v_owner uuid; v_acc uuid; v_first timestamptz; v_name text;
begin
  select relationship_owner_member_id, display_name into v_owner, v_name from crm.parties where id = p_party;
  v_owner := coalesce(p_owner, v_owner, (select assignee_member_id from omni.conversations where id = p_conv));
  select channel_account_id into v_acc from omni.conversations where id = p_conv;
  v_first := case when v_acc is not null then private.business_add(v_acc, now(), ((c ->> 'first_response_hours')::numeric * 60)::int) else now() + make_interval(mins => ((c ->> 'first_response_hours')::numeric * 60)::int) end;
  insert into crm.cases (org_id, number, party_id, conversation_id, kind, title, description, owner_member_id, opened_by, source, source_ref, first_response_due, resolve_due)
  values (p_org, core.next_number(p_org, 'CAS'), p_party, p_conv, p_kind, left(trim(p_title), 140), nullif(left(trim(coalesce(p_desc, '')), 1000), ''), v_owner, private.member_id(), p_source, p_ref,
          v_first, now() + make_interval(hours => (c ->> 'resolve_hours')::int)) returning * into x;
  if p_task then
    insert into crm.tasks (org_id, party_id, assignee_member_id, type, title, body, due_at, source_rule)
    values (p_org, p_party, v_owner, 'RECOVERY', 'Caso ' || x.number || ': ' || left(x.title, 100), coalesce(x.description, 'Responda a cliente e registre a solução.'), x.first_response_due, 'case:' || x.id);
  end if;
  perform private.timeline(p_org, p_party, 'CASE', 'crm.cases', x.id, 'Caso aberto ' || x.number || ': ' || x.title);
  perform core.notify(p_org, 'CASE_OPENED', 'Caso ' || x.number || ' aberto: ' || coalesce(v_name, 'cliente'), jsonb_build_object('case_id', x.id, 'party_id', p_party), case when v_owner is null then 'crm.write' end, v_owner);
  return x;
end $$;

-- p = {party_id, conversation_id?, kind, title, description?, owner_member_id?}
create or replace function crm.open_case(p jsonb) returns crm.cases
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_party uuid := nullif(p ->> 'party_id', '')::uuid; v_conv uuid := nullif(p ->> 'conversation_id', '')::uuid; v_kind text := upper(coalesce(p ->> 'kind', 'COMPLAINT')); v_owner uuid := nullif(p ->> 'owner_member_id', '')::uuid;
begin
  perform private.require_perm('crm.write');
  if not exists (select 1 from crm.parties where id = v_party and org_id = v_org and merged_into_id is null) then raise exception 'Cliente não encontrada' using errcode = 'P0402'; end if;
  if v_kind not in ('COMPLAINT', 'DEFECT', 'DELIVERY', 'SERVICE', 'OTHER') then raise exception 'Tipo de caso inválido' using errcode = 'P0400'; end if;
  if length(trim(coalesce(p ->> 'title', ''))) < 3 then raise exception 'Descreva o caso em poucas palavras' using errcode = 'P0400'; end if;
  if v_conv is not null and not exists (select 1 from omni.conversations where id = v_conv and org_id = v_org and party_id = v_party) then raise exception 'Conversa não é desta cliente' using errcode = 'P0400'; end if;
  if v_owner is not null and not exists (select 1 from core.members where id = v_owner and org_id = v_org and status = 'ACTIVE') then raise exception 'Responsável inválida' using errcode = 'P0400'; end if;
  return private.open_case_core(v_org, v_party, v_conv, v_kind, p ->> 'title', p ->> 'description', v_owner, 'MANUAL', null, true);
end $$;

create or replace function crm.assign_case(p_id uuid, p_member uuid) returns crm.cases
language plpgsql security definer set search_path = '' as $$
declare x crm.cases;
begin
  perform private.require_perm('crm.write');
  if p_member is not null and not exists (select 1 from core.members where id = p_member and org_id = private.org_id() and status = 'ACTIVE') then raise exception 'Responsável inválida' using errcode = 'P0400'; end if;
  update crm.cases set owner_member_id = p_member, status = case when status = 'OPEN' then 'IN_PROGRESS' else status end where id = p_id and org_id = private.org_id() and status <> 'RESOLVED' returning * into x;
  if x.id is null then raise exception 'Caso não encontrado ou já resolvido' using errcode = 'P0402'; end if;
  update crm.tasks set assignee_member_id = p_member where source_rule = 'case:' || x.id and status = 'OPEN';
  if p_member is not null and p_member is distinct from private.member_id() then
    perform core.notify(x.org_id, 'CASE_OPENED', 'Caso ' || x.number || ' atribuído a você', jsonb_build_object('case_id', x.id, 'party_id', x.party_id), null, p_member);
  end if;
  return x;
end $$;

create or replace function crm.case_responded(p_id uuid) returns crm.cases
language plpgsql security definer set search_path = '' as $$
declare x crm.cases;
begin
  perform private.require_perm('crm.write');
  update crm.cases set first_response_at = coalesce(first_response_at, now()), status = case when status = 'OPEN' then 'IN_PROGRESS' else status end
  where id = p_id and org_id = private.org_id() and status <> 'RESOLVED' returning * into x;
  if x.id is null then raise exception 'Caso não encontrado ou já resolvido' using errcode = 'P0402'; end if;
  return x;
end $$;

-- Resolve: solução registrada, vale de cortesia opcional (sócio acima do limite) e retorno agendado
create or replace function crm.resolve_case(p_id uuid, p_solution text, p_courtesy numeric default 0) returns crm.cases
language plpgsql security definer set search_path = '' as $$
declare x crm.cases; c jsonb; v_ledger bigint; v_task uuid; v_name text; v_courtesy numeric := round(coalesce(p_courtesy, 0), 2);
begin
  perform private.require_perm('crm.write');
  select * into x from crm.cases where id = p_id and org_id = private.org_id() and status <> 'RESOLVED' for update;
  if x.id is null then raise exception 'Caso não encontrado ou já resolvido' using errcode = 'P0402'; end if;
  if length(trim(coalesce(p_solution, ''))) < 5 then raise exception 'Registre a solução (o que foi feito)' using errcode = 'P0400'; end if;
  c := private.cases_cfg(x.org_id);
  if v_courtesy < 0 then raise exception 'Cortesia inválida' using errcode = 'P0400'; end if;
  if v_courtesy > (c ->> 'max_courtesy')::numeric then perform private.require_perm('core.admin'); end if;
  if v_courtesy > 0 then v_ledger := private.issue_credit(x.org_id, x.party_id, v_courtesy, 'crm.cases', x.id, 'Cortesia do caso ' || x.number); end if;
  select display_name into v_name from crm.parties where id = x.party_id;
  insert into crm.tasks (org_id, party_id, assignee_member_id, type, title, suggested_message, due_at, source_rule)
  values (x.org_id, x.party_id, x.owner_member_id, 'FOLLOW_UP', 'Retorno do caso ' || x.number || ': ficou tudo certo?',
          'Oi, ' || split_part(v_name, ' ', 1) || '! Passando para saber se ficou tudo certo com ' || lower(left(x.title, 80)) || '. Se faltar algo, me fala que eu resolvo. 💛',
          now() + make_interval(days => (c ->> 'followup_days')::int), 'case-followup:' || x.id) returning id into v_task;
  update crm.cases set status = 'RESOLVED', resolved_at = now(), solution = trim(p_solution), courtesy_amount = v_courtesy, courtesy_ledger_id = v_ledger, followup_task_id = v_task,
         first_response_at = coalesce(first_response_at, now()) where id = x.id returning * into x;
  update crm.tasks set status = 'DONE', completed_at = now() where status = 'OPEN' and (source_rule = 'case:' || x.id or (x.source = 'CSAT' and source_rule = 'csat:' || x.source_ref));
  perform private.timeline(x.org_id, x.party_id, 'CASE', 'crm.cases', x.id, 'Caso ' || x.number || ' resolvido: ' || left(x.solution, 120) || case when v_courtesy > 0 then ' (vale de cortesia R$ ' || to_char(v_courtesy, 'FM999990.00') || ')' else '' end);
  return x;
end $$;

create or replace function crm.reopen_case(p_id uuid) returns crm.cases
language plpgsql security definer set search_path = '' as $$
declare x crm.cases;
begin
  perform private.require_perm('crm.write');
  update crm.cases set status = 'IN_PROGRESS', resolved_at = null, resolve_due = now() + interval '24 hours', late_alerted = false where id = p_id and org_id = private.org_id() and status = 'RESOLVED' returning * into x;
  if x.id is null then raise exception 'Só caso resolvido se reabre' using errcode = 'P0401'; end if;
  insert into crm.tasks (org_id, party_id, assignee_member_id, type, title, due_at, source_rule)
  values (x.org_id, x.party_id, x.owner_member_id, 'RECOVERY', 'Caso ' || x.number || ' reaberto: ' || left(x.title, 100), now() + interval '4 hours', 'case:' || x.id);
  return x;
end $$;

-- Alerta de prazo (a cada 15 min): 1ª resposta e solução atrasadas, uma vez por caso
create or replace function private.sweep_cases() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select c.id, c.org_id, c.number, c.owner_member_id, c.party_id, p.display_name,
                  (c.first_response_at is null and c.first_response_due < now()) as late_first
           from crm.cases c join crm.parties p on p.id = c.party_id
           where c.status <> 'RESOLVED' and not c.late_alerted and ((c.first_response_at is null and c.first_response_due < now()) or c.resolve_due < now()) loop
    perform core.notify(r.org_id, 'CASE_LATE', 'Caso ' || r.number || ' atrasado: ' || r.display_name || case when r.late_first then ' (sem 1ª resposta)' else ' (prazo de solução)' end,
                        jsonb_build_object('case_id', r.id, 'party_id', r.party_id), case when r.owner_member_id is null then 'crm.write' end, r.owner_member_id);
    update crm.cases set late_alerted = true where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;
select cron.schedule('centralops-sweep-cases', '*/15 * * * *', $$ select private.sweep_cases() $$);

-- CSAT baixo abre um caso (a tarefa do CSAT já é o "a fazer": o caso não cria outra)
create or replace function private.case_from_csat() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.score is not null and new.score <= 3 and old.score is null and not exists (select 1 from crm.cases where source = 'CSAT' and source_ref = new.id) then
    begin
      perform private.open_case_core(new.org_id, new.party_id, new.conversation_id, 'CSAT', 'Nota ' || new.score || ' no atendimento', null, new.assignee_member_id, 'CSAT', new.id, false);
    exception when others then raise warning 'caso do CSAT falhou: %', sqlerrm; end;
  end if;
  return null;
end $$;
create trigger trg_case_from_csat after update of score on omni.csat_responses for each row execute function private.case_from_csat();

-- ---------------------------------------------------------------------
-- 2) NPS
-- ---------------------------------------------------------------------
alter table omni.notice_rules drop constraint if exists notice_rules_event_check;
alter table omni.notice_rules add constraint notice_rules_event_check check (event in ('ORDER_PAID', 'READY_FOR_PICKUP', 'SHIPPED', 'LOCKER_READY', 'RESERVATION_EXPIRING', 'PAYMENT_LINK_REMINDER', 'STORE_CREDIT_ISSUED', 'EVENT_REMINDER', 'BACK_IN_STOCK', 'NPS_ASK'));
create or replace function private.notice_default_text(p_event text) returns text
language sql immutable as $$
  select case p_event
    when 'ORDER_PAID' then 'Oi, {nome}! Recebemos o pagamento do pedido {pedido}. Avisamos por aqui assim que estiver pronto. 💛'
    when 'READY_FOR_PICKUP' then 'Oi, {nome}! Seu pedido {pedido} está pronto para retirar na loja.'
    when 'SHIPPED' then 'Oi, {nome}! Seu pedido {pedido} saiu para entrega. Rastreio: {rastreio}'
    when 'LOCKER_READY' then 'Oi, {nome}! Suas peças estão separadas no Armário VIP {codigo} até {prazo}. É só pedir a chave na loja. ✨'
    when 'RESERVATION_EXPIRING' then 'Oi, {nome}! A peça que separamos para você fica reservada até {prazo}. Quer que a gente segure mais um pouco?'
    when 'PAYMENT_LINK_REMINDER' then 'Oi, {nome}! Passando para lembrar do link do pedido {pedido}: {link} . Se preferir, dá para pagar na loja também.'
    when 'STORE_CREDIT_ISSUED' then 'Oi, {nome}! Geramos um vale-troca de {valor} para você usar na loja. Ele já está no seu cadastro.'
    when 'EVENT_REMINDER' then 'Oi, {nome}! Lembrando do {evento} amanhã, {prazo}. Te esperamos! ✨'
    when 'BACK_IN_STOCK' then 'Oi, {nome}! Chegou {codigo} no tamanho que você pediu. {prazo} 💛'
    when 'NPS_ASK' then 'Oi, {nome}! De 0 a 10, quanto você indicaria a nossa loja para uma amiga? Responda só com o número. Sua resposta ajuda muito a gente. 💛'
  end
$$;

create table omni.nps_responses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  party_id uuid not null references crm.parties(id) on delete cascade,
  order_id uuid references sales.orders(id) on delete set null,
  channel_account_id uuid references omni.channel_accounts(id),
  asked_at timestamptz not null default now(),
  via text not null default 'MESSAGE' check (via in ('MESSAGE', 'MANUAL')),
  score smallint check (score between 0 and 10),
  comment text,
  answered_at timestamptz,
  unique (order_id)
);
create index nps_pending_idx on omni.nps_responses (party_id) where score is null;
select private.apply_rls('omni', array['nps_responses'], 'omni.read', 'omni.write');
select private.rpc_only('omni', array['nps_responses']);

create or replace function private.nps_cfg(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return jsonb_build_object('enabled', false, 'delay_days', 10, 'thanks', 'Obrigada pela resposta! 💛')
         || coalesce((select value from core.settings where org_id = p_org and key = 'nps'), '{}')
         || jsonb_build_object('enabled', coalesce((select active from omni.notice_rules where org_id = p_org and event = 'NPS_ASK'), false));
end $$;

create or replace function omni.save_nps_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_days int := coalesce((p ->> 'delay_days')::int, 10);
begin
  perform private.require_perm('omni.write');
  if v_days not between 3 and 60 then raise exception 'Perguntar de 3 a 60 dias depois da compra' using errcode = 'P0400'; end if;
  insert into core.settings (org_id, key, value) values (v_org, 'nps', jsonb_build_object('delay_days', v_days, 'thanks', coalesce(nullif(trim(p ->> 'thanks'), ''), 'Obrigada pela resposta! 💛')))
  on conflict (org_id, key) do update set value = excluded.value;
  -- liga/desliga o aviso NPS_ASK (texto e template se configuram em Avisos automáticos)
  insert into omni.notice_rules (org_id, event, active, free_text) values (v_org, 'NPS_ASK', coalesce((p ->> 'enabled')::boolean, false), private.notice_default_text('NPS_ASK'))
  on conflict (org_id, event) do update set active = excluded.active;
  return private.nps_cfg(v_org);
end $$;

-- Diariamente: pergunta o NPS de quem comprou há N dias (um por pedido; no máximo uma pergunta a cada 90 dias por pessoa)
create or replace function private.sweep_nps() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0; v_res text; v_days int; v_paid text[] := array['PAID', 'COMPLETED', 'FULFILLING', 'READY_FOR_PICKUP', 'SHIPPED', 'PARTIALLY_RETURNED'];
begin
  for r in select distinct on (o.party_id) o.id as order_id, o.org_id, o.party_id, o.number from sales.orders o
           join omni.notice_rules nr on nr.org_id = o.org_id and nr.event = 'NPS_ASK' and nr.active
           where o.status::text = any (v_paid) and o.party_id is not null
             and o.created_at between now() - make_interval(days => coalesce((select (value ->> 'delay_days')::int from core.settings where org_id = o.org_id and key = 'nps'), 10) + 3)
                                  and now() - make_interval(days => coalesce((select (value ->> 'delay_days')::int from core.settings where org_id = o.org_id and key = 'nps'), 10))
             and not exists (select 1 from omni.nps_responses x where x.order_id = o.id or (x.party_id = o.party_id and x.asked_at > now() - interval '90 days'))
             and not exists (select 1 from crm.cases c where c.party_id = o.party_id and c.status <> 'RESOLVED')
             and private.contact_block(o.party_id, 'RELATIONSHIP') is distinct from 'OPTED_OUT'
           order by o.party_id, o.created_at desc loop
    v_res := private.dispatch_notice(r.org_id, 'NPS_ASK', r.party_id, r.order_id, jsonb_build_object('pedido', r.number));
    if v_res in ('SENT_TEXT', 'SENT_TEMPLATE') then
      insert into omni.nps_responses (org_id, party_id, order_id, channel_account_id) values (r.org_id, r.party_id, r.order_id,
        (select id from omni.channel_accounts where org_id = r.org_id and channel = 'WHATSAPP' and status = 'ACTIVE' order by created_at limit 1))
      on conflict do nothing;
      n := n + 1;
    elsif v_res = 'TASK' then
      n := n + 1;                                                                    -- a equipe pergunta; registra a nota na ficha
    end if;
  end loop;
  return n;
end $$;
select cron.schedule('centralops-sweep-nps', '0 12 * * *', $$ select private.sweep_nps() $$);   -- 09:00 BRT

-- Registra a nota (pela resposta, pela equipe ou por telefone) e aplica as consequências
create or replace function private.apply_nps(p_org uuid, p_id uuid, p_score int, p_comment text) returns void
language plpgsql security definer set search_path = '' as $$
declare x omni.nps_responses; v_name text; v_owner uuid;
begin
  select * into x from omni.nps_responses where id = p_id;
  update omni.nps_responses set score = p_score, comment = nullif(left(trim(coalesce(p_comment, '')), 400), ''), answered_at = now() where id = p_id;
  select display_name, relationship_owner_member_id into v_name, v_owner from crm.parties where id = x.party_id;
  perform private.timeline(p_org, x.party_id, 'NPS', 'omni.nps_responses', p_id, 'NPS: nota ' || p_score || ' de 10' || coalesce(' — ' || nullif(trim(coalesce(p_comment, '')), ''), ''));
  if p_score <= 6 then
    if not exists (select 1 from crm.cases where source = 'NPS' and source_ref = p_id) then
      perform private.open_case_core(p_org, x.party_id, null, 'NPS', 'NPS ' || p_score || ': detratora, entender o que não foi bem', p_comment, v_owner, 'NPS', p_id, true);
    end if;
  elsif p_score >= 9 then
    insert into crm.tasks (org_id, party_id, assignee_member_id, type, title, suggested_message, due_at, source_rule)
    values (p_org, x.party_id, v_owner, 'FOLLOW_UP', 'Promotora (NPS ' || p_score || '): convidar ' || split_part(v_name, ' ', 1) || ' para indicar uma amiga',
            'Que bom saber, ' || split_part(v_name, ' ', 1) || '! 💛 Se quiser presentear uma amiga, tenho um link especial: ela ganha um mimo na primeira compra e você ganha um vale-troca. Posso te mandar?',
            now() + interval '2 days', 'nps-promoter:' || p_id);
  end if;
end $$;

create or replace function crm.record_nps(p_party uuid, p_score int, p_comment text default null, p_order uuid default null) returns omni.nps_responses
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); x omni.nps_responses;
begin
  perform private.require_perm('crm.write');
  if p_score not between 0 and 10 then raise exception 'A nota vai de 0 a 10' using errcode = 'P0400'; end if;
  if not exists (select 1 from crm.parties where id = p_party and org_id = v_org) then raise exception 'Cliente não encontrada' using errcode = 'P0402'; end if;
  select * into x from omni.nps_responses where party_id = p_party and score is null order by asked_at desc limit 1;
  if x.id is null then
    insert into omni.nps_responses (org_id, party_id, order_id, via) values (v_org, p_party, p_order, 'MANUAL') returning * into x;
  end if;
  perform private.apply_nps(v_org, x.id, p_score, p_comment);
  select * into x from omni.nps_responses where id = x.id;
  return x;
end $$;

-- Resposta pelo WhatsApp: só um número de 0 a 10, até 3 dias depois da pergunta (a nota do CSAT, de 1 a 5, tem prioridade se estiver pendente)
create or replace function private.capture_nps() returns trigger
language plpgsql security definer set search_path = '' as $$
declare x omni.nps_responses; v_party uuid; v_score int;
begin
  if new.direction <> 'IN' or new.author_type <> 'CUSTOMER' or coalesce(new.body, '') !~ '^\s*(10|[0-9])\s*$' then return null; end if;
  if coalesce((new.payload ->> 'csat_reply')::boolean, false) then return null; end if;
  v_score := substring(new.body from '^\s*(10|[0-9])')::int;
  select party_id into v_party from omni.conversations where id = new.conversation_id;
  select * into x from omni.nps_responses where party_id = v_party and score is null and asked_at > now() - interval '3 days' order by asked_at desc limit 1;
  if x.id is null then return null; end if;
  update omni.messages set payload = payload || jsonb_build_object('automation_handled', true, 'nps_reply', true) where id = new.id;
  perform private.apply_nps(new.org_id, x.id, v_score, null);
  perform omni.queue_system_message(new.conversation_id, private.nps_cfg(new.org_id) ->> 'thanks');
  return null;
end $$;
create trigger trg_zz_capture_nps after insert on omni.messages for each row execute function private.capture_nps();

create or replace function omni.nps_summary(p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('asked', count(*), 'answered', count(score), 'promoters', count(*) filter (where score >= 9), 'passives', count(*) filter (where score between 7 and 8),
    'detractors', count(*) filter (where score <= 6),
    'nps', case when count(score) > 0 then round(100.0 * (count(*) filter (where score >= 9) - count(*) filter (where score <= 6)) / count(score))::int end)
  from omni.nps_responses where org_id = private.org_id() and (select private.has_perm('omni.read')) and asked_at >= p_from and asked_at < p_to
$$;

insert into private.internal_functions (fqname) values ('private.issue_credit'), ('private.cases_cfg'), ('private.open_case_core'), ('private.sweep_cases'), ('private.case_from_csat'),
  ('private.nps_cfg'), ('private.sweep_nps'), ('private.apply_nps'), ('private.capture_nps') on conflict do nothing;
select private.lock_functions();
