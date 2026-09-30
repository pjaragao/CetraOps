begin;
create extension if not exists pgtap with schema extensions;
select plan(79);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
-- vetor de 1024 posições com 1 na posição i (distância de cosseno 0 para o mesmo i, 1 para i diferentes)
create or replace function pg_temp.vec(i int) returns text language sql as $$
  select '[' || array_to_string(array(select case when g = i then '1' else '0' end from generate_series(1, 1024) g), ',') || ']'
$$;
grant execute on function pg_temp.vec(int) to authenticated;
create temp table ids (k text primary key, v text);
grant all on ids to authenticated;

-- ---------- Preparação (dono do banco): canal de WhatsApp e uma conversa ----------
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode) values
  ('00000000-0000-4000-8000-0000000009e1', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PN-PERSONA-1', 'WhatsApp personas', '00000000-0000-4000-8000-0000000000a1', 'AI_COPILOT');
insert into ids select 'conv', (omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PN-PERSONA-1', 'external_id', '5548977770099', 'phone', '5548977770099',
  'display_name', 'Clara Persona (teste)', 'provider_message_id', 'wamid.PERS1', 'body', 'Oi, tem a legging preta no M?')))->>'conversation_id';
create temp table q0 as select (select queue_length from pgmq.metrics('persona_tasks')) as t;

-- ---------- Permissões ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select throws_ok($$ select ai.save_persona('{"name":"Luisa"}') $$, '42501', null, 'vendedora não cria persona');
select throws_ok($$ select ai.create_corpus_source('{}') $$, '42501', null, 'vendedora não envia histórico');
select throws_ok($$ select ai.approve_persona_version(gen_random_uuid()) $$, '42501', null, 'vendedora não aprova versão');

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
-- ---------- Personas ----------
select throws_ok($$ select ai.save_persona('{"name":"L"}') $$, 'P0140', null, 'nome curto demais');
select throws_ok($$ select ai.save_persona(jsonb_build_object('name', 'Luisa', 'member_id', gen_random_uuid())) $$, 'P0140', null, 'pessoa da equipe inexistente');
insert into ids select 'persona', (ai.save_persona(jsonb_build_object('name', 'Luisa (teste)', 'member_id', '00000000-0000-4000-8000-000000000101'))).id::text;
select throws_ok($$ select ai.save_persona('{"name":"Luisa (teste)"}') $$, 'P0140', null, 'nome repetido');
select is((ai.save_persona(jsonb_build_object('id', (select v from ids where k = 'persona'), 'name', 'Luisa Teste'))).name, 'Luisa Teste', 'renomeia pelo id');
select throws_ok($$ select ai.save_persona(jsonb_build_object('id', gen_random_uuid(), 'name', 'Fantasma')) $$, 'P0142', null, 'persona inexistente');

-- ---------- Enviar histórico ----------
select throws_ok($$ select ai.create_corpus_source(jsonb_build_object('persona_id', gen_random_uuid(), 'kind', 'WA_TXT', 'owner_name', 'Luisa', 'content', repeat('x', 50))) $$, 'P0142', null, 'persona inexistente no envio');
select throws_ok($$ select ai.create_corpus_source(jsonb_build_object('persona_id', (select v from ids where k = 'persona'), 'kind', 'PDF', 'owner_name', 'Luisa', 'content', repeat('x', 50))) $$, 'P0140', null, 'tipo inválido');
select throws_ok($$ select ai.create_corpus_source(jsonb_build_object('persona_id', (select v from ids where k = 'persona'), 'kind', 'WA_TXT', 'owner_name', ' ', 'content', repeat('x', 50))) $$, 'P0140', null, 'sem o nome do sócio no arquivo');
select throws_ok($$ select ai.create_corpus_source(jsonb_build_object('persona_id', (select v from ids where k = 'persona'), 'kind', 'WA_TXT', 'owner_name', 'Luisa', 'content', 'curto')) $$, 'P0140', null, 'arquivo vazio');
insert into ids select 'src1', (ai.create_corpus_source(jsonb_build_object('persona_id', (select v from ids where k = 'persona'), 'kind', 'WA_TXT', 'owner_name', 'Luisa', 'filename', 'conversa.txt',
  'content', '01/09/2026 10:00 - Luisa: bom dia'))).id::text;
select is((select status || '/' || bytes from ai.corpus_sources where id = (select v from ids where k = 'src1')::uuid), 'UPLOADED/' || octet_length('01/09/2026 10:00 - Luisa: bom dia'), 'histórico entra como enviado, com o tamanho');
select throws_ok($$ select count(*) from ai.corpus_raw $$, '42501', null, 'o bruto não é legível por quem está logado');
reset role;
select is((select count(*)::int from ai.corpus_raw where source_id = (select v from ids where k = 'src1')::uuid), 1, 'o arquivo bruto fica guardado até o worker tratar');
select is((select queue_length from pgmq.metrics('persona_tasks')) - (select t from q0), 1::bigint, 'o tratamento vai para a fila do worker');
select is((select message ->> 'action' from pgmq.q_persona_tasks order by msg_id desc limit 1), 'PROCESS', 'ação PROCESS');

-- ---------- Tratamento pelo worker ----------
select lives_ok($$ select ai.corpus_mark_processing((select v from ids where k = 'src1')::uuid) $$, 'marca como em processamento');
select is((select status from ai.corpus_sources where id = (select v from ids where k = 'src1')::uuid), 'PROCESSING', 'em processamento');
select is(ai.corpus_ingest(jsonb_build_object('source_id', (select v from ids where k = 'src1'), 'stats', '{"messages": 40}'::jsonb, 'dialogues', jsonb_build_array(
  jsonb_build_object('digest', 'd1', 'turns', '[{"role":"customer","text":"Oi, tem legging M?"},{"role":"owner","text":"Tem sim! Qual cor?"}]'::jsonb,
    'pairs', jsonb_build_array(jsonb_build_object('position', 1, 'context', '[{"role":"customer","text":"Oi, tem legging M?"}]'::jsonb, 'reply', '["Tem sim! Qual cor?"]'::jsonb))),
  jsonb_build_object('digest', 'd2', 'turns', '[{"role":"customer","text":"Feliz aniversário, mãe!"},{"role":"owner","text":"Obrigada, filha!"}]'::jsonb,
    'pairs', jsonb_build_array(jsonb_build_object('position', 1, 'context', '[{"role":"customer","text":"Feliz aniversário, mãe!"}]'::jsonb, 'reply', '["Obrigada, filha!"]'::jsonb))),
  jsonb_build_object('digest', 'd3', 'turns', '[{"role":"customer","text":"Quanto custa o top?"},{"role":"owner","text":"O top está R$ {PRECO}, amiga!"}]'::jsonb,
    'pairs', jsonb_build_array(jsonb_build_object('position', 1, 'context', '[{"role":"customer","text":"Quanto custa o top?"}]'::jsonb, 'reply', '["O top está R$ {PRECO}, amiga!"]'::jsonb)))))),
  '{"dialogues": 3, "duplicates": 0, "pairs": 3}'::jsonb, 'ingere diálogos e pares');
select is((select status || '/' || (stats ->> 'imported_dialogues') || '/' || (stats ->> 'messages') from ai.corpus_sources where id = (select v from ids where k = 'src1')::uuid), 'READY/3/40', 'histórico pronto, com as estatísticas do tratamento');
select is((select count(*)::int from ai.corpus_raw where source_id = (select v from ids where k = 'src1')::uuid), 0, 'o arquivo bruto foi apagado');
select ok((select raw_deleted_at is not null from ai.corpus_sources where id = (select v from ids where k = 'src1')::uuid), 'data do apagamento registrada');
select is((select count(*)::int from ai.corpus_pairs where persona_id = (select v from ids where k = 'persona')::uuid and source = 'HISTORICAL'), 3, 'pares históricos criados');
-- mesmo diálogo vindo de outra exportação não duplica
insert into ai.corpus_sources (id, org_id, persona_id, kind, owner_name) values ('00000000-0000-4000-8000-0000000009d2', '00000000-0000-4000-8000-000000000001', (select v from ids where k = 'persona')::uuid, 'WA_TXT', 'Luisa');
select is(ai.corpus_ingest('{"source_id":"00000000-0000-4000-8000-0000000009d2","dialogues":[{"digest":"d1","turns":[],"pairs":[]},{"digest":"d4","turns":[{"role":"customer","text":"Tem P?"},{"role":"owner","text":"Tem!"}],"pairs":[]}]}'),
  '{"dialogues": 1, "duplicates": 1, "pairs": 0}'::jsonb, 'diálogo repetido entre exportações é ignorado');
select lives_ok($$ select ai.corpus_fail('00000000-0000-4000-8000-0000000009d2', 'arquivo corrompido') $$, 'falha marca o histórico');
select is((select status from ai.corpus_sources where id = '00000000-0000-4000-8000-0000000009d2'), 'FAILED', 'histórico com falha');

-- ---------- Revisão pelo sócio ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((select count(*)::int from ai.corpus_dialogues where persona_id = (select v from ids where k = 'persona')::uuid), 4, 'sócio vê os diálogos');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is((select count(*)::int from ai.corpus_dialogues), 0, 'vendedora não vê o histórico dos sócios');
select is((select count(*)::int from ai.corpus_pairs), 0, 'nem os pares');
select is((select count(*)::int from ai.personas where name = 'Luisa Teste'), 1, 'mas vê a persona (leitura)');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select lives_ok($$ select ai.request_corpus_task((select v from ids where k = 'persona')::uuid, 'CLASSIFY') $$, 'pede classificação');
select throws_ok($$ select ai.request_corpus_task((select v from ids where k = 'persona')::uuid, 'DORMIR') $$, 'P0140', null, 'ação inválida');
select throws_ok($$ select ai.request_corpus_task(gen_random_uuid(), 'EMBED') $$, 'P0142', null, 'persona inexistente');
reset role;
select is((select message ->> 'action' from pgmq.q_persona_tasks order by msg_id desc limit 1), 'CLASSIFY', 'classificação na fila');
select is(ai.corpus_labels(jsonb_build_object('items', jsonb_build_array(
  jsonb_build_object('dialogue_id', (select id from ai.corpus_dialogues where digest = 'd1' and persona_id = (select v from ids where k = 'persona')::uuid), 'commercial', true, 'topics', '["tamanho"]'::jsonb, 'outcome', 'VENDA',
    'pairs', jsonb_build_array(jsonb_build_object('position', 1, 'intent', 'disponibilidade', 'stage', 'descoberta'))),
  jsonb_build_object('dialogue_id', (select id from ai.corpus_dialogues where digest = 'd2' and persona_id = (select v from ids where k = 'persona')::uuid), 'commercial', false, 'topics', '["familia"]'::jsonb),
  jsonb_build_object('dialogue_id', (select id from ai.corpus_dialogues where digest = 'd3' and persona_id = (select v from ids where k = 'persona')::uuid), 'commercial', true),
  jsonb_build_object('dialogue_id', (select id from ai.corpus_dialogues where digest = 'd4' and persona_id = (select v from ids where k = 'persona')::uuid), 'commercial', true)))), 4, 'grava a classificação');
select is((select include from ai.corpus_dialogues where digest = 'd2' and persona_id = (select v from ids where k = 'persona')::uuid), false, 'conversa pessoal sai da persona');
select is((select stage || '/' || intent from ai.corpus_pairs p join ai.corpus_dialogues d on d.id = p.dialogue_id where d.digest = 'd1' and d.persona_id = (select v from ids where k = 'persona')::uuid), 'descoberta/disponibilidade', 'etapa e intenção do par');
select is((select topics from ai.corpus_dialogues where digest = 'd1' and persona_id = (select v from ids where k = 'persona')::uuid), '{tamanho}'::text[], 'assuntos');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select ai.request_corpus_task((select v from ids where k = 'persona')::uuid, 'CLASSIFY') $$, 'P0141', null, 'sem diálogo novo não há o que classificar');
select is(ai.set_dialogues_included(array[(select id from ai.corpus_dialogues where digest = 'd2' and persona_id = (select v from ids where k = 'persona')::uuid)], true), 1, 'sócio devolve o diálogo à persona');
select is(ai.set_dialogues_included(array[(select id from ai.corpus_dialogues where digest = 'd2' and persona_id = (select v from ids where k = 'persona')::uuid)], false), 1, 'e tira de novo');

-- ---------- Índice de exemplos (embeddings) ----------
select lives_ok($$ select ai.request_corpus_task((select v from ids where k = 'persona')::uuid, 'EMBED') $$, 'pede a indexação dos exemplos');
reset role;
select is(ai.corpus_embeddings(jsonb_build_object('model', 'teste/embed', 'items', jsonb_build_array(
  jsonb_build_object('pair_id', (select p.id from ai.corpus_pairs p join ai.corpus_dialogues d on d.id = p.dialogue_id where d.digest = 'd1' and d.persona_id = (select v from ids where k = 'persona')::uuid), 'embedding', pg_temp.vec(1)),
  jsonb_build_object('pair_id', (select p.id from ai.corpus_pairs p join ai.corpus_dialogues d on d.id = p.dialogue_id where d.digest = 'd2' and d.persona_id = (select v from ids where k = 'persona')::uuid), 'embedding', pg_temp.vec(1)),
  jsonb_build_object('pair_id', (select p.id from ai.corpus_pairs p join ai.corpus_dialogues d on d.id = p.dialogue_id where d.digest = 'd3' and d.persona_id = (select v from ids where k = 'persona')::uuid), 'embedding', pg_temp.vec(2))))), 3, 'grava os embeddings');
select is((select array_agg(reply ->> 0 order by distance, reply ->> 0) from ai.similar_pairs((select v from ids where k = 'persona')::uuid, pg_temp.vec(1), 10)), array['Tem sim! Qual cor?', 'O top está R$ {PRECO}, amiga!'],
  'busca por similaridade: o mais parecido primeiro');
select is((select count(*)::int from ai.similar_pairs((select v from ids where k = 'persona')::uuid, pg_temp.vec(1), 10)), 2, 'diálogo fora da persona não entra nos exemplos');
select is((select round(distance::numeric, 3) from ai.similar_pairs((select v from ids where k = 'persona')::uuid, pg_temp.vec(2), 1)), 0.000, 'distância zero para o vetor igual');
select is((select count(*)::int from ai.similar_pairs((select v from ids where k = 'persona')::uuid, pg_temp.vec(1), 10, 'descoberta')), 1, 'filtra por etapa');
select is((select array_length(embedding, 1) from ai.similar_pairs((select v from ids where k = 'persona')::uuid, pg_temp.vec(1), 1)), 1024, 'devolve o vetor (para a diversidade MMR)');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select ai.request_corpus_task((select v from ids where k = 'persona')::uuid, 'EMBED') $$, 'P0141', null, 'tudo indexado');

-- ---------- Perfil e versões ----------
select throws_ok($$ select ai.request_persona_profile((select v from ids where k = 'persona')::uuid) $$, 'P0141', null, 'poucos diálogos para gerar o perfil');
reset role;
insert into ai.corpus_dialogues (org_id, persona_id, source_id, digest, turns)
  select '00000000-0000-4000-8000-000000000001', (select v from ids where k = 'persona')::uuid, (select v from ids where k = 'src1')::uuid, 'extra' || g, '[]' from generate_series(1, 8) g;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select lives_ok($$ select ai.request_persona_profile((select v from ids where k = 'persona')::uuid, array['mimos', 'look']) $$, 'com 10 diálogos aproveitáveis pede o perfil');
reset role;
select is((select message ->> 'action' || '/' || (message -> 'lexicon' ->> 1) from pgmq.q_persona_tasks order by msg_id desc limit 1), 'PROFILE/look', 'PROFILE na fila, com o vocabulário da marca');
insert into ids select 'v1', ai.persona_new_version(jsonb_build_object('persona_id', (select v from ids where k = 'persona'), 'style_profile', '{"stats":{"bubbles":10}}'::jsonb, 'system_prompt', 'Você é a Luisa da SIÉ.'))::text;
select is((select version from ai.persona_versions where id = (select v from ids where k = 'v1')::uuid), 1, 'primeira versão');
select ok((select approved_at is null from ai.persona_versions where id = (select v from ids where k = 'v1')::uuid), 'a versão gerada nasce sem aprovação');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((ai.save_persona_version(jsonb_build_object('id', (select v from ids where k = 'v1'), 'system_prompt', 'Você é a Luisa, sócia da SIÉ. Fale curto.', 'guardrails', '{"extra_rules":["Nunca fale de política"]}'::jsonb))).system_prompt,
  'Você é a Luisa, sócia da SIÉ. Fale curto.', 'sócio edita o rascunho');
select throws_ok($$ select ai.save_persona_version(jsonb_build_object('id', (select v from ids where k = 'v1'), 'guardrails', '[1]'::jsonb)) $$, 'P0140', null, 'regras extras precisam ser um objeto');
select is((select active_version_id from ai.personas where id = (select v from ids where k = 'persona')::uuid), null, 'nada ativo antes da aprovação');
select is((ai.approve_persona_version((select v from ids where k = 'v1')::uuid)).active_version_id, (select v from ids where k = 'v1')::uuid, 'aprovar ativa a versão');
select ok((select approved_by is not null and approved_at is not null from ai.persona_versions where id = (select v from ids where k = 'v1')::uuid), 'registra quem aprovou e quando');
select throws_ok($$ select ai.save_persona_version(jsonb_build_object('id', (select v from ids where k = 'v1'), 'system_prompt', 'mudei')) $$, 'P0141', null, 'versão aprovada não muda');
insert into ids select 'v2', (ai.save_persona_version(jsonb_build_object('persona_id', (select v from ids where k = 'persona'))) ).id::text;
select is((select version from ai.persona_versions where id = (select v from ids where k = 'v2')::uuid), 2, 'nova versão em branco');
select throws_ok($$ select ai.approve_persona_version((select v from ids where k = 'v2')::uuid) $$, 'P0141', null, 'não aprova versão sem prompt');
select is((select active_version_id from ai.personas where id = (select v from ids where k = 'persona')::uuid), (select v from ids where k = 'v1')::uuid, 'a versão ativa continua a aprovada');

-- ---------- Aprendizado contínuo (inbox) ----------
reset role;
with d as (insert into omni.message_drafts (org_id, conversation_id, variants, intent, stage, confidence)
  values ('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'conv')::uuid, '[{"messages":["Tem sim, amiga! Qual cor você quer?"]}]', 'disponibilidade', 'descoberta', 0.9) returning id)
insert into ids select 'draft', id::text from d;
create temp table q1 as select (select queue_length from pgmq.metrics('persona_tasks')) as t;
update omni.message_drafts set status = 'EDITED_SENT' where id = (select v from ids where k = 'draft')::uuid;
select is((select queue_length from pgmq.metrics('persona_tasks')) - (select t from q1), 1::bigint, 'rascunho usado vira tarefa de aprendizado');
select is((select message ->> 'action' from pgmq.q_persona_tasks order by msg_id desc limit 1), 'LEARN', 'ação LEARN');
update omni.message_drafts set status = 'EDITED_SENT' where id = (select v from ids where k = 'draft')::uuid;
select is((select queue_length from pgmq.metrics('persona_tasks')) - (select t from q1), 1::bigint, 'só a mudança de situação dispara (sem repetir)');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into ids select 'hmsg', (omni.send_message((select v from ids where k = 'conv')::uuid, 'Tem sim! Qual cor você prefere?')).id::text;
reset role;
select is((select count(*)::int from pgmq.q_persona_tasks where message ->> 'message_id' = (select v from ids where k = 'hmsg')), 1, 'resposta humana também vira tarefa de aprendizado');
select is(ai.corpus_add_live_pair(jsonb_build_object('org_id', '00000000-0000-4000-8000-000000000001', 'persona_id', (select v from ids where k = 'persona'), 'message_id', (select v from ids where k = 'hmsg'),
  'source', 'HUMAN_LIVE', 'weight', 1.2, 'context', '[{"role":"customer","text":"Oi, tem a legging preta no M?"}]'::jsonb, 'reply', '["Tem sim! Qual cor você prefere?"]'::jsonb)) is not null, true, 'par ao vivo entra');
select is(ai.corpus_add_live_pair(jsonb_build_object('org_id', '00000000-0000-4000-8000-000000000001', 'persona_id', (select v from ids where k = 'persona'), 'message_id', (select v from ids where k = 'hmsg'),
  'source', 'HUMAN_EDIT', 'weight', 2, 'context', '[{"role":"customer","text":"Oi, tem a legging preta no M?"}]'::jsonb, 'reply', '["Tem sim! Qual cor você prefere?"]'::jsonb)) is not null, true, 'rascunho editado (peso maior) substitui o par');
select is((select source || '/' || weight from ai.corpus_pairs where message_id = (select v from ids where k = 'hmsg')::uuid), 'HUMAN_EDIT/2.00', 'ficou o de maior peso');
select is(ai.corpus_add_live_pair(jsonb_build_object('org_id', '00000000-0000-4000-8000-000000000001', 'persona_id', (select v from ids where k = 'persona'), 'message_id', (select v from ids where k = 'hmsg'),
  'source', 'HUMAN_LIVE', 'weight', 1.2, 'context', '[]'::jsonb, 'reply', '["x"]'::jsonb)), null, 'um de peso menor não sobrescreve');

-- ---------- Apagar histórico e privilégios ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select lives_ok($$ select ai.delete_corpus_source((select v from ids where k = 'src1')::uuid) $$, 'sócio apaga um histórico');
select is((select count(*)::int from ai.corpus_dialogues where source_id = (select v from ids where k = 'src1')::uuid), 0, 'os diálogos dele saem junto');
select is((select count(*)::int from ai.corpus_pairs where source = 'HISTORICAL' and persona_id = (select v from ids where k = 'persona')::uuid), 0, 'e os pares históricos');
select is((select count(*)::int from ai.corpus_pairs where message_id = (select v from ids where k = 'hmsg')::uuid), 1, 'pares da inbox continuam');
select throws_ok($$ select ai.delete_corpus_source(gen_random_uuid()) $$, 'P0142', null, 'histórico inexistente');
select ok(not has_function_privilege('authenticated', 'ai.corpus_ingest(jsonb)', 'execute') and not has_function_privilege('authenticated', 'ai.similar_pairs(uuid,text,integer,text)', 'execute')
  and not has_function_privilege('authenticated', 'ai.corpus_add_live_pair(jsonb)', 'execute') and not has_function_privilege('authenticated', 'ai.persona_new_version(jsonb)', 'execute'), 'funções do worker não são chamáveis pela tela');
select ok(has_function_privilege('authenticated', 'ai.approve_persona_version(uuid)', 'execute') and has_function_privilege('authenticated', 'ai.create_corpus_source(jsonb)', 'execute'), 'funções da tela são chamáveis (com permissão)');

select * from finish();
rollback;
