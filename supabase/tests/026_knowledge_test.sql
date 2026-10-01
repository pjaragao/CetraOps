begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
create temp table ids (k text primary key, v text);
grant all on ids to authenticated, agent_rpc;

create or replace function pg_temp.agent_call(p_tool text, p_args jsonb default '{}') returns jsonb
language plpgsql as $f$
declare r jsonb;
begin
  set local role agent_rpc;
  begin
    r := agent.call_tool((select v::jsonb from ids where k = 'ctx'), p_tool, p_args);
  exception when others then
    reset role;
    return jsonb_build_object('__error', sqlstate, '__msg', sqlerrm);
  end;
  reset role;
  return r;
end $f$;

-- ---------- Quebra em trechos ----------
select is(array_length(private.chunk_knowledge('Troca', E'# Prazo\n\nA troca vale por 30 dias.\n\n# Como pedir\n\nChame a loja pelo WhatsApp.'), 1), 2, 'cada seção vira um trecho');
select is((private.chunk_knowledge('Troca', E'# Prazo\n\nA troca vale por 30 dias.'))[1], E'Troca › Prazo\nA troca vale por 30 dias.', 'o trecho leva o título do documento e da seção');
select cmp_ok(array_length(private.chunk_knowledge('Longo', repeat('Uma frase com algum conteúdo sobre o cuidado das peças. ', 40)), 1), '>=', 3, 'parágrafo muito longo é cortado em vários trechos');
select ok((select bool_and(length(x) <= 1000) from unnest(private.chunk_knowledge('Longo', repeat('Uma frase com algum conteúdo sobre o cuidado das peças. ', 40))) x), 'nenhum trecho passa de ~1000 caracteres');

-- ---------- Preparação: conversa e contexto da IA ----------
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode)
values ('00000000-0000-4000-8000-0000000009a9', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PNID-KB', 'WhatsApp (teste da base)', '00000000-0000-4000-8000-0000000000a1', 'AI_AUTOPILOT');
insert into ids select 'conv', (omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-KB', 'external_id', '5548988880001',
  'phone', '5548988880001', 'display_name', 'Cliente Base (teste)', 'provider_message_id', 'wamid.KB1', 'body', 'Como lavo a peça?')))->>'conversation_id';
insert into ids select 'party', party_id::text from omni.conversations where id = (select v from ids where k = 'conv')::uuid;
insert into ai.runs (id, org_id, route_task, conversation_id, party_id) values ('00000000-0000-4000-8000-0000000009d9', '00000000-0000-4000-8000-000000000001', 'conversation',
  (select v from ids where k = 'conv')::uuid, (select v from ids where k = 'party')::uuid);
insert into ids select 'ctx', jsonb_build_object('org', '00000000-0000-4000-8000-000000000001', 'conv', (select v from ids where k = 'conv'), 'party', (select v from ids where k = 'party'),
  'run', '00000000-0000-4000-8000-0000000009d9', 'version', (select version from omni.conversations where id = (select v from ids where k = 'conv')::uuid),
  'caps', jsonb_build_array('search_knowledge', 'propose_reply'))::text;

-- ---------- Permissões ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora: lê (ai.read), não escreve
select throws_ok($$ select ai.save_knowledge_doc(null, 'Cuidado com as peças', 'PRODUCT_CARE', 'texto') $$, '42501', null, 'quem só lê não cria documento');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
select throws_ok($$ select ai.save_knowledge_doc(null, 'ab', 'FAQ', 'texto') $$, 'P0230', null, 'título curto demais');
select throws_ok($$ select ai.save_knowledge_doc(null, 'Título válido', 'XYZ', 'texto') $$, 'P0230', null, 'tipo inválido');
select throws_ok($$ select ai.save_knowledge_doc(null, 'Título válido', 'FAQ', 'texto', '2031-02-01', '2031-01-01') $$, 'P0230', null, 'validade que termina antes de começar');

-- ---------- Rascunho não é visível para a IA ----------
insert into ids select 'doc', (ai.save_knowledge_doc(null, 'Lavagem das peças', 'PRODUCT_CARE',
  E'# Lavagem\n\nLave à mão ou no ciclo delicado, com água fria, sem alvejante. Seque à sombra.\n\n# Passar\n\nNão passe ferro direto sobre a estampa.')).id::text;
select is((select status from ai.knowledge_docs where id = (select v from ids where k = 'doc')::uuid), 'DRAFT', 'nasce como rascunho');
select is(jsonb_array_length(ai.knowledge_search('lavagem água fria')), 0, 'rascunho não aparece na busca');
reset role;
select is((pg_temp.agent_call('search_knowledge', '{"query":"lavagem água fria"}'))->>'code', 'NOT_FOUND', 'a IA não vê rascunho: orienta a não inventar');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');

-- ---------- Publicar ----------
select is((ai.publish_knowledge_doc((select v from ids where k = 'doc')::uuid)).version, 1, 'publicada na versão 1');
select is((select count(*)::int from ai.knowledge_chunks where doc_id = (select v from ids where k = 'doc')::uuid), 2, 'gera um trecho por seção');
select is((select title from jsonb_to_recordset(ai.knowledge_search('como lavar a peça sem alvejante')) as x(title text) limit 1), 'Lavagem das peças', 'a busca acha pela pergunta em linguagem natural');
select is((select title from jsonb_to_recordset(ai.knowledge_search('AGUA FRIA lavagem')) as x(title text) limit 1), 'Lavagem das peças', 'ignora acento e maiúsculas');
select ok((select (ai.knowledge_search('ferro estampa') -> 0 ->> 'text') like '%Não passe ferro%'), 'devolve o trecho certo da seção');
select is(jsonb_array_length(ai.knowledge_search('xyzabc inexistente')), 0, 'sem trecho: lista vazia');

-- ---------- A IA consulta ----------
reset role;
select is((pg_temp.agent_call('search_knowledge', '{"query":"como lavar sem alvejante"}'))->>'ok', 'true', 'a IA encontra');
select ok((pg_temp.agent_call('search_knowledge', '{"query":"como lavar sem alvejante"}'))->'results'->0->>'text' like '%água fria%', 'recebe o texto publicado');
select is((pg_temp.agent_call('search_knowledge', '{"query":"garantia vitalícia de zíper"}'))->>'code', 'NOT_FOUND', 'assunto que não está cadastrado: não inventar');
select is((pg_temp.agent_call('search_knowledge', '{"query":"oi"}'))->>'code', 'INVALID', 'pergunta curta demais');
select ok((select bool_or(ok) and count(*) >= 3 from ai.tool_calls where run_id = '00000000-0000-4000-8000-0000000009d9' and tool = 'search_knowledge'), 'as consultas ficam registradas na execução');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');

-- ---------- Editar o rascunho não muda o publicado ----------
select ai.save_knowledge_doc((select v from ids where k = 'doc')::uuid, 'Lavagem das peças', 'PRODUCT_CARE', E'# Lavagem\n\nNova orientação ainda em revisão sobre secagem em varal.');
select ok((select body_md like '%Seque à sombra%' and draft_md like '%em revisão%' from ai.knowledge_docs where id = (select v from ids where k = 'doc')::uuid), 'o texto publicado continua o mesmo até republicar');
select is((ai.publish_knowledge_doc((select v from ids where k = 'doc')::uuid)).version, 2, 'republicar cria a versão 2');
select is((select count(*)::int from ai.knowledge_versions where doc_id = (select v from ids where k = 'doc')::uuid), 2, 'as duas versões ficam guardadas');

-- ---------- Validade, arquivo e exclusão ----------
select ai.save_knowledge_doc((select v from ids where k = 'doc')::uuid, 'Lavagem das peças', 'PRODUCT_CARE', E'# Lavagem\n\nNova orientação ainda em revisão sobre secagem em varal.', '2999-01-01', null);
select ai.publish_knowledge_doc((select v from ids where k = 'doc')::uuid);
select is(jsonb_array_length(ai.knowledge_search('secagem varal revisão')), 0, 'fora da validade não aparece');
select ai.archive_knowledge_doc((select v from ids where k = 'doc')::uuid);
select is((select count(*)::int from ai.knowledge_chunks where doc_id = (select v from ids where k = 'doc')::uuid), 0, 'arquivar tira da busca');
select throws_ok($$ select ai.delete_knowledge_doc((select id from ai.knowledge_docs where title = 'Lavagem das peças')) $$, 'P0231', null, 'documento já publicado não se apaga');
insert into ids select 'doc2', (ai.save_knowledge_doc(null, 'Rascunho descartável', 'OTHER', 'rascunho qualquer')).id::text;
select lives_ok($$ select ai.delete_knowledge_doc((select v from ids where k = 'doc2')::uuid) $$, 'rascunho nunca publicado pode ser apagado');

select * from finish();
rollback;
