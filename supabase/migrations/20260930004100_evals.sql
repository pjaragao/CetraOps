-- =====================================================================
-- Inteligência › Avaliações: o mesmo conjunto de conversas de teste roda em cada modelo candidato (pelo roteador de verdade, num sandbox que
-- nunca é confirmado no banco) e vira um ranking de qualidade × custo × latência. O resultado vale como portão: a rota de atendimento só troca
-- de modelo depois que o novo modelo passou (sem número inventado, sem desconto, handoff certo).
-- Códigos de erro: P0240 portão não atendido · P0241 dado inválido · P0242 situação não permite · P0243 não encontrado.
-- =====================================================================

create table ai.eval_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  suite text not null default 'conversation' check (suite in ('conversation')),
  key text not null check (key ~ '^[a-z0-9][a-z0-9_-]{1,59}$'),
  title text not null check (length(title) between 3 and 140),
  turns jsonb not null,                                           -- [{"role": "user" | "assistant", "text": "..."}]; a última é da cliente
  expect jsonb not null default '{}',                             -- outcome_in, tools_any, tools_none, must_match_any, must_not_match, no_flags
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, suite, key)
);

create table ai.eval_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  suite text not null default 'conversation',
  models text[] not null,
  status text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'DONE', 'FAILED')),
  requested_by uuid references core.members(id),
  requested_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  progress text
);

create table ai.eval_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  request_id uuid references ai.eval_requests(id) on delete set null,
  suite text not null,
  route_task text not null default 'conversation',
  model text not null,
  cases integer not null default 0,
  passed integer not null default 0,
  factual_failures integer not null default 0,                    -- preço, parcela, estoque ou desconto sem fundamento na resposta final
  handoff_misses integer not null default 0,                      -- deveria transferir para uma pessoa e não transferiu
  avg_latency_ms integer,
  p95_latency_ms integer,
  cost_usd numeric(12, 6) not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  created_at timestamptz not null default now()
);
create index on ai.eval_batches (org_id, route_task, model, created_at desc);

create table ai.eval_results (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  batch_id uuid not null references ai.eval_batches(id) on delete cascade,
  case_id uuid references ai.eval_cases(id) on delete set null,
  case_key text not null,
  passed boolean not null,
  failures jsonb not null default '[]',
  outcome text,                                                   -- SEND | DRAFT | HANDOFF | NONE
  flags jsonb not null default '[]',
  replies jsonb not null default '[]',
  tools jsonb not null default '[]',
  latency_ms integer,
  cost_usd numeric(12, 6) not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  error text
);
create index on ai.eval_results (batch_id);

select private.attach_updated_at('ai');
select private.apply_rls('ai', array['eval_cases', 'eval_requests', 'eval_batches', 'eval_results'], 'ai.read', 'ai.write');
select private.rpc_only('ai', array['eval_cases', 'eval_requests', 'eval_batches', 'eval_results']);

-- ---------------------------------------------------------------------
-- Casos de teste
-- ---------------------------------------------------------------------
create or replace function ai.save_eval_case(p jsonb) returns ai.eval_cases
language plpgsql security definer set search_path = '' as $$
declare
  c ai.eval_cases; v_turns jsonb := p -> 'turns'; v_exp jsonb := coalesce(p -> 'expect', '{}'); t jsonb; i int := 0; n int; rx text; v_key text := lower(trim(coalesce(p ->> 'key', '')));
  v_tools text[] := array['search_catalog', 'check_stock_by_size', 'get_customer_360', 'get_order_status', 'get_policies', 'search_knowledge', 'apply_coupon', 'create_reservation',
                          'schedule_locker', 'create_order_draft', 'confirm_order_draft', 'create_payment_link', 'register_consent', 'update_customer_profile', 'remember_customer_fact', 'request_handoff'];
  k text; x text;
begin
  perform private.require_perm('ai.write');
  if v_key !~ '^[a-z0-9][a-z0-9_-]{1,59}$' then raise exception 'A chave usa letras minúsculas, números, - ou _ (2 a 60 caracteres)' using errcode = 'P0241'; end if;
  if length(trim(coalesce(p ->> 'title', ''))) not between 3 and 140 then raise exception 'O título tem de 3 a 140 caracteres' using errcode = 'P0241'; end if;
  if jsonb_typeof(v_turns) <> 'array' or jsonb_array_length(v_turns) not between 1 and 12 then raise exception 'A conversa tem de 1 a 12 falas' using errcode = 'P0241'; end if;
  n := jsonb_array_length(v_turns);
  for t in select * from jsonb_array_elements(v_turns) loop
    i := i + 1;
    if t ->> 'role' not in ('user', 'assistant') or length(trim(coalesce(t ->> 'text', ''))) not between 1 and 500 then raise exception 'Cada fala precisa de quem falou (cliente ou IA) e de 1 a 500 caracteres' using errcode = 'P0241'; end if;
    if i = n and t ->> 'role' <> 'user' then raise exception 'A última fala tem de ser da cliente' using errcode = 'P0241'; end if;
  end loop;
  for k in select jsonb_object_keys(v_exp) loop
    if k not in ('outcome_in', 'tools_any', 'tools_none', 'must_match_any', 'must_not_match', 'no_flags') then raise exception 'Expectativa desconhecida: %', k using errcode = 'P0241'; end if;
  end loop;
  if v_exp ? 'outcome_in' then
    for x in select jsonb_array_elements_text(v_exp -> 'outcome_in') loop
      if x not in ('SEND', 'DRAFT', 'HANDOFF') then raise exception 'Resultado esperado inválido: %', x using errcode = 'P0241'; end if;
    end loop;
  end if;
  for k in select unnest(array['tools_any', 'tools_none']) loop
    if v_exp ? k then
      for x in select jsonb_array_elements_text(v_exp -> k) loop
        if not x = any (v_tools) then raise exception 'Ferramenta desconhecida: %', x using errcode = 'P0241'; end if;
      end loop;
    end if;
  end loop;
  for k in select unnest(array['must_match_any', 'must_not_match']) loop
    if v_exp ? k then
      for rx in select jsonb_array_elements_text(v_exp -> k) loop
        begin
          perform '' ~* rx;
        exception when others then
          raise exception 'Expressão inválida em %: %', k, rx using errcode = 'P0241';
        end;
      end loop;
    end if;
  end loop;
  insert into ai.eval_cases (org_id, suite, key, title, turns, expect, active)
  values (private.org_id(), 'conversation', v_key, trim(p ->> 'title'), v_turns, v_exp, coalesce((p ->> 'active')::boolean, true))
  on conflict (org_id, suite, key) do update set title = excluded.title, turns = excluded.turns, expect = excluded.expect, active = excluded.active
  returning * into c;
  return c;
end $$;

create or replace function ai.delete_eval_case(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('ai.write');
  delete from ai.eval_cases where id = p_id and org_id = private.org_id();
  if not found then raise exception 'Caso não encontrado' using errcode = 'P0243'; end if;
end $$;

-- ---------------------------------------------------------------------
-- Pedido de avaliação (o worker executa; uma por vez na organização)
-- ---------------------------------------------------------------------
create or replace function ai.request_eval(p_models text[]) returns ai.eval_requests
language plpgsql security definer set search_path = '' as $$
declare r ai.eval_requests; m text; v_models text[] := '{}';
begin
  perform private.require_perm('ai.write');
  foreach m in array coalesce(p_models, '{}') loop
    m := trim(m);
    if m !~ '^[A-Za-z0-9._:/-]{3,100}$' then raise exception 'Modelo inválido: %', m using errcode = 'P0241'; end if;
    if not m = any (v_models) then v_models := v_models || m; end if;
  end loop;
  if coalesce(array_length(v_models, 1), 0) not between 1 and 4 then raise exception 'Escolha de 1 a 4 modelos' using errcode = 'P0241'; end if;
  if (select count(*) from ai.eval_cases where org_id = private.org_id() and active) < 3 then raise exception 'Cadastre pelo menos 3 casos de teste ativos' using errcode = 'P0242'; end if;
  if exists (select 1 from ai.eval_requests where org_id = private.org_id() and status in ('QUEUED', 'RUNNING') and requested_at > now() - interval '2 hours') then
    raise exception 'Já existe uma avaliação em andamento: espere terminar' using errcode = 'P0242';
  end if;
  insert into ai.eval_requests (org_id, models, requested_by) values (private.org_id(), v_models, private.member_id()) returning * into r;
  perform private.enqueue('ai_tasks', jsonb_build_object('action', 'EVAL_RUN', 'org_id', r.org_id, 'request_id', r.id, 'suite', r.suite, 'models', to_jsonb(r.models)));
  return r;
end $$;

create or replace function ai.eval_mark(p_request uuid, p_status text, p_error text default null, p_progress text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r ai.eval_requests;
begin
  update ai.eval_requests set status = p_status, error = p_error, progress = p_progress, finished_at = case when p_status in ('DONE', 'FAILED') then now() else finished_at end
  where id = p_request returning * into r;
  if r.id is not null and p_status in ('DONE', 'FAILED') then
    perform core.notify(r.org_id, 'EVAL', case when p_status = 'DONE' then 'Avaliação dos modelos concluída' else 'A avaliação dos modelos falhou' end,
                        jsonb_build_object('request_id', r.id), 'ai.write', r.requested_by);
  end if;
end $$;

-- O worker grava um lote por modelo; os totais são calculados aqui, a partir dos resultados por caso
create or replace function ai.eval_save_batch(p_org uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; r jsonb; v_lat int[];
begin
  insert into ai.eval_batches (org_id, request_id, suite, route_task, model) values (p_org, nullif(p ->> 'request_id', '')::uuid, coalesce(p ->> 'suite', 'conversation'), coalesce(p ->> 'route_task', 'conversation'), p ->> 'model')
  returning id into v_id;
  for r in select * from jsonb_array_elements(coalesce(p -> 'results', '[]')) loop
    insert into ai.eval_results (org_id, batch_id, case_id, case_key, passed, failures, outcome, flags, replies, tools, latency_ms, cost_usd, tokens_in, tokens_out, error)
    values (p_org, v_id, (select id from ai.eval_cases where org_id = p_org and suite = coalesce(p ->> 'suite', 'conversation') and key = r ->> 'case_key'), r ->> 'case_key', coalesce((r ->> 'passed')::boolean, false),
            coalesce(r -> 'failures', '[]'), r ->> 'outcome', coalesce(r -> 'flags', '[]'), coalesce(r -> 'replies', '[]'), coalesce(r -> 'tools', '[]'), (r ->> 'latency_ms')::int,
            coalesce((r ->> 'cost_usd')::numeric, 0), coalesce((r ->> 'tokens_in')::int, 0), coalesce((r ->> 'tokens_out')::int, 0), r ->> 'error');
  end loop;
  select array_agg(latency_ms order by latency_ms) into v_lat from ai.eval_results where batch_id = v_id and latency_ms is not null;
  update ai.eval_batches b set
    cases = (select count(*) from ai.eval_results where batch_id = v_id),
    passed = (select count(*) from ai.eval_results where batch_id = v_id and passed),
    factual_failures = (select count(*) from ai.eval_results x where x.batch_id = v_id and x.flags ?| array['UNGROUNDED_PRICE', 'UNGROUNDED_INSTALLMENT', 'UNGROUNDED_STOCK', 'DISCOUNT_NOT_ALLOWED', 'PII']),
    handoff_misses = (select count(*) from ai.eval_results x join ai.eval_cases c on c.id = x.case_id where x.batch_id = v_id and c.expect -> 'outcome_in' = '["HANDOFF"]'::jsonb and x.outcome is distinct from 'HANDOFF'),
    avg_latency_ms = (select avg(latency_ms)::int from ai.eval_results where batch_id = v_id),
    p95_latency_ms = case when v_lat is null then null else v_lat[greatest(1, ceil(array_length(v_lat, 1) * 0.95)::int)] end,
    cost_usd = (select coalesce(sum(cost_usd), 0) from ai.eval_results where batch_id = v_id),
    tokens_in = (select coalesce(sum(tokens_in), 0) from ai.eval_results where batch_id = v_id),
    tokens_out = (select coalesce(sum(tokens_out), 0) from ai.eval_results where batch_id = v_id)
  where b.id = v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Portão: o modelo só entra na rota de atendimento se passou na avaliação recente
-- (configurável em core.settings 'ai_eval_gate': min_cases, min_pass_rate, max_factual_failures, max_age_days, gated_tasks, enforce)
-- ---------------------------------------------------------------------
create or replace function private.eval_gate(p_org uuid, p_task text, p_model text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s jsonb; b ai.eval_batches; v_min_cases int; v_min_rate numeric; v_max_fact int; v_days int;
begin
  select value into s from core.settings where org_id = p_org and key = 'ai_eval_gate';
  s := coalesce(s, '{}');
  v_min_cases := coalesce((s ->> 'min_cases')::int, 8); v_min_rate := coalesce((s ->> 'min_pass_rate')::numeric, 0.9);
  v_max_fact := coalesce((s ->> 'max_factual_failures')::int, 0); v_days := coalesce((s ->> 'max_age_days')::int, 30);
  select * into b from ai.eval_batches where org_id = p_org and route_task = p_task and model = p_model and created_at > now() - make_interval(days => v_days) order by created_at desc limit 1;
  if b.id is null then return jsonb_build_object('ok', false, 'reason', format('rode a avaliação com este modelo (vale por %s dias)', v_days)); end if;
  if b.cases < v_min_cases then return jsonb_build_object('ok', false, 'reason', format('a última avaliação teve só %s casos (mínimo %s)', b.cases, v_min_cases), 'batch_id', b.id); end if;
  if b.factual_failures > v_max_fact then return jsonb_build_object('ok', false, 'reason', format('%s resposta(s) com número ou promessa sem fundamento (o limite é %s)', b.factual_failures, v_max_fact), 'batch_id', b.id); end if;
  if b.passed::numeric / b.cases < v_min_rate then return jsonb_build_object('ok', false, 'reason', format('passou em %s de %s casos (mínimo %s%%)', b.passed, b.cases, round(v_min_rate * 100)), 'batch_id', b.id); end if;
  return jsonb_build_object('ok', true, 'batch_id', b.id);
end $$;

create or replace function ai.eval_gate_check(p_task text, p_model text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('ai.read');
  return private.eval_gate(private.org_id(), p_task, p_model);
end $$;

create or replace function private.enforce_eval_gate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s jsonb; g jsonb;
begin
  if new.primary_model is distinct from old.primary_model and coalesce(auth.role(), '') = 'authenticated' then
    select value into s from core.settings where org_id = new.org_id and key = 'ai_eval_gate';
    s := coalesce(s, '{}');
    if coalesce((s ->> 'enforce')::boolean, true) and new.task = any (array(select jsonb_array_elements_text(coalesce(s -> 'gated_tasks', '["conversation"]'::jsonb)))) then
      g := private.eval_gate(new.org_id, new.task, new.primary_model);
      if not (g ->> 'ok')::boolean then
        raise exception 'O modelo % ainda não pode atender clientes: %', new.primary_model, g ->> 'reason' using errcode = 'P0240';
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger trg_enforce_eval_gate before update of primary_model on ai.model_routes for each row execute function private.enforce_eval_gate();

-- ---------------------------------------------------------------------
-- Ranking: o último lote de cada modelo na rota
-- ---------------------------------------------------------------------
create or replace function ai.eval_ranking(p_task text default 'conversation') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('ai.read');
  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.pass_rate desc, x.factual_failures, x.cost_per_case, x.p95_latency_ms) from (
      select distinct on (b.model) b.id as batch_id, b.model, b.created_at, b.cases, b.passed, b.factual_failures, b.handoff_misses, b.avg_latency_ms, b.p95_latency_ms, b.cost_usd,
             case when b.cases > 0 then round(b.passed::numeric / b.cases, 3) else 0 end as pass_rate,
             case when b.cases > 0 then round(b.cost_usd / b.cases, 6) else 0 end as cost_per_case,
             (private.eval_gate(b.org_id, b.route_task, b.model) ->> 'ok')::boolean as gate_ok,
             (select primary_model = b.model from ai.model_routes r where r.org_id = b.org_id and r.task = b.route_task) as in_use
      from ai.eval_batches b where b.org_id = private.org_id() and b.route_task = p_task order by b.model, b.created_at desc) x), '[]'::jsonb);
end $$;

insert into private.internal_functions (fqname) values ('ai.eval_mark'), ('ai.eval_save_batch'), ('private.eval_gate'), ('private.enforce_eval_gate'), ('private.conversation_for_update') on conflict do nothing;
select private.lock_functions();
