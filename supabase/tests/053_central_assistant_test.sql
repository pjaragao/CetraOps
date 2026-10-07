begin;
create extension if not exists pgtap with schema extensions;
select plan(55);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
create temp table ids (k text primary key, v uuid);
create temp table kv (k text primary key, v jsonb);
grant all on ids, kv to authenticated;

update sales.cash_sessions set status = 'CLOSED', closed_at = now() where status = 'OPEN';
insert into sales.coupons (org_id, code, kind, value) values ('00000000-0000-4000-8000-000000000001', 'CENTRAL10', 'PERCENT', 10);

-- ---------- Configuração ----------
select ok(exists (select 1 from core.role_permissions rp join core.roles r on r.id = rp.role_id where r.key = 'seller' and rp.permission_key = 'ai.assistant'), 'vendedora pode usar a Central');
select is((select count(*)::int from ai.model_routes where org_id = '00000000-0000-4000-8000-000000000001' and task in ('assistant', 'vision_extract')), 2, 'rotas da Central e da leitura de documentos');
select ok(exists (select 1 from vault.secrets where name = 'crm_cpf_key'), 'chave do CPF no Vault');

-- ---------- CPF da cliente ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora: crm.write, sem crm.sensitive
insert into ids select 'ana', crm.quick_customer('48988887777', 'Ana Paula Souza (teste)', false);
insert into ids select 'ana2', crm.quick_customer('48911112222', 'Ana Beatriz Lima (teste)', false);
select throws_ok($$ select crm.set_cpf((select v from ids where k = 'ana'), '390.533.447-04') $$, 'P0470', null, 'CPF com dígito errado é recusado');
select throws_ok($$ select crm.set_cpf((select v from ids where k = 'ana'), '111.111.111-11') $$, 'P0470', null, 'CPF de dígitos repetidos é recusado');
select is(crm.set_cpf((select v from ids where k = 'ana'), '390.533.447-05') ->> 'cpf_last4', '4705', 'grava o CPF e devolve só o final');
select is((crm.find_by_cpf('39053344705') ->> 'party_id')::uuid, (select v from ids where k = 'ana'), 'acha a cliente pelo CPF');
select is(crm.find_by_cpf('16899535009') ->> 'found', 'false', 'CPF que não está no cadastro');
select throws_ok($$ select crm.set_cpf((select v from ids where k = 'ana2'), '39053344705') $$, 'P0471', null, 'o mesmo CPF não vai para outra pessoa');
select throws_ok($$ select crm.set_cpf((select v from ids where k = 'ana'), '16899535009') $$, '42501', null, 'trocar um CPF já gravado exige dados sensíveis');
reset role;
select ok((select cpf_encrypted is not null and position('39053344705' in encode(cpf_encrypted, 'escape')) = 0 and cpf_hmac !~ '39053344705'
           from crm.party_sensitive where party_id = (select v from ids where k = 'ana')), 'CPF guardado criptografado (nem o texto nem o HMAC trazem o número)');
select is(private.party_cpf((select v from ids where k = 'ana')), '39053344705', 'a nota fiscal consegue o CPF completo');
select ok(exists (select 1 from audit.log where table_name = 'crm.party_sensitive' and record_id = (select v from ids where k = 'ana')::text and action = 'CPF_SET'
                  and after ->> 'cpf_last4' = '4705' and after::text !~ '390533'), 'auditoria registra só o final do CPF');

-- ---------- Buscas ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is(jsonb_array_length(crm.search_people('ana souza')), 1, 'busca por nome sem acento e em minúsculas');
select ok(jsonb_array_length(crm.search_people('Ana')) >= 2, 'homônimas aparecem para a pessoa escolher');
select is(crm.search_people('390.533.447-05') -> 0 ->> 'party_id', (select v from ids where k = 'ana')::text, 'busca pelo CPF');
select is(crm.search_people('7777') -> 0 ->> 'party_id', (select v from ids where k = 'ana')::text, 'busca pelo final do telefone');
select is(crm.search_people('7777') -> 0 ->> 'phone_last4', '7777', 'mostra o final do telefone para diferenciar');
select ok((crm.search_people('7777') -> 0) ? 'cpf_last4', 'mostra o final do CPF, nunca o número');
insert into kv select 'leg', catalog.search_products(jsonb_build_object('query', 'legging', 'color', 'preta', 'size', 'g', 'store_id', '00000000-0000-4000-8000-0000000000a1'));
select is((select jsonb_array_length(v -> 0 -> 'variants') from kv where k = 'leg'), 1, 'texto + cor + tamanho chegam numa variante');
select is((select v -> 0 -> 'variants' -> 0 ->> 'sku' from kv where k = 'leg'), 'DEMO-LEG01-PRT-G', 'legging preta G');
select is((select (v -> 0 -> 'variants' -> 0 ->> 'price')::numeric from kv where k = 'leg'), 429.00, 'com o preço vigente');
select is(catalog.search_products(jsonb_build_object('code', 'demo-tee01-prt-m')) -> 0 -> 'variants' -> 0 ->> 'sku', 'DEMO-TEE01-PRT-M', 'SKU exato (bipado ou digitado)');

-- ---------- Prévia de venda ----------
insert into kv select 'q', sales.quote_order(jsonb_build_object('store_id', '00000000-0000-4000-8000-0000000000a1', 'coupon_code', 'central10', 'items', jsonb_build_array(
  jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-G'), 'qty', 1),
  jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-PRT-M'), 'qty', 2))));
select is((select (v ->> 'subtotal')::numeric from kv where k = 'q'), 927.00, 'subtotal: 429 + 2 × 249');
select is((select (v ->> 'total')::numeric from kv where k = 'q'), 834.30, 'cupom de 10% aplicado como no PDV');
select is((select jsonb_array_length(v -> 'warnings') from kv where k = 'q'), 0, 'sem avisos');
select ok((sales.quote_order(jsonb_build_object('store_id', '00000000-0000-4000-8000-0000000000a1', 'items', jsonb_build_array(
  jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-G'), 'qty', 50)))) -> 'warnings' ->> 0) like '%disponível%', 'avisa quando falta estoque');
select is(sales.quote_order(jsonb_build_object('store_id', '00000000-0000-4000-8000-0000000000a1', 'coupon_code', 'NAOEXISTE', 'items', jsonb_build_array(
  jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-LEG01-PRT-G'), 'qty', 1)))) -> 'warnings' ->> 0, 'Cupom inválido ou expirado', 'cupom inválido vira aviso');

-- ---------- Propor e executar: venda para cliente cadastrada ----------
select throws_ok($$ select ai.assistant_propose(jsonb_build_object('tool', 'apagar_tudo', 'args', '{}'::jsonb)) $$, 'P0460', null, 'ação fora da lista fechada');
select throws_ok($$ select ai.assistant_propose(jsonb_build_object('tool', 'conta_pagar', 'args', '{}'::jsonb)) $$, '42501', null, 'vendedora não propõe conta a pagar');
insert into ids select 'a1', (ai.assistant_propose(jsonb_build_object('tool', 'venda_pdv', 'summary', 'Venda para Ana', 'preview', (select v from kv where k = 'q'), 'args', jsonb_build_object(
  'store_id', '00000000-0000-4000-8000-0000000000a1', 'party_id', (select v from ids where k = 'ana'), 'coupon_code', 'CENTRAL10', 'cpf_on_invoice', true,
  'items', (select v -> 'items' from kv where k = 'q'), 'payments', jsonb_build_array(jsonb_build_object('method', 'PIX', 'amount', 834.30)))))).id;
select is((select status from ai.assistant_actions where id = (select v from ids where k = 'a1')), 'PROPOSED', 'a proposta não grava a venda');
select is((select count(*)::int from sales.orders where idempotency_key = (select idempotency_key::text from ai.assistant_actions where id = (select v from ids where k = 'a1'))), 0, 'nenhum pedido antes do clique');
insert into kv select 'r1', ai.assistant_execute((select v from ids where k = 'a1'));
select is((select v ->> 'ok' from kv where k = 'r1'), 'true', 'a pessoa confirma e a venda acontece');
select is((select o.total from sales.orders o where o.id = (select (v -> 'result' ->> 'target_id')::uuid from kv where k = 'r1')), 834.30, 'total do pedido = total do cartão');
select is((select o.cpf_on_invoice from sales.orders o where o.id = (select (v -> 'result' ->> 'target_id')::uuid from kv where k = 'r1')), '39053344705', 'CPF da cliente na NFC-e sem passar pela IA');
select is((select o.attribution ->> 'assisted_by' from sales.orders o where o.id = (select (v -> 'result' ->> 'target_id')::uuid from kv where k = 'r1')), 'CENTRAL', 'venda marcada como feita pela Central');
select is((ai.assistant_execute((select v from ids where k = 'a1')) ->> 'already'), 'true', 'clicar de novo não duplica a venda');
select is((select count(*)::int from sales.orders where idempotency_key = (select idempotency_key::text from ai.assistant_actions where id = (select v from ids where k = 'a1'))), 1, 'um único pedido');

-- ---------- Venda para cliente nova com CPF ----------
insert into kv select 'q2', sales.quote_order(jsonb_build_object('store_id', '00000000-0000-4000-8000-0000000000a1', 'items', jsonb_build_array(
  jsonb_build_object('variant_id', (select id from catalog.variants where sku = 'DEMO-TEE01-OFW-P'), 'qty', 1))));
insert into ids select 'a2', (ai.assistant_propose(jsonb_build_object('tool', 'venda_pdv', 'preview', (select v from kv where k = 'q2'), 'args', jsonb_build_object(
  'store_id', '00000000-0000-4000-8000-0000000000a1', 'cpf_on_invoice', true,
  'new_party', jsonb_build_object('display_name', 'Juliana Costa (teste)', 'phone', '48 99876-4321', 'cpf', '168.995.350-09', 'marketing_whatsapp', true),
  'items', (select v -> 'items' from kv where k = 'q2'), 'payments', jsonb_build_array(jsonb_build_object('method', 'DEBIT', 'amount', 249, 'acquirer', 'STONE')))))).id;
insert into kv select 'r2', ai.assistant_execute((select v from ids where k = 'a2'));
select is((select v ->> 'ok' from kv where k = 'r2'), 'true', 'cadastro + venda numa transação só');
select is((crm.find_by_cpf('16899535009') ->> 'display_name'), 'Juliana Costa (teste)', 'cliente nova encontrada pelo CPF depois');
select is((select o.cpf_on_invoice from sales.orders o where o.id = (select (v -> 'result' ->> 'target_id')::uuid from kv where k = 'r2')), '16899535009', 'CPF da cliente nova na nota');
select ok(exists (select 1 from crm.v_current_consents c where c.party_id = (select (v -> 'result' ->> 'party_id')::uuid from kv where k = 'r2')
                  and c.purpose = 'MARKETING_WHATSAPP' and c.granted), 'aceite de marketing registrado como ela respondeu');

-- ---------- Falhas registradas, sem meio-termo ----------
insert into ids select 'a3', (ai.assistant_propose(jsonb_build_object('tool', 'venda_pdv', 'preview', jsonb_build_object('total', 1), 'args', jsonb_build_object(
  'store_id', '00000000-0000-4000-8000-0000000000a1', 'new_party', jsonb_build_object('display_name', 'Não Deveria Existir (teste)'),
  'items', (select v -> 'items' from kv where k = 'q2'), 'payments', jsonb_build_array(jsonb_build_object('method', 'PIX', 'amount', 1)))))).id;
select is((ai.assistant_execute((select v from ids where k = 'a3')) ->> 'code'), 'P0461', 'total diferente do cartão: não executa');
select is((select status from ai.assistant_actions where id = (select v from ids where k = 'a3')), 'FAILED', 'e fica registrado como recusado');
select is((select count(*)::int from crm.parties where display_name = 'Não Deveria Existir (teste)'), 0, 'o cadastro da tentativa foi desfeito junto');
insert into ids select 'a4', (ai.assistant_propose(jsonb_build_object('tool', 'tarefa', 'args', jsonb_build_object('title', 'Ligar para a Ana', 'party_id', (select v from ids where k = 'ana'))))).id;
reset role;
update ai.assistant_actions set expires_at = now() - interval '1 minute' where id = (select v from ids where k = 'a4');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is((ai.assistant_execute((select v from ids where k = 'a4')) ->> 'code'), 'EXPIRED', 'cartão vencido não executa');
insert into ids select 'a5', (ai.assistant_propose(jsonb_build_object('tool', 'tarefa', 'args', jsonb_build_object('title', 'Ligar para a Ana', 'party_id', (select v from ids where k = 'ana'))))).id;
select ai.assistant_cancel((select v from ids where k = 'a5'));
select throws_ok($$ select ai.assistant_execute((select v from ids where k = 'a5')) $$, 'P0461', null, 'cancelado não executa');

-- ---------- Cada um só vê e confirma as próprias ações ----------
insert into ids select 'a6', (ai.assistant_propose(jsonb_build_object('tool', 'tarefa', 'args', jsonb_build_object('title', 'Mandar fotos do drop', 'party_id', (select v from ids where k = 'ana'))))).id;
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
select throws_ok($$ select ai.assistant_execute((select v from ids where k = 'a6')) $$, 'P0462', null, 'ninguém confirma a ação proposta para outra pessoa');
select is((select count(*)::int from ai.assistant_actions where id = (select v from ids where k = 'a6')), 0, 'nem vê a ação dos outros');

-- ---------- Baixa acima do teto vai para a tela ----------
insert into ids select 'tit', (fin.create_title(jsonb_build_object('direction', 'PAYABLE', 'legal_entity_id', '00000000-0000-4000-8000-0000000000e1', 'description', 'Fornecedor grande (teste)',
  'approval_status', 'APPROVED', 'installments', jsonb_build_array(jsonb_build_object('due_date', current_date, 'amount', 9000))))).id;
insert into ids select 'a7', (ai.assistant_propose(jsonb_build_object('tool', 'baixa', 'args', jsonb_build_object(
  'installment_id', (select id from fin.title_installments where title_id = (select v from ids where k = 'tit')))))).id;
select is((ai.assistant_execute((select v from ids where k = 'a7')) ->> 'code'), 'P0461', 'baixa acima do teto da política não sai pela Central');

-- ---------- Custos e rotas ----------
select is((ai.assistant_route('assistant') ->> 'available'), 'true', 'rota disponível');
select throws_ok($$ select ai.assistant_route('persona_style') $$, 'P0460', null, 'a Central não usa rotas que não são dela');
select lives_ok($$ insert into ids select 'run', ai.assistant_log_run(jsonb_build_object('task', 'assistant', 'model', 'teste/modelo', 'tokens_in', 1000, 'tokens_out', 200, 'cost_usd', 0.01,
  'tool_calls', jsonb_build_array(jsonb_build_object('tool', 'contas_a_pagar', 'args', '{}'::jsonb, 'result', '{"ok": true}'::jsonb, 'ok', true, 'ms', 12)))) $$, 'registra o custo da conversa');
reset role;
select is((select member_id from ai.runs where id = (select v from ids where k = 'run')), (select id from core.members where user_id = '00000000-0000-4000-8000-0000000000f1'), 'custo por pessoa');
select is((select count(*)::int from ai.tool_calls where run_id = (select v from ids where k = 'run')), 1, 'e por ferramenta');

select * from finish();
rollback;
