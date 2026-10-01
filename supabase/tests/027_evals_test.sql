begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

-- O seed de desenvolvimento já traz casos: começamos de uma base vazia para contar com exatidão (tudo some no rollback)
delete from ai.eval_cases;
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora: lê, não escreve
select throws_ok($$ select ai.save_eval_case('{"key":"x1","title":"Teste","turns":[{"role":"user","text":"oi"}]}') $$, '42501', null, 'quem só lê não cria caso');
select throws_ok($$ select ai.request_eval(array['x/bom']) $$, '42501', null, 'nem pede avaliação');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio

-- ---------- Casos: validações ----------
select throws_ok($$ select ai.save_eval_case('{"key":"Chave Ruim","title":"Teste","turns":[{"role":"user","text":"oi"}]}') $$, 'P0241', null, 'chave só com minúsculas, números, - e _');
select throws_ok($$ select ai.save_eval_case('{"key":"k1","title":"ab","turns":[{"role":"user","text":"oi"}]}') $$, 'P0241', null, 'título curto');
select throws_ok($$ select ai.save_eval_case('{"key":"k1","title":"Teste","turns":[]}') $$, 'P0241', null, 'conversa sem falas');
select throws_ok($$ select ai.save_eval_case('{"key":"k1","title":"Teste","turns":[{"role":"user","text":"oi"},{"role":"assistant","text":"olá"}]}') $$, 'P0241', null, 'a última fala tem de ser da cliente');
select throws_ok($$ select ai.save_eval_case('{"key":"k1","title":"Teste","turns":[{"role":"robo","text":"oi"}]}') $$, 'P0241', null, 'quem falou: só cliente ou IA');
select throws_ok($$ select ai.save_eval_case('{"key":"k1","title":"Teste","turns":[{"role":"user","text":"oi"}],"expect":{"outcome_in":["ENVIAR"]}}') $$, 'P0241', null, 'resultado esperado inválido');
select throws_ok($$ select ai.save_eval_case('{"key":"k1","title":"Teste","turns":[{"role":"user","text":"oi"}],"expect":{"tools_any":["hackear"]}}') $$, 'P0241', null, 'ferramenta desconhecida');
select throws_ok($$ select ai.save_eval_case('{"key":"k1","title":"Teste","turns":[{"role":"user","text":"oi"}],"expect":{"must_not_match":["(abre"]}}') $$, 'P0241', null, 'expressão regular inválida');
select throws_ok($$ select ai.save_eval_case('{"key":"k1","title":"Teste","turns":[{"role":"user","text":"oi"}],"expect":{"qualquer":true}}') $$, 'P0241', null, 'expectativa desconhecida');

-- ---------- Casos: gravação ----------
select is((ai.save_eval_case('{"key":"c1","title":"Reclamação vai para uma pessoa","turns":[{"role":"user","text":"chegou com defeito"}],"expect":{"outcome_in":["HANDOFF"]}}')).key, 'c1', 'caso criado');
select ai.save_eval_case(jsonb_build_object('key', 'c' || n, 'title', 'Caso número ' || n, 'turns', jsonb_build_array(jsonb_build_object('role', 'user', 'text', 'pergunta ' || n)), 'expect', '{"no_flags":true}'::jsonb)) from generate_series(2, 10) n;
select is((ai.save_eval_case('{"key":"c2","title":"Título atualizado","turns":[{"role":"user","text":"nova pergunta"}]}')).title, 'Título atualizado', 'mesma chave atualiza em vez de duplicar');
select is((select count(*)::int from ai.eval_cases), 10, 'dez casos');

-- ---------- Pedido de avaliação ----------
select throws_ok($$ select ai.request_eval(array['modelo inválido!']) $$, 'P0241', null, 'slug de modelo inválido');
select throws_ok($$ select ai.request_eval(array['a/1','a/2','a/3','a/4','a/5']) $$, 'P0241', null, 'no máximo 4 modelos por avaliação');
select is((ai.request_eval(array['x/bom', 'x/ruim', 'x/bom'])).models, array['x/bom', 'x/ruim'], 'pedido aceito, sem repetir modelo');
reset role;
select is((select count(*)::int from pgmq.q_ai_tasks where message ->> 'action' = 'EVAL_RUN'), 1, 'o worker recebe o pedido na fila');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select ai.request_eval(array['x/bom']) $$, 'P0242', null, 'uma avaliação por vez');

-- ---------- Lote: totais calculados no banco ----------
reset role;
select ai.eval_mark((select id from ai.eval_requests limit 1), 'DONE');
select is((select status from ai.eval_requests limit 1), 'DONE', 'pedido concluído');
select ok(exists (select 1 from core.notifications where kind = 'EVAL' and title = 'Avaliação dos modelos concluída'), 'quem pediu é avisado');
create temp table batch_ids (k text primary key, v uuid);
insert into batch_ids select 'bom', ai.eval_save_batch('00000000-0000-4000-8000-000000000001', jsonb_build_object('model', 'x/bom', 'results',
  (select jsonb_agg(jsonb_build_object('case_key', 'c' || n, 'passed', n <> 10, 'outcome', case when n = 1 then 'HANDOFF' else 'DRAFT' end, 'flags', '[]'::jsonb, 'latency_ms', n * 1000, 'cost_usd', 0.01, 'tokens_in', 100, 'tokens_out', 10)) from generate_series(1, 10) n)));
insert into batch_ids select 'ruim', ai.eval_save_batch('00000000-0000-4000-8000-000000000001', jsonb_build_object('model', 'x/ruim', 'results',
  (select jsonb_agg(jsonb_build_object('case_key', 'c' || n, 'passed', n > 2, 'outcome', case when n = 1 then 'SEND' else 'DRAFT' end,
                                       'flags', case when n = 3 then '["UNGROUNDED_PRICE"]'::jsonb else '[]'::jsonb end, 'latency_ms', n * 500, 'cost_usd', 0.05, 'tokens_in', 100, 'tokens_out', 10)) from generate_series(1, 10) n)));
select is((select (cases, passed, factual_failures, handoff_misses)::text from ai.eval_batches where id = (select v from batch_ids where k = 'bom')), '(10,9,0,0)', 'lote bom: 9 de 10, sem número sem fundamento, sem erro de handoff');
select is((select (cases, passed, factual_failures, handoff_misses)::text from ai.eval_batches where id = (select v from batch_ids where k = 'ruim')), '(10,8,1,1)', 'lote ruim: número sem fundamento e handoff perdido');
select is((select (avg_latency_ms, p95_latency_ms)::text from ai.eval_batches where id = (select v from batch_ids where k = 'bom')), '(5500,10000)', 'latência média e p95');
select is((select cost_usd from ai.eval_batches where id = (select v from batch_ids where k = 'bom')), 0.1::numeric, 'custo somado');

-- ---------- Portão e ranking ----------
select is(private.eval_gate('00000000-0000-4000-8000-000000000001', 'conversation', 'x/bom') ->> 'ok', 'true', 'modelo que passou: liberado');
select ok(private.eval_gate('00000000-0000-4000-8000-000000000001', 'conversation', 'x/ruim') ->> 'reason' like '%sem fundamento%', 'modelo com número inventado: barrado, com o motivo');
select ok(private.eval_gate('00000000-0000-4000-8000-000000000001', 'conversation', 'x/novo') ->> 'reason' like 'rode a avaliação%', 'modelo sem avaliação: barrado');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((ai.eval_ranking('conversation') -> 0 ->> 'model'), 'x/bom', 'o ranking põe o melhor primeiro');
select is((ai.eval_ranking('conversation') -> 0 ->> 'gate_ok'), 'true', 'e mostra quem está liberado');

-- ---------- Portão na troca de modelo da rota (só vale para quem usa o sistema, não para o banco/worker) ----------
select throws_ok($$ update ai.model_routes set primary_model = 'x/ruim' where task = 'conversation' $$, 'P0240', null, 'a rota de atendimento não aceita modelo reprovado');
select throws_ok($$ update ai.model_routes set primary_model = 'x/novo' where task = 'conversation' $$, 'P0240', null, 'nem modelo que nunca foi avaliado');
select lives_ok($$ update ai.model_routes set primary_model = 'x/bom' where task = 'conversation' $$, 'modelo aprovado entra');
select lives_ok($$ update ai.model_routes set primary_model = 'x/qualquer' where task = 'classify' $$, 'as outras rotas não passam pelo portão');

select * from finish();
rollback;
