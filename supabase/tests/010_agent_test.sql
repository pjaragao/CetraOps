begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

create temp table ids (k text primary key, v text);
grant all on ids to agent_rpc;

-- Executa como a role do servidor MCP (agent_rpc) e devolve o resultado (ou o erro) em jsonb; as asserções rodam como dono
create or replace function pg_temp.agent_call(p_tool text, p_args jsonb default '{}', p_ctx jsonb default null) returns jsonb
language plpgsql as $f$
declare r jsonb; v_ctx jsonb := coalesce(p_ctx, (select v::jsonb from ids where k = 'ctx'));
begin
  set local role agent_rpc;
  begin
    r := agent.call_tool(v_ctx, p_tool, p_args);
  exception when others then
    reset role;
    return jsonb_build_object('__error', sqlstate, '__msg', sqlerrm);
  end;
  reset role;
  return r;
end $f$;
create or replace function pg_temp.agent_sql(p_sql text) returns text
language plpgsql as $f$
begin
  set local role agent_rpc;
  begin
    execute p_sql;
  exception when others then
    reset role;
    return sqlstate;
  end;
  reset role;
  return 'ok';
end $f$;

-- ---------- Preparação (como dono do banco): canal, cliente, conversa e execução de IA ----------
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode)
values ('00000000-0000-4000-8000-0000000009a1', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PNID-AGENT', 'WhatsApp (teste do agente)', '00000000-0000-4000-8000-0000000000a1', 'AI_AUTOPILOT');
insert into ids select 'conv', (omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-AGENT', 'external_id', '5548988887777',
  'phone', '5548988887777', 'display_name', 'Beatriz Souza (teste)', 'provider_message_id', 'wamid.AG1', 'body', 'Oi! Queria uma legging preta M')))->>'conversation_id';
insert into ids select 'party', party_id::text from omni.conversations where id = (select v from ids where k = 'conv')::uuid;
insert into ids select 'msg', id::text from omni.messages where provider_message_id = 'wamid.AG1';
insert into ai.runs (id, org_id, route_task, conversation_id, party_id) values ('00000000-0000-4000-8000-0000000009d1', '00000000-0000-4000-8000-000000000001', 'conversation',
  (select v from ids where k = 'conv')::uuid, (select v from ids where k = 'party')::uuid);
insert into ids select 'ctx', jsonb_build_object('org', '00000000-0000-4000-8000-000000000001', 'conv', (select v from ids where k = 'conv'), 'party', (select v from ids where k = 'party'),
  'run', '00000000-0000-4000-8000-0000000009d1', 'version', (select version from omni.conversations where id = (select v from ids where k = 'conv')::uuid),
  'caps', jsonb_build_array('search_catalog', 'check_stock_by_size', 'get_customer_360', 'get_order_status', 'get_policies', 'apply_coupon', 'create_reservation', 'schedule_locker',
    'create_order_draft', 'confirm_order_draft', 'create_payment_link', 'register_consent', 'update_customer_profile', 'remember_customer_fact', 'request_handoff', 'propose_reply'))::text;
insert into ids select 'other_party', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '5548977776666', 'Outra Cliente (teste)', 'TEST')::text;
insert into sales.coupons (org_id, code, kind, value) values ('00000000-0000-4000-8000-000000000001', 'AGENTE5', 'PERCENT', 5);


-- ---------- Barreiras ----------
select is(pg_temp.agent_sql('select count(*) from crm.parties'), '42501', 'agent_rpc não lê tabelas');
select is(pg_temp.agent_sql('select * from ai.tool_calls'), '42501', 'agent_rpc não lê o registro de chamadas');
select is((pg_temp.agent_call('search_catalog', '{"query":"legging"}', (select v::jsonb || jsonb_build_object('party', (select v from ids where k = 'other_party')) from ids where k = 'ctx')))->>'__error', '42501', 'conversa que não é daquela cliente é recusada');
select is((pg_temp.agent_call('create_order_draft', '{}', (select v::jsonb || jsonb_build_object('caps', jsonb_build_array('search_catalog')) from ids where k = 'ctx')))->>'__error', '42501', 'ferramenta fora das permitidas do contexto');
select is((pg_temp.agent_call('nao_existe', '{}'))->>'__error', '42501', 'ferramenta que não está entre as permitidas é recusada');
select is((pg_temp.agent_call('nao_existe', '{}', (select v::jsonb || jsonb_build_object('caps', jsonb_build_array('nao_existe')) from ids where k = 'ctx')))->>'code', 'UNKNOWN_TOOL', 'ferramenta desconhecida (mesmo liberada) volta como dado');

-- ---------- Leitura ----------
select is((pg_temp.agent_call('search_catalog', '{"query":"legging preta"}'))->'products'->0->>'name', 'Legging Demo Sculpt', 'busca no catálogo por nome e cor');
select is(((pg_temp.agent_call('search_catalog', '{"query":"legging preta"}'))->'products'->0->>'price')::numeric, 429.00, 'preço vem do banco');
select is(jsonb_array_length((pg_temp.agent_call('search_catalog', '{"query":"produto que nao existe xyz"}'))->'products'), 0, 'sem resultado: lista vazia');
select is(jsonb_array_length((pg_temp.agent_call('check_stock_by_size', jsonb_build_object('sku', 'DEMO-LEG01-PRT-M')))->'variants'), 1, 'estoque por SKU');
select is(((pg_temp.agent_call('check_stock_by_size', jsonb_build_object('sku', 'DEMO-LEG01-PRT-M')))->'variants'->0->>'available')::numeric, 5.000, 'disponível = 5');
select is((pg_temp.agent_call('get_customer_360', '{}'))->'customer'->>'first_name', 'Beatriz', 'cliente 360: só o primeiro nome');
select is(((pg_temp.agent_call('get_customer_360', '{}'))->'customer') ?| array['cpf', 'address', 'phone', 'email'], false, 'cliente 360 sem CPF, endereço ou contatos');
select is((pg_temp.agent_call('get_order_status', jsonb_build_object('party_id', (select v from ids where k = 'other_party'))))->>'code', 'NOT_FOUND', 'ID de cliente vindo do modelo é ignorado');
select is((pg_temp.agent_call('get_policies', '{"topic":"troca"}'))->>'ok', 'true', 'política de troca disponível');
select is((pg_temp.agent_call('get_policies', '{"topic":"inexistente"}'))->>'code', 'NOT_FOUND', 'tema sem política: encaminhar para humano');
select is((pg_temp.agent_call('apply_coupon', '{"code":"agente5","subtotal":200}'))->'coupon'->>'discount', '10.00', 'cupom válido: 5% de R$ 200');
select is((pg_temp.agent_call('apply_coupon', '{"code":"NAOEXISTE","subtotal":200}'))->>'ok', 'false', 'cupom inválido');

-- ---------- Retenção com limites ----------
select is((pg_temp.agent_call('create_reservation', jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-M'), 'qty', 1)))->>'ok', 'true', 'retém 1 peça');
select is((pg_temp.agent_call('create_reservation', jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-P'), 'qty', 3)))->>'code', 'LIMIT', 'no máximo 2 peças iguais');
select pg_temp.agent_call('create_reservation', jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-P'), 'qty', 1));
select pg_temp.agent_call('create_reservation', jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-G'), 'qty', 1));
select is((pg_temp.agent_call('create_reservation', jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-GG'), 'qty', 1)))->>'code', 'P0094', 'a IA retém no máximo 3 itens por cliente');

-- ---------- Pedido: rascunho → confirmação da cliente → link ----------
select is((pg_temp.agent_call('create_order_draft', jsonb_build_object('shipping_total', 15,
  'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-M'), 'qty', 1)))))->>'total', '264.00', 'rascunho: R$ 249 + frete R$ 15 (calculado no banco)');
insert into ids select 'order', (pg_temp.agent_call('create_order_draft', jsonb_build_object('shipping_total', 15,
  'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-M'), 'qty', 1)))))->>'order_id';
select is((select count(*)::int from sales.orders where id = (select v from ids where k = 'order')::uuid and assisted_by_ai and status::text = 'DRAFT'), 1, 'o mesmo rascunho é reaproveitado (idempotente na execução)');
select is((pg_temp.agent_call('create_payment_link', jsonb_build_object('order_id', (select v from ids where k = 'order'))))->>'code', 'NOT_CONFIRMED', 'sem confirmação da cliente não há link');
select is((pg_temp.agent_call('confirm_order_draft', jsonb_build_object('order_id', (select v from ids where k = 'order'), 'customer_message_id', '00000000-0000-4000-8000-000000000000')))->>'code', 'NO_CONFIRMATION', 'a confirmação precisa ser mensagem real da cliente');
select is((pg_temp.agent_call('confirm_order_draft', jsonb_build_object('order_id', (select v from ids where k = 'order'), 'customer_message_id', (select v from ids where k = 'msg'))))->>'status', 'PENDING_PAYMENT', 'pedido confirmado aguarda pagamento');
select is((pg_temp.agent_call('create_payment_link', jsonb_build_object('order_id', (select v from ids where k = 'order'), 'max_installments', 3)))->>'ok', 'true', 'link gerado só depois da confirmação');
select is((pg_temp.agent_call('create_order_draft', jsonb_build_object(
  'items', jsonb_build_array(jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-OFW-M'), 'qty', 4)))))->>'code', 'HIGH_VALUE', 'pedido acima de R$ 1.500 vai para humano');

-- ---------- Perfil, memória, consentimento ----------
select is((pg_temp.agent_call('update_customer_profile', '{"sizes":{"bottom":"M","cpf":"123"},"city":"Florianópolis"}'))->>'ok', 'true', 'atualiza tamanho e cidade');
select is((pg_temp.agent_call('remember_customer_fact', jsonb_build_object('fact', 'Faz pilates às terças', 'category', 'ROTINA', 'message_id', (select v from ids where k = 'msg'))))->>'ok', 'true', 'guarda um fato com evidência');
select is((pg_temp.agent_call('register_consent', '{"purpose":"MARKETING_WHATSAPP","granted":true}'))->>'ok', 'true', 'registra consentimento de marketing');
select is((pg_temp.agent_call('register_consent', '{"purpose":"TRANSACTIONAL","granted":false}'))->>'code', 'INVALID', 'não deixa a IA mexer em consentimento transacional');

-- ---------- Saída e transferência ----------
select is((pg_temp.agent_call('propose_reply', '{"messages":[],"confidence":0.9}'))->>'code', 'INVALID', 'resposta vazia é recusada');
select is((pg_temp.agent_call('propose_reply', '{"messages":["oi","tudo bem?"],"confidence":0.9,"intent":"STOCK"}'))->>'accepted', 'true', 'proposta de resposta aceita');
select is((pg_temp.agent_call('request_handoff', '{"reason_code":"PRICE_NEGOTIATION","summary":"Cliente quer desconto","urgency":"NORMAL"}'))->>'ok', 'true', 'pede humano');

select is((select mode::text from omni.conversations where id = (select v from ids where k = 'conv')::uuid), 'WAITING_HUMAN', 'a conversa foi para a fila de humanos');
select cmp_ok((select count(*)::int from ai.tool_calls where run_id = '00000000-0000-4000-8000-0000000009d1'), '>=', 25, 'todas as chamadas ficam registradas com o resultado completo');

select * from finish();
rollback;
