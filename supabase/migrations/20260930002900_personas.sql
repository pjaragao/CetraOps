-- =====================================================================
-- Inteligência › Personas: corpus de conversas (pseudonimizado), pares de estilo com embeddings, versões da persona e aprovação.
-- Fluxo: envio do histórico (WhatsApp .txt / Instagram .json) → worker trata (pseudonimiza, separa diálogos, monta pares) e APAGA o arquivo bruto →
-- IA classifica o que é conversa comercial → sócio revisa → worker gera o perfil de estilo (rascunho de persona) → sócio edita e aprova.
-- Depois de ativa, a persona vai no prompt e os melhores pares (por similaridade) entram como exemplos de ESTILO; respostas aprovadas/editadas na inbox viram pares novos.
-- Códigos de erro: P0140 dado inválido · P0141 situação não permite · P0142 não encontrado.
-- =====================================================================

do $$
begin
  perform pgmq.create('persona_tasks');
  perform pgmq.create('persona_tasks_dlq');
end $$;

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------
create table ai.corpus_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  persona_id uuid not null references ai.personas(id) on delete cascade,
  kind text not null check (kind in ('WA_TXT', 'IG_JSON')),
  filename text,
  owner_name text not null,                                     -- como o sócio aparece dentro do arquivo
  status text not null default 'UPLOADED' check (status in ('UPLOADED', 'PROCESSING', 'READY', 'FAILED')),
  bytes integer,
  stats jsonb not null default '{}',
  error text,
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  raw_deleted_at timestamptz
);
create index corpus_sources_persona_idx on ai.corpus_sources (persona_id, created_at desc);

-- Arquivo bruto: existe só até o worker processar (LGPD). Ninguém além do worker lê.
create table ai.corpus_raw (
  source_id uuid primary key references ai.corpus_sources(id) on delete cascade,
  content text not null
);
alter table ai.corpus_raw enable row level security;
revoke all on ai.corpus_raw from authenticated, anon;

create table ai.corpus_dialogues (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  persona_id uuid not null references ai.personas(id) on delete cascade,
  source_id uuid not null references ai.corpus_sources(id) on delete cascade,
  digest text not null,
  turns jsonb not null,                                          -- [{role: customer|owner, text}] já pseudonimizado
  commercial boolean,                                            -- null = ainda não classificado
  topics text[] not null default '{}',
  outcome text check (outcome in ('VENDA', 'SEM_VENDA', 'INDEFINIDO')),
  include boolean not null default true,
  classified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (persona_id, digest)
);
create index corpus_dialogues_source_idx on ai.corpus_dialogues (source_id);
create index corpus_dialogues_persona_idx on ai.corpus_dialogues (persona_id) where include;

create table ai.corpus_pairs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  persona_id uuid not null references ai.personas(id) on delete cascade,
  dialogue_id uuid references ai.corpus_dialogues(id) on delete cascade,
  position integer,                                              -- índice do turno de resposta no diálogo
  message_id uuid references omni.messages(id) on delete set null,   -- pares vindos da inbox
  source text not null check (source in ('HISTORICAL', 'APPROVED_DRAFT', 'HUMAN_EDIT', 'HUMAN_LIVE')),
  context jsonb not null,                                        -- [{role, text}] termina num turno da cliente
  reply jsonb not null,                                          -- [bolhas]
  intent text check (length(intent) <= 40),
  stage text check (length(stage) <= 40),
  weight numeric(4, 2) not null default 1,
  embedding halfvec(1024),
  embedding_model text,
  created_at timestamptz not null default now()
);
create unique index corpus_pairs_dialogue_pos_uq on ai.corpus_pairs (dialogue_id, position) where dialogue_id is not null;
create unique index corpus_pairs_message_uq on ai.corpus_pairs (persona_id, message_id) where message_id is not null;
create index corpus_pairs_persona_idx on ai.corpus_pairs (persona_id);
create index corpus_pairs_todo_idx on ai.corpus_pairs (persona_id) where embedding is null;
create index corpus_pairs_embedding_idx on ai.corpus_pairs using hnsw (embedding halfvec_cosine_ops);

select private.apply_rls('ai', array['corpus_sources', 'corpus_dialogues', 'corpus_pairs'], 'ai.write', 'ai.write');
select private.rpc_only('ai', array['corpus_sources', 'corpus_dialogues', 'corpus_pairs']);
drop trigger if exists trg_audit on ai.persona_versions;
create trigger trg_audit after insert or update or delete on ai.persona_versions for each row execute function private.audit_capture();
drop trigger if exists trg_audit on ai.corpus_sources;
create trigger trg_audit after insert or update or delete on ai.corpus_sources for each row execute function private.audit_capture();

-- ---------------------------------------------------------------------
-- 1) Personas
-- ---------------------------------------------------------------------
create or replace function ai.save_persona(p jsonb) returns ai.personas
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_name text := trim(coalesce(p ->> 'name', '')); v_member uuid := nullif(p ->> 'member_id', '')::uuid; r ai.personas;
begin
  perform private.require_perm('ai.write');
  if length(v_name) not between 2 and 60 then raise exception 'O nome da persona tem de 2 a 60 caracteres' using errcode = 'P0140'; end if;
  if v_member is not null and not exists (select 1 from core.members where id = v_member and org_id = v_org) then raise exception 'Pessoa da equipe inválida' using errcode = 'P0140'; end if;
  if v_id is null then
    insert into ai.personas (org_id, name, member_id) values (v_org, v_name, v_member) returning * into r;
  else
    update ai.personas set name = v_name, member_id = v_member where id = v_id and org_id = v_org returning * into r;
    if r.id is null then raise exception 'Persona não encontrada' using errcode = 'P0142'; end if;
  end if;
  return r;
exception when unique_violation then
  raise exception 'Já existe uma persona com esse nome' using errcode = 'P0140';
end $$;

-- ---------------------------------------------------------------------
-- 2) Histórico (corpus): enviar, apagar, revisar
-- p = {persona_id, kind: WA_TXT|IG_JSON, owner_name, filename?, content}
-- (Instagram: content = JSON com a lista dos textos de cada message_N.json)
-- ---------------------------------------------------------------------
create or replace function ai.create_corpus_source(p jsonb) returns ai.corpus_sources
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_persona uuid := nullif(p ->> 'persona_id', '')::uuid; v_kind text := upper(trim(coalesce(p ->> 'kind', '')));
  v_owner text := trim(coalesce(p ->> 'owner_name', '')); v_content text := p ->> 'content'; s ai.corpus_sources;
begin
  perform private.require_perm('ai.write');
  if not exists (select 1 from ai.personas where id = v_persona and org_id = v_org) then raise exception 'Persona não encontrada' using errcode = 'P0142'; end if;
  if v_kind not in ('WA_TXT', 'IG_JSON') then raise exception 'Tipo de histórico inválido' using errcode = 'P0140'; end if;
  if length(v_owner) not between 1 and 80 then raise exception 'Informe como o sócio aparece no arquivo (o nome nas mensagens)' using errcode = 'P0140'; end if;
  if v_content is null or length(v_content) < 20 then raise exception 'O arquivo está vazio' using errcode = 'P0140'; end if;
  if length(v_content) > 25000000 then raise exception 'O arquivo passa de 25 MB: divida o histórico em partes' using errcode = 'P0140'; end if;
  insert into ai.corpus_sources (org_id, persona_id, kind, filename, owner_name, bytes, created_by)
  values (v_org, v_persona, v_kind, left(nullif(trim(coalesce(p ->> 'filename', '')), ''), 200), v_owner, octet_length(v_content), private.member_id()) returning * into s;
  insert into ai.corpus_raw (source_id, content) values (s.id, v_content);
  perform private.enqueue('persona_tasks', jsonb_build_object('action', 'PROCESS', 'source_id', s.id, 'org_id', v_org));
  return s;
end $$;

-- Apagar um histórico leva junto os diálogos e pares que vieram dele
create or replace function ai.delete_corpus_source(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('ai.write');
  delete from ai.corpus_sources where id = p_id and org_id = private.org_id();
  if not found then raise exception 'Histórico não encontrado' using errcode = 'P0142'; end if;
end $$;

-- Tira (ou devolve) diálogos da persona: conversa pessoal/familiar não serve de exemplo
create or replace function ai.set_dialogues_included(p_ids uuid[], p_include boolean) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform private.require_perm('ai.write');
  update ai.corpus_dialogues set include = p_include where id = any (p_ids) and org_id = private.org_id();
  get diagnostics n = row_count;
  return n;
end $$;

-- Pede ao worker: CLASSIFY (marca o que é conversa comercial) ou EMBED (indexa os pares para busca por similaridade)
create or replace function ai.request_corpus_task(p_persona uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id();
begin
  perform private.require_perm('ai.write');
  if not exists (select 1 from ai.personas where id = p_persona and org_id = v_org) then raise exception 'Persona não encontrada' using errcode = 'P0142'; end if;
  if p_action = 'CLASSIFY' then
    if not exists (select 1 from ai.corpus_dialogues where persona_id = p_persona and classified_at is null) then raise exception 'Não há diálogos novos para classificar' using errcode = 'P0141'; end if;
  elsif p_action = 'EMBED' then
    if not exists (select 1 from ai.corpus_pairs where persona_id = p_persona and embedding is null) then raise exception 'Todos os exemplos já estão indexados' using errcode = 'P0141'; end if;
  else
    raise exception 'Ação inválida' using errcode = 'P0140';
  end if;
  perform private.enqueue('persona_tasks', jsonb_build_object('action', p_action, 'persona_id', p_persona, 'org_id', v_org));
end $$;

-- Gera o rascunho do perfil de estilo (estatísticas + IA). Precisa de um mínimo de diálogos aproveitáveis.
create or replace function ai.request_persona_profile(p_persona uuid, p_lexicon text[] default '{}') returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); n integer;
begin
  perform private.require_perm('ai.write');
  if not exists (select 1 from ai.personas where id = p_persona and org_id = v_org) then raise exception 'Persona não encontrada' using errcode = 'P0142'; end if;
  select count(*) into n from ai.corpus_dialogues where persona_id = p_persona and include and commercial is not false;
  if n < 10 then raise exception 'Só há % diálogos aproveitáveis: envie mais histórico (o ideal é ter 300 ou mais)', n using errcode = 'P0141'; end if;
  perform private.enqueue('persona_tasks', jsonb_build_object('action', 'PROFILE', 'persona_id', p_persona, 'org_id', v_org,
                                                                'lexicon', to_jsonb(coalesce(p_lexicon, '{}'))));
end $$;

-- ---------------------------------------------------------------------
-- 3) Versões: editar rascunho, aprovar e ativar
-- p = {persona_id} cria uma versão em branco; p = {id, system_prompt, guardrails?} edita uma versão ainda não aprovada
-- ---------------------------------------------------------------------
create or replace function ai.save_persona_version(p jsonb) returns ai.persona_versions
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_persona uuid := nullif(p ->> 'persona_id', '')::uuid; r ai.persona_versions;
  v_prompt text := nullif(trim(coalesce(p ->> 'system_prompt', '')), '');
begin
  perform private.require_perm('ai.write');
  if v_prompt is not null and length(v_prompt) > 12000 then raise exception 'O prompt da persona passa de 12.000 caracteres' using errcode = 'P0140'; end if;
  if p ? 'guardrails' and jsonb_typeof(p -> 'guardrails') <> 'object' then raise exception 'Regras extras inválidas' using errcode = 'P0140'; end if;
  if v_id is null then
    if not exists (select 1 from ai.personas where id = v_persona and org_id = v_org) then raise exception 'Persona não encontrada' using errcode = 'P0142'; end if;
    insert into ai.persona_versions (org_id, persona_id, version, system_prompt, guardrails)
    values (v_org, v_persona, coalesce((select max(version) from ai.persona_versions where persona_id = v_persona), 0) + 1, v_prompt, coalesce(p -> 'guardrails', '{}')) returning * into r;
  else
    select * into r from ai.persona_versions where id = v_id and org_id = v_org for update;
    if r.id is null then raise exception 'Versão não encontrada' using errcode = 'P0142'; end if;
    if r.approved_at is not null then raise exception 'Versão já aprovada não muda: crie uma nova versão' using errcode = 'P0141'; end if;
    update ai.persona_versions set system_prompt = v_prompt, guardrails = coalesce(p -> 'guardrails', guardrails) where id = v_id returning * into r;
  end if;
  return r;
end $$;

create or replace function ai.approve_persona_version(p_id uuid) returns ai.personas
language plpgsql security definer set search_path = '' as $$
declare v ai.persona_versions; r ai.personas;
begin
  perform private.require_perm('ai.write');
  select * into v from ai.persona_versions where id = p_id and org_id = private.org_id() for update;
  if v.id is null then raise exception 'Versão não encontrada' using errcode = 'P0142'; end if;
  if coalesce(trim(v.system_prompt), '') = '' then raise exception 'Escreva o prompt da persona antes de aprovar' using errcode = 'P0141'; end if;
  update ai.persona_versions set approved_by = coalesce(approved_by, private.member_id()), approved_at = coalesce(approved_at, now()) where id = p_id;
  update ai.personas set active_version_id = p_id where id = v.persona_id returning * into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- 4) Funções do worker (internas)
-- ---------------------------------------------------------------------
-- p = {source_id, stats, dialogues: [{digest, turns: [{role, text}], pairs: [{position, context, reply}]}]}
create or replace function ai.corpus_ingest(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s ai.corpus_sources; d jsonb; pr jsonb; v_id uuid; v_new int := 0; v_dup int := 0; v_pairs int := 0;
begin
  select * into s from ai.corpus_sources where id = (p ->> 'source_id')::uuid for update;
  if s.id is null then raise exception 'Histórico não encontrado' using errcode = 'P0142'; end if;
  for d in select * from jsonb_array_elements(coalesce(p -> 'dialogues', '[]')) loop
    insert into ai.corpus_dialogues (org_id, persona_id, source_id, digest, turns) values (s.org_id, s.persona_id, s.id, d ->> 'digest', d -> 'turns')
    on conflict (persona_id, digest) do nothing returning id into v_id;
    if v_id is null then
      v_dup := v_dup + 1;
    else
      v_new := v_new + 1;
      for pr in select * from jsonb_array_elements(coalesce(d -> 'pairs', '[]')) loop
        insert into ai.corpus_pairs (org_id, persona_id, dialogue_id, position, source, context, reply)
        values (s.org_id, s.persona_id, v_id, (pr ->> 'position')::int, 'HISTORICAL', pr -> 'context', pr -> 'reply');
        v_pairs := v_pairs + 1;
      end loop;
    end if;
    v_id := null;
  end loop;
  update ai.corpus_sources set status = 'READY', processed_at = now(), error = null, raw_deleted_at = now(),
         stats = coalesce(p -> 'stats', '{}') || jsonb_build_object('imported_dialogues', v_new, 'duplicate_dialogues', v_dup, 'imported_pairs', v_pairs)
  where id = s.id;
  delete from ai.corpus_raw where source_id = s.id;
  return jsonb_build_object('dialogues', v_new, 'duplicates', v_dup, 'pairs', v_pairs);
end $$;

create or replace function ai.corpus_fail(p_source uuid, p_error text) returns void
language sql security definer set search_path = '' as $$
  with u as (update ai.corpus_sources set status = 'FAILED', error = left(p_error, 500), processed_at = now(), raw_deleted_at = now() where id = p_source returning id)
  delete from ai.corpus_raw where source_id in (select id from u)
$$;

create or replace function ai.corpus_mark_processing(p_source uuid) returns void
language sql security definer set search_path = '' as $$
  update ai.corpus_sources set status = 'PROCESSING' where id = p_source and status = 'UPLOADED'
$$;

-- p = {items: [{dialogue_id, commercial, topics?, outcome?, pairs?: [{position, intent, stage}]}]}
create or replace function ai.corpus_labels(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare it jsonb; pr jsonb; n int := 0;
begin
  for it in select * from jsonb_array_elements(coalesce(p -> 'items', '[]')) loop
    update ai.corpus_dialogues set commercial = (it ->> 'commercial')::boolean, classified_at = now(),
           topics = coalesce(array(select jsonb_array_elements_text(coalesce(it -> 'topics', '[]'))), '{}'),
           outcome = coalesce(nullif(it ->> 'outcome', ''), outcome),
           include = case when (it ->> 'commercial')::boolean is false then false else include end       -- conversa pessoal sai da persona (o sócio pode devolver)
    where id = (it ->> 'dialogue_id')::uuid;
    if found then n := n + 1; end if;
    for pr in select * from jsonb_array_elements(coalesce(it -> 'pairs', '[]')) loop
      update ai.corpus_pairs set intent = left(pr ->> 'intent', 40), stage = left(pr ->> 'stage', 40)
      where dialogue_id = (it ->> 'dialogue_id')::uuid and position = (pr ->> 'position')::int;
    end loop;
  end loop;
  return n;
end $$;

-- p = {model, items: [{pair_id, embedding: "[0.1,...]"}]}
create or replace function ai.corpus_embeddings(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare it jsonb; n int := 0;
begin
  for it in select * from jsonb_array_elements(coalesce(p -> 'items', '[]')) loop
    update ai.corpus_pairs set embedding = (it ->> 'embedding')::extensions.halfvec(1024), embedding_model = p ->> 'model' where id = (it ->> 'pair_id')::uuid;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Par vindo da inbox (rascunho aprovado, editado ou resposta humana). Mantém o de maior peso se o mesmo envio chegar duas vezes.
-- p = {org_id, persona_id, message_id, source, context, reply, weight, intent?, stage?, embedding?, model?}
create or replace function ai.corpus_add_live_pair(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into ai.corpus_pairs (org_id, persona_id, message_id, source, context, reply, weight, intent, stage, embedding, embedding_model)
  values ((p ->> 'org_id')::uuid, (p ->> 'persona_id')::uuid, (p ->> 'message_id')::uuid, p ->> 'source', p -> 'context', p -> 'reply',
          coalesce((p ->> 'weight')::numeric, 1), left(p ->> 'intent', 40), left(p ->> 'stage', 40), (p ->> 'embedding')::extensions.halfvec(1024), p ->> 'model')
  on conflict (persona_id, message_id) where message_id is not null do update
    set source = excluded.source, weight = excluded.weight, reply = excluded.reply, context = excluded.context,
        intent = coalesce(excluded.intent, ai.corpus_pairs.intent), stage = coalesce(excluded.stage, ai.corpus_pairs.stage),
        embedding = coalesce(excluded.embedding, ai.corpus_pairs.embedding), embedding_model = coalesce(excluded.embedding_model, ai.corpus_pairs.embedding_model)
    where excluded.weight > ai.corpus_pairs.weight
  returning id into v_id;
  return v_id;
end $$;

-- Versão gerada pelo worker (sempre rascunho: só o sócio aprova)
-- p = {persona_id, style_profile, system_prompt, guardrails?}
create or replace function ai.persona_new_version(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_persona uuid := (p ->> 'persona_id')::uuid; v_id uuid; v_org uuid;
begin
  select org_id into v_org from ai.personas where id = v_persona for update;
  if v_org is null then raise exception 'Persona não encontrada' using errcode = 'P0142'; end if;
  insert into ai.persona_versions (org_id, persona_id, version, style_profile, system_prompt, guardrails)
  values (v_org, v_persona, coalesce((select max(version) from ai.persona_versions where persona_id = v_persona), 0) + 1,
          coalesce(p -> 'style_profile', '{}'), p ->> 'system_prompt', coalesce(p -> 'guardrails', '{}'))
  returning id into v_id;
  return v_id;
end $$;

-- Exemplos de estilo mais parecidos com a mensagem da cliente (o worker aplica a diversidade/MMR).
create or replace function ai.similar_pairs(p_persona uuid, p_embedding text, p_k integer default 20, p_stage text default null)
returns table (id uuid, context jsonb, reply jsonb, intent text, stage text, source text, weight numeric, distance double precision, embedding real[])
language sql stable security definer set search_path = '' as $$
  with q as (select p_embedding::extensions.halfvec(1024) as v)
  select cp.id, cp.context, cp.reply, cp.intent, cp.stage, cp.source, cp.weight, (cp.embedding OPERATOR(extensions.<=>) q.v)::double precision as distance, cp.embedding::real[]
  from ai.corpus_pairs cp cross join q
  left join ai.corpus_dialogues d on d.id = cp.dialogue_id
  where cp.persona_id = p_persona and cp.embedding is not null
    and (cp.dialogue_id is null or (d.include and d.commercial is not false))
    and (p_stage is null or cp.stage = p_stage)
  order by cp.embedding OPERATOR(extensions.<=>) q.v
  limit greatest(1, least(p_k, 50))
$$;

-- ---------------------------------------------------------------------
-- 5) Aprendizado contínuo: rascunho usado/editado e resposta humana viram tarefas para o worker
-- ---------------------------------------------------------------------
create or replace function ai.on_draft_decided() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('SENT', 'EDITED_SENT') and old.status is distinct from new.status then
    perform pgmq.send('persona_tasks', jsonb_build_object('action', 'LEARN', 'draft_id', new.id, 'org_id', new.org_id));
  end if;
  return new;
end $$;
drop trigger if exists trg_persona_learn on omni.message_drafts;
create trigger trg_persona_learn after update of status on omni.message_drafts for each row execute function ai.on_draft_decided();

create or replace function ai.on_human_reply() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.direction = 'OUT' and new.author_type in ('HUMAN', 'ECHO_FROM_APP') and new.type = 'TEXT' and coalesce(trim(new.body), '') <> '' then
    perform pgmq.send('persona_tasks', jsonb_build_object('action', 'LEARN', 'message_id', new.id, 'org_id', new.org_id), 3);   -- 3 s: dá tempo de o rascunho ser marcado como usado
  end if;
  return new;
end $$;
drop trigger if exists trg_persona_learn on omni.messages;
create trigger trg_persona_learn after insert on omni.messages for each row execute function ai.on_human_reply();

insert into private.internal_functions (fqname) values
  ('ai.corpus_ingest'), ('ai.corpus_fail'), ('ai.corpus_mark_processing'), ('ai.corpus_labels'), ('ai.corpus_embeddings'), ('ai.corpus_add_live_pair'),
  ('ai.persona_new_version'), ('ai.similar_pairs'), ('ai.on_draft_decided'), ('ai.on_human_reply') on conflict do nothing;
select private.lock_functions();
