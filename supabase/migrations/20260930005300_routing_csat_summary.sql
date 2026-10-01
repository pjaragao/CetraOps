-- =====================================================================
-- Atendimento: distribuição automática, pesquisa de satisfação (CSAT) e resumo/temas da conversa (plano, Fase 2).
-- • Distribuição (core.settings 'routing'): quando a conversa passa a "Aguardando humano" sem responsável, vai para
--   1) a dona do relacionamento; 2) VIP/VIP Black → a sócia de plantão; 3) rodízio entre quem está na ESCALA agora
--   (Equipe › Escalas) com menos conversas abertas, respeitando o limite por pessoa; 4) a sócia de plantão.
-- • CSAT (core.settings 'csat'): ao encerrar com a janela aberta pergunta "de 1 a 5"; a resposta (só o número, em até 24 h)
--   é gravada sem acordar a IA; nota até 3 vira tarefa para a dona do relacionamento.
-- • Resumo: ao encerrar, a IA (rota summarize) resume em 2 linhas, marca temas e sentimento e aponta pergunta sem resposta
--   na base de conhecimento → Central de sugestões ("lacuna na base").
-- Códigos de erro: P0340 dado inválido · P0341 situação não permite · P0342 não encontrado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Distribuição automática
-- ---------------------------------------------------------------------
create or replace function private.routing_cfg(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('enabled', false, 'max_open_per_member', 15, 'on_call_member_id', null, 'use_roster', true)
         || coalesce((select value from core.settings where org_id = p_org and key = 'routing'), '{}')
$$;

create or replace function omni.save_routing_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); c jsonb; v_on uuid;
begin
  perform private.require_perm('core.admin');
  c := private.routing_cfg(v_org) || jsonb_strip_nulls(jsonb_build_object('enabled', (p ->> 'enabled')::boolean, 'max_open_per_member', (p ->> 'max_open_per_member')::int, 'use_roster', (p ->> 'use_roster')::boolean))
       || jsonb_build_object('on_call_member_id', nullif(p ->> 'on_call_member_id', ''));
  v_on := nullif(c ->> 'on_call_member_id', '')::uuid;
  if v_on is not null and not exists (select 1 from core.members where id = v_on and org_id = v_org and status = 'ACTIVE') then raise exception 'Plantão: pessoa inválida' using errcode = 'P0340'; end if;
  if (c ->> 'max_open_per_member')::int not between 1 and 100 then raise exception 'Limite por pessoa: 1 a 100' using errcode = 'P0340'; end if;
  insert into core.settings (org_id, key, value) values (v_org, 'routing', c) on conflict (org_id, key) do update set value = excluded.value;
  return c;
end $$;

-- Quem atende agora (escala publicada ou rascunho cobrindo este instante) e tem permissão de atendimento
create or replace function private.members_on_shift(p_org uuid, p_store uuid, p_at timestamptz default now()) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct e.member_id from hr.roster r join hr.employees e on e.id = r.employee_id
  where r.org_id = p_org and (p_store is null or r.store_id = p_store) and r.kind = 'WORK' and e.member_id is not null and e.status = 'ACTIVE'
    and r.work_date between (p_at at time zone 'America/Sao_Paulo')::date - 1 and (p_at at time zone 'America/Sao_Paulo')::date
    and ((r.work_date + r.start_time)::timestamp at time zone 'America/Sao_Paulo') <= p_at
    and p_at < ((r.work_date + r.end_time + case when r.end_time <= r.start_time then interval '1 day' else interval '0' end)::timestamp at time zone 'America/Sao_Paulo')
$$;

create or replace function private.member_can_attend(p_member uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core.members m join core.member_roles mr on mr.member_id = m.id join core.roles r on r.id = mr.role_id
                 left join core.role_permissions rp on rp.role_id = r.id and rp.permission_key = 'omni.write'
                 where m.id = p_member and m.status = 'ACTIVE' and (r.is_superuser or rp.role_id is not null))
$$;

create or replace function private.auto_assign(p_conversation uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cv omni.conversations; c jsonb; v_owner uuid; v_tier text; v_on uuid; v_pick uuid; v_store uuid; v_max int; v_name text;
begin
  select * into cv from omni.conversations where id = p_conversation;
  if cv.id is null or cv.assignee_member_id is not null then return cv.assignee_member_id; end if;
  c := private.routing_cfg(cv.org_id);
  if not coalesce((c ->> 'enabled')::boolean, false) then return null; end if;
  v_max := (c ->> 'max_open_per_member')::int; v_on := nullif(c ->> 'on_call_member_id', '')::uuid;
  select relationship_owner_member_id, tier::text, display_name into v_owner, v_tier, v_name from crm.parties where id = cv.party_id;
  select store_id into v_store from omni.channel_accounts where id = cv.channel_account_id;

  if v_owner is not null and private.member_can_attend(v_owner) then v_pick := v_owner;
  elsif v_tier in ('VIP', 'VIP_BLACK') and v_on is not null then v_pick := v_on;
  else
    select m.id into v_pick from core.members m
    where m.org_id = cv.org_id and m.status = 'ACTIVE' and private.member_can_attend(m.id)
      and (not coalesce((c ->> 'use_roster')::boolean, true) or not exists (select 1 from private.members_on_shift(cv.org_id, v_store))
           or m.id in (select private.members_on_shift(cv.org_id, v_store)))
      and (select count(*) from omni.conversations x where x.assignee_member_id = m.id and x.status <> 'CLOSED') < v_max
    order by (select count(*) from omni.conversations x where x.assignee_member_id = m.id and x.status <> 'CLOSED'),
             (select max(x.updated_at) from omni.conversations x where x.assignee_member_id = m.id) nulls first, m.id
    limit 1;
    v_pick := coalesce(v_pick, v_on);
  end if;
  if v_pick is null then return null; end if;
  update omni.conversations set assignee_member_id = v_pick where id = cv.id and assignee_member_id is null;
  perform private.timeline(cv.org_id, cv.party_id, 'ASSIGNED', 'omni.conversations', cv.id, 'Conversa distribuída automaticamente');
  perform core.notify(cv.org_id, 'ASSIGNED', 'Conversa atribuída a você: ' || coalesce(v_name, 'cliente'), jsonb_build_object('conversation_id', cv.id), null, v_pick);
  return v_pick;
end $$;

create or replace function private.auto_assign_on_wait() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mode = 'WAITING_HUMAN' and old.mode is distinct from 'WAITING_HUMAN' and new.assignee_member_id is null then
    begin
      perform private.auto_assign(new.id);
    exception when others then raise warning 'distribuição automática falhou: %', sqlerrm;
    end;
  end if;
  return null;
end $$;
create trigger trg_auto_assign_on_wait after update of mode on omni.conversations for each row execute function private.auto_assign_on_wait();

-- ---------------------------------------------------------------------
-- 2) CSAT
-- ---------------------------------------------------------------------
create table omni.csat_responses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  conversation_id uuid not null references omni.conversations(id) on delete cascade,   -- a conversa avaliada
  party_id uuid not null references crm.parties(id) on delete cascade,
  channel_account_id uuid not null references omni.channel_accounts(id),
  assignee_member_id uuid references core.members(id),
  asked_at timestamptz not null default now(),
  asked_message_id uuid references omni.messages(id) on delete set null,
  score smallint check (score between 1 and 5),
  answered_at timestamptz,
  unique (conversation_id)
);
create index csat_pending_idx on omni.csat_responses (party_id, channel_account_id) where score is null;
select private.apply_rls('omni', array['csat_responses'], 'omni.read', 'omni.write');
select private.rpc_only('omni', array['csat_responses']);

create or replace function private.csat_cfg(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('enabled', false, 'question', 'Antes de ir: de 1 a 5, como foi o seu atendimento? (5 = ótimo) Responda só com o número.', 'thanks', 'Obrigada pela nota! 💛')
         || coalesce((select value from core.settings where org_id = p_org and key = 'csat'), '{}')
$$;

create or replace function omni.save_csat_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); c jsonb;
begin
  perform private.require_perm('omni.write');
  c := private.csat_cfg(v_org) || jsonb_strip_nulls(jsonb_build_object('enabled', (p ->> 'enabled')::boolean, 'question', nullif(trim(p ->> 'question'), ''), 'thanks', nullif(trim(p ->> 'thanks'), '')));
  if length(c ->> 'question') > 300 or length(c ->> 'thanks') > 200 then raise exception 'Texto longo demais' using errcode = 'P0340'; end if;
  insert into core.settings (org_id, key, value) values (v_org, 'csat', c) on conflict (org_id, key) do update set value = excluded.value;
  return c;
end $$;

-- Ao encerrar por uma pessoa: pergunta a nota (se ligado e a janela estiver aberta); depois pede o resumo à IA
create or replace function private.after_close() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c jsonb; v_msg uuid;
begin
  if new.status = 'CLOSED' and old.status is distinct from 'CLOSED' then
    begin
      c := private.csat_cfg(new.org_id);
      if coalesce(new.outcome_source, '') = 'HUMAN' and coalesce((c ->> 'enabled')::boolean, false) and coalesce(new.outcome, '') not in ('SPAM', 'NOT_CUSTOMER')
         and not exists (select 1 from omni.csat_responses x where x.party_id = new.party_id and x.asked_at > now() - interval '7 days') then
        v_msg := omni.queue_system_message(new.id, c ->> 'question');
        if v_msg is not null then
          insert into omni.csat_responses (org_id, conversation_id, party_id, channel_account_id, assignee_member_id, asked_message_id)
          values (new.org_id, new.id, new.party_id, new.channel_account_id, new.assignee_member_id, v_msg);
        end if;
      end if;
      if exists (select 1 from omni.messages m where m.conversation_id = new.id and m.direction = 'IN') then
        perform private.enqueue('ai_tasks', jsonb_build_object('action', 'CONVERSATION_SUMMARY', 'org_id', new.org_id, 'conversation_id', new.id));
      end if;
    exception when others then raise warning 'pós-encerramento falhou: %', sqlerrm;
    end;
  end if;
  return null;
end $$;
create trigger trg_after_close after update of status on omni.conversations for each row execute function private.after_close();

-- Resposta da nota: mensagem que é só um número de 1 a 5, até 24 h depois da pergunta, no mesmo canal
create or replace function private.capture_csat() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_score int; x omni.csat_responses; v_party uuid; v_name text; c jsonb;
begin
  if new.direction <> 'IN' or new.author_type <> 'CUSTOMER' or coalesce(new.body, '') !~ '^\s*[1-5]\s*(⭐|estrelas?)?\s*$' then return null; end if;
  v_score := substring(new.body from '[1-5]')::int;
  select party_id into v_party from omni.conversations where id = new.conversation_id;
  select * into x from omni.csat_responses where party_id = v_party and channel_account_id = new.channel_account_id and score is null and asked_at > now() - interval '24 hours'
  order by asked_at desc limit 1;
  if x.id is null then return null; end if;
  update omni.csat_responses set score = v_score, answered_at = now() where id = x.id;
  update omni.messages set payload = payload || jsonb_build_object('automation_handled', true, 'csat_reply', true) where id = new.id;   -- a IA não responde a nota
  c := private.csat_cfg(new.org_id);
  perform omni.queue_system_message(new.conversation_id, c ->> 'thanks');
  update omni.conversations set status = 'CLOSED', outcome = 'RESOLVED', outcome_source = 'AUTO' where id = new.conversation_id and status <> 'CLOSED'
    and (select count(*) from omni.messages m where m.conversation_id = new.conversation_id and m.direction = 'IN') = 1;   -- conversa aberta só pela nota
  perform private.timeline(new.org_id, v_party, 'CSAT', 'omni.csat_responses', x.id, 'Nota do atendimento: ' || v_score || ' de 5');
  if v_score <= 3 then
    select display_name into v_name from crm.parties where id = v_party;
    insert into crm.tasks (org_id, party_id, assignee_member_id, type, title, body, due_at, source_rule)
    values (new.org_id, v_party, coalesce((select relationship_owner_member_id from crm.parties where id = v_party), x.assignee_member_id), 'RECOVERY',
            'Nota ' || v_score || ' no atendimento: falar com ' || split_part(v_name, ' ', 1), 'Entenda o que não foi bem e registre a solução.', now() + interval '24 hours', 'csat:' || x.id);
    perform core.notify(new.org_id, 'CSAT_LOW', 'Nota ' || v_score || ' no atendimento: ' || v_name, jsonb_build_object('party_id', v_party, 'conversation_id', x.conversation_id), 'omni.write', null);
  end if;
  return null;
end $$;
-- "zz": roda depois de trg_on_message (que atualiza a conversa), senão a conversa seria reaberta
create trigger trg_zz_capture_csat after insert on omni.messages for each row execute function private.capture_csat();

create or replace function omni.csat_summary(p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('asked', count(*), 'answered', count(score), 'avg', round(avg(score), 2), 'low', count(*) filter (where score <= 3),
                            'by_member', coalesce((select jsonb_agg(jsonb_build_object('member_id', y.m, 'n', y.n, 'avg', y.a)) from (
                              select assignee_member_id as m, count(score) as n, round(avg(score), 2) as a from omni.csat_responses
                              where org_id = private.org_id() and asked_at >= p_from and asked_at < p_to and score is not null and assignee_member_id is not null group by 1) y), '[]'))
  from omni.csat_responses where org_id = private.org_id() and (select private.has_perm('omni.read')) and asked_at >= p_from and asked_at < p_to
$$;

-- ---------------------------------------------------------------------
-- 3) Resumo e temas (gravado pelo worker)
-- ---------------------------------------------------------------------
alter table ai.suggestions drop constraint if exists suggestions_kind_check;
alter table ai.suggestions add constraint suggestions_kind_check check (kind in ('NBA', 'CATEGORIZATION', 'RECON_MATCH', 'SKU_MATCH', 'REORDER', 'ANOMALY', 'REACTIVATION', 'ALLOCATION', 'KB_GAP', 'CUSTOMER'));
alter table omni.conversations add column if not exists topics text[] not null default '{}';

create or replace function ai.save_conversation_summary(p_conversation uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare cv omni.conversations; v_sum text := left(trim(coalesce(p ->> 'summary', '')), 400); v_topics text[]; v_q text := left(trim(coalesce(p ->> 'unanswered_question', '')), 200);
begin
  select * into cv from omni.conversations where id = p_conversation;
  if cv.id is null then return; end if;
  v_topics := array(select distinct lower(regexp_replace(trim(t), '[^a-zA-Z0-9à-ú -]', '', 'g')) from jsonb_array_elements_text(coalesce(p -> 'topics', '[]')) t where length(trim(t)) between 2 and 30 limit 5);
  update omni.conversations set summary = coalesce(nullif(v_sum, ''), summary), topics = v_topics,
         sentiment = case when p ->> 'sentiment' in ('POSITIVE', 'NEUTRAL', 'NEGATIVE') then p ->> 'sentiment' else sentiment end
  where id = cv.id;
  if v_sum <> '' then
    perform private.timeline(cv.org_id, cv.party_id, 'CONVERSATION_SUMMARY', 'omni.conversations', cv.id, v_sum, jsonb_build_object('topics', v_topics, 'sentiment', p ->> 'sentiment'));
  end if;
  if coalesce((p ->> 'knowledge_gap')::boolean, false) and length(v_q) >= 8 then
    perform private.open_suggestion(cv.org_id, 'KB_GAP', 'KB_GAP:' || md5(private.norm(v_q)), 'KB_GAP', 'LOW', 'Pergunta sem resposta na base: ' || left(v_q, 120),
      'Uma cliente perguntou isto e a base de conhecimento não tinha a resposta. Escreva e publique um texto para a IA (e a equipe) responderem da próxima vez.',
      '/ia/conhecimento/novo', 'omni.conversations', cv.id, jsonb_build_object('question', v_q));
  end if;
end $$;

-- Temas mais falados no período
create or replace function omni.topics_report(p_from timestamptz, p_to timestamptz) returns table (topic text, conversations int, negative int)
language sql stable security definer set search_path = '' as $$
  select t, count(*)::int, count(*) filter (where cv.sentiment = 'NEGATIVE')::int
  from omni.conversations cv, unnest(cv.topics) t
  where cv.org_id = private.org_id() and (select private.has_perm('omni.read')) and cv.closed_at >= p_from and cv.closed_at < p_to
  group by 1 order by 2 desc limit 30
$$;

insert into private.internal_functions (fqname) values
  ('private.routing_cfg'), ('private.members_on_shift'), ('private.member_can_attend'), ('private.auto_assign'), ('private.auto_assign_on_wait'),
  ('private.csat_cfg'), ('private.after_close'), ('private.capture_csat'), ('ai.save_conversation_summary')
on conflict do nothing;
select private.lock_functions();
