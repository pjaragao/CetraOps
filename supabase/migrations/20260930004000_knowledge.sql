-- =====================================================================
-- Inteligência › Base de conhecimento: o que a IA (e a equipe) consulta para responder sobre a marca, a loja, o cuidado com as peças, etc.
-- Documentos em Markdown, com rascunho separado do texto publicado (a IA só enxerga o publicado), versões guardadas e validade opcional.
-- A busca é feita no banco (texto completo em português, sem acento, com trechos de até ~700 caracteres); não há IA na recuperação:
-- o que ela responde vem de um trecho que uma pessoa publicou. Sem trecho, a IA transfere em vez de inventar.
-- Códigos de erro: P0230 dado inválido · P0231 situação não permite · P0232 não encontrado.
-- =====================================================================

create table ai.knowledge_docs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  title text not null check (length(title) between 3 and 120),
  kind text not null default 'FAQ' check (kind in ('POLICY', 'FAQ', 'PRODUCT_CARE', 'BRAND', 'EVENT', 'OTHER')),
  draft_md text not null default '',
  body_md text,                                                        -- texto publicado (o que a IA lê)
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  version integer not null default 0,
  valid_from date,
  valid_to date,
  published_at timestamptz,
  published_by uuid references core.members(id),
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);
create index on ai.knowledge_docs (org_id, status);

create table ai.knowledge_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  doc_id uuid not null references ai.knowledge_docs(id) on delete cascade,
  version integer not null,
  title text not null,
  body_md text not null,
  published_by uuid references core.members(id),
  published_at timestamptz not null default now(),
  unique (doc_id, version)
);

create table ai.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  doc_id uuid not null references ai.knowledge_docs(id) on delete cascade,
  position integer not null,
  content text not null,
  tsv tsvector not null default ''::tsvector,
  unique (doc_id, position)
);
create index knowledge_chunks_tsv_idx on ai.knowledge_chunks using gin (tsv);

create or replace function ai.set_chunk_tsv() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.tsv := to_tsvector('portuguese', private.norm(new.content));
  return new;
end $$;
create trigger trg_chunk_tsv before insert or update of content on ai.knowledge_chunks for each row execute function ai.set_chunk_tsv();

select private.attach_updated_at('ai');
select private.apply_rls('ai', array['knowledge_docs', 'knowledge_versions', 'knowledge_chunks'], 'ai.read', 'ai.write');
select private.rpc_only('ai', array['knowledge_docs', 'knowledge_versions', 'knowledge_chunks']);
create trigger trg_audit after insert or update or delete on ai.knowledge_docs for each row execute function private.audit_capture();

-- ---------------------------------------------------------------------
-- Quebra o texto em trechos: por seção (# título), juntando parágrafos até ~700 caracteres; cada trecho leva o título do documento e da seção.
-- ---------------------------------------------------------------------
create or replace function private.chunk_knowledge(p_title text, p_body text) returns text[]
language plpgsql immutable set search_path = '' as $$
declare
  v_out text[] := '{}'; v_cur text := ''; v_head text := ''; v_chead text := ''; para text; v_pos int; v_piece text;
begin
  for para in select trim(x) from regexp_split_to_table(replace(coalesce(p_body, ''), chr(13), ''), '\n\s*\n') x loop
    continue when para = '';
    if para ~ '^#{1,4}\s' then                                           -- título de seção (sozinho ou colado ao texto)
      if v_cur <> '' then v_out := v_out || (p_title || case when v_chead <> '' then ' › ' || v_chead else '' end || chr(10) || v_cur); v_cur := ''; end if;
      v_head := trim(regexp_replace(split_part(para, chr(10), 1), '^#+\s*', ''));
      v_pos := position(chr(10) in para);
      para := case when v_pos = 0 then '' else trim(substr(para, v_pos + 1)) end;
      continue when para = '';
    end if;
    while length(para) > 900 loop                                        -- parágrafo muito longo: corta na última frase antes de ~800
      v_piece := left(para, 800);
      v_pos := coalesce(length(substring(v_piece from '^.*\. ')), 800);
      if v_pos < 300 then v_pos := 800; end if;
      if v_cur <> '' then v_out := v_out || (p_title || case when v_chead <> '' then ' › ' || v_chead else '' end || chr(10) || v_cur); v_cur := ''; end if;
      v_chead := v_head;
      v_out := v_out || (p_title || case when v_chead <> '' then ' › ' || v_chead else '' end || chr(10) || trim(left(para, v_pos)));
      para := trim(substr(para, v_pos + 1));
    end loop;
    continue when para = '';
    if v_cur <> '' and length(v_cur) + length(para) > 700 then
      v_out := v_out || (p_title || case when v_chead <> '' then ' › ' || v_chead else '' end || chr(10) || v_cur); v_cur := '';
    end if;
    if v_cur = '' then v_chead := v_head; end if;
    v_cur := case when v_cur = '' then para else v_cur || chr(10) || chr(10) || para end;
  end loop;
  if v_cur <> '' then v_out := v_out || (p_title || case when v_chead <> '' then ' › ' || v_chead else '' end || chr(10) || v_cur); end if;
  return v_out;
end $$;

-- ---------------------------------------------------------------------
-- Busca (texto completo, qualquer palavra da pergunta conta; ordena pela relevância). Só documentos publicados e dentro da validade.
-- ---------------------------------------------------------------------
create or replace function private.knowledge_search(p_org uuid, p_query text, p_limit integer default 4)
returns table (doc_id uuid, title text, kind text, version integer, content text, rank real)
language sql stable security definer set search_path = '' as $$
  with q as (
    select to_tsquery('portuguese', string_agg(w, ' | ')) as tq
    from (select distinct w from regexp_split_to_table(private.kw_text(p_query), ' ') w where length(w) >= 3) x
  )
  select c.doc_id, d.title, d.kind, d.version, c.content, ts_rank_cd(c.tsv, q.tq)
  from ai.knowledge_chunks c
  join ai.knowledge_docs d on d.id = c.doc_id
  cross join q
  where c.org_id = p_org and d.status = 'PUBLISHED' and q.tq is not null and c.tsv @@ q.tq
    and (d.valid_from is null or d.valid_from <= private.today_sp()) and (d.valid_to is null or d.valid_to >= private.today_sp())
  order by 6 desc, d.title, c.position
  limit least(greatest(coalesce(p_limit, 4), 1), 8)
$$;

-- "Testar a busca" na tela
create or replace function ai.knowledge_search(p_query text, p_limit integer default 4) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('ai.read');
  return coalesce((select jsonb_agg(jsonb_build_object('doc_id', r.doc_id, 'title', r.title, 'kind', r.kind, 'version', r.version, 'text', r.content, 'rank', r.rank))
                   from private.knowledge_search(private.org_id(), p_query, p_limit) r), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- Rascunho → publicação
-- ---------------------------------------------------------------------
create or replace function ai.save_knowledge_doc(p_id uuid, p_title text, p_kind text, p_body text, p_valid_from date default null, p_valid_to date default null) returns ai.knowledge_docs
language plpgsql security definer set search_path = '' as $$
declare d ai.knowledge_docs; v_title text := trim(coalesce(p_title, ''));
begin
  perform private.require_perm('ai.write');
  if length(v_title) not between 3 and 120 then raise exception 'O título tem de 3 a 120 caracteres' using errcode = 'P0230'; end if;
  if p_kind not in ('POLICY', 'FAQ', 'PRODUCT_CARE', 'BRAND', 'EVENT', 'OTHER') then raise exception 'Tipo inválido' using errcode = 'P0230'; end if;
  if length(coalesce(p_body, '')) > 20000 then raise exception 'O texto passa de 20.000 caracteres: divida em dois documentos' using errcode = 'P0230'; end if;
  if p_valid_to is not null and p_valid_from is not null and p_valid_to < p_valid_from then raise exception 'A validade termina antes de começar' using errcode = 'P0230'; end if;
  if p_id is null then
    insert into ai.knowledge_docs (org_id, title, kind, draft_md, valid_from, valid_to, created_by)
    values (private.org_id(), v_title, p_kind, coalesce(p_body, ''), p_valid_from, p_valid_to, private.member_id()) returning * into d;
  else
    update ai.knowledge_docs set title = v_title, kind = p_kind, draft_md = coalesce(p_body, ''), valid_from = p_valid_from, valid_to = p_valid_to
    where id = p_id and org_id = private.org_id() and status <> 'ARCHIVED' returning * into d;
    if d.id is null then raise exception 'Documento não encontrado ou arquivado' using errcode = 'P0232'; end if;
  end if;
  return d;
end $$;

create or replace function ai.publish_knowledge_doc(p_id uuid) returns ai.knowledge_docs
language plpgsql security definer set search_path = '' as $$
declare d ai.knowledge_docs; ch text[]; i int;
begin
  perform private.require_perm('ai.write');
  select * into d from ai.knowledge_docs where id = p_id and org_id = private.org_id() for update;
  if d.id is null then raise exception 'Documento não encontrado' using errcode = 'P0232'; end if;
  if d.status = 'ARCHIVED' then raise exception 'Documento arquivado: reative antes de publicar' using errcode = 'P0231'; end if;
  if length(trim(d.draft_md)) < 20 then raise exception 'Escreva o texto (pelo menos 20 caracteres) antes de publicar' using errcode = 'P0231'; end if;
  ch := private.chunk_knowledge(d.title, d.draft_md);
  update ai.knowledge_docs set body_md = draft_md, status = 'PUBLISHED', version = version + 1, published_at = now(), published_by = private.member_id()
  where id = d.id returning * into d;
  insert into ai.knowledge_versions (org_id, doc_id, version, title, body_md, published_by) values (d.org_id, d.id, d.version, d.title, d.body_md, d.published_by);
  delete from ai.knowledge_chunks where doc_id = d.id;
  for i in 1 .. coalesce(array_length(ch, 1), 0) loop
    insert into ai.knowledge_chunks (org_id, doc_id, position, content) values (d.org_id, d.id, i, ch[i]);
  end loop;
  return d;
end $$;

-- Arquivar tira da busca da IA; reativar (p_archive = false) volta a publicar a última versão
create or replace function ai.archive_knowledge_doc(p_id uuid, p_archive boolean default true) returns ai.knowledge_docs
language plpgsql security definer set search_path = '' as $$
declare d ai.knowledge_docs; ch text[]; i int;
begin
  perform private.require_perm('ai.write');
  select * into d from ai.knowledge_docs where id = p_id and org_id = private.org_id() for update;
  if d.id is null then raise exception 'Documento não encontrado' using errcode = 'P0232'; end if;
  if p_archive then
    update ai.knowledge_docs set status = 'ARCHIVED' where id = d.id returning * into d;
    delete from ai.knowledge_chunks where doc_id = d.id;
  else
    if d.status <> 'ARCHIVED' then return d; end if;
    update ai.knowledge_docs set status = case when body_md is null then 'DRAFT' else 'PUBLISHED' end where id = d.id returning * into d;
    if d.status = 'PUBLISHED' then
      ch := private.chunk_knowledge(d.title, d.body_md);
      for i in 1 .. coalesce(array_length(ch, 1), 0) loop
        insert into ai.knowledge_chunks (org_id, doc_id, position, content) values (d.org_id, d.id, i, ch[i]);
      end loop;
    end if;
  end if;
  return d;
end $$;

-- Só apaga o que nunca foi publicado (o publicado fica no histórico: arquive)
create or replace function ai.delete_knowledge_doc(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('ai.write');
  if exists (select 1 from ai.knowledge_docs where id = p_id and org_id = private.org_id() and version > 0) then
    raise exception 'Documento já publicado: arquive em vez de apagar' using errcode = 'P0231';
  end if;
  delete from ai.knowledge_docs where id = p_id and org_id = private.org_id();
  if not found then raise exception 'Documento não encontrado' using errcode = 'P0232'; end if;
end $$;

-- ---------------------------------------------------------------------
-- Ferramenta da IA: search_knowledge
-- ---------------------------------------------------------------------
create or replace function agent.t_search_knowledge(c omni.conversations, a jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_q text := trim(coalesce(a ->> 'query', '')); v_res jsonb;
begin
  if length(v_q) < 3 then return jsonb_build_object('ok', false, 'error', 'Informe o que quer saber (pelo menos 3 letras)', 'code', 'INVALID'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('title', r.title, 'kind', r.kind, 'text', r.content)), '[]'::jsonb) into v_res from private.knowledge_search(c.org_id, v_q, 4) r;
  if jsonb_array_length(v_res) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Nada cadastrado sobre isso na base de conhecimento: não invente, diga que vai confirmar ou encaminhe para a equipe', 'code', 'NOT_FOUND');
  end if;
  return jsonb_build_object('ok', true, 'results', v_res);
end $$;
revoke execute on function agent.t_search_knowledge(omni.conversations, jsonb) from public, anon, authenticated;
grant execute on function agent.t_search_knowledge(omni.conversations, jsonb) to agent_rpc, service_role;

insert into private.internal_functions (fqname) values ('private.chunk_knowledge'), ('private.knowledge_search'), ('ai.set_chunk_tsv') on conflict do nothing;

-- Ponto único de entrada das ferramentas, agora com search_knowledge
create or replace function agent.call_tool(p_ctx jsonb, p_tool text, p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c omni.conversations; v_t0 timestamptz := clock_timestamp(); v_res jsonb; v_run uuid := nullif(p_ctx ->> 'run', '')::uuid; v_args jsonb := coalesce(p_args, '{}');
begin
  c := agent.ctx_conversation(p_ctx);
  if jsonb_typeof(p_ctx -> 'caps') <> 'array' or not (p_ctx -> 'caps') ? p_tool then
    raise exception 'Ferramenta % não permitida neste contexto', p_tool using errcode = '42501';
  end if;
  -- IDs de cliente/organização/conversa vindos do modelo são descartados: vale só o do ctx
  v_args := v_args - 'party_id' - 'org_id' - 'conversation_id' - 'party' - 'org' - 'conv';
  begin
    v_res := case p_tool
      when 'search_catalog' then agent.t_search_catalog(c, v_args)
      when 'check_stock_by_size' then agent.t_check_stock(c, v_args)
      when 'get_customer_360' then agent.t_customer_360(c, v_args)
      when 'get_order_status' then agent.t_order_status(c, v_args)
      when 'get_policies' then agent.t_get_policies(c, v_args)
      when 'search_knowledge' then agent.t_search_knowledge(c, v_args)
      when 'apply_coupon' then agent.t_apply_coupon(c, v_args)
      when 'create_reservation' then agent.t_create_reservation(c, v_args)
      when 'schedule_locker' then agent.t_schedule_locker(c, v_args)
      when 'create_order_draft' then agent.t_create_order_draft(c, v_args || jsonb_build_object('_run', coalesce(v_run::text, 'x')))
      when 'confirm_order_draft' then agent.t_confirm_order_draft(c, v_args)
      when 'create_payment_link' then agent.t_create_payment_link(c, v_args)
      when 'register_consent' then agent.t_register_consent(c, v_args)
      when 'update_customer_profile' then agent.t_update_profile(c, v_args)
      when 'remember_customer_fact' then agent.t_remember_fact(c, v_args)
      when 'request_handoff' then agent.t_request_handoff(p_ctx, c, v_args)
      when 'propose_reply' then agent.t_propose_reply(c, v_args)
      else jsonb_build_object('ok', false, 'error', 'Ferramenta desconhecida: ' || p_tool, 'code', 'UNKNOWN_TOOL')
    end;
  exception when others then
    v_res := jsonb_build_object('ok', false, 'error', sqlerrm, 'code', sqlstate);
  end;
  if v_run is not null and exists (select 1 from ai.runs where id = v_run and org_id = c.org_id) then
    insert into ai.tool_calls (run_id, tool, args, result_digest, ok, ms)
    values (v_run, p_tool, v_args, v_res, coalesce((v_res ->> 'ok')::boolean, false), (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);
  end if;
  return v_res;
end $$;

select private.lock_functions();
