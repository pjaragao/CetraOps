begin;
create extension if not exists pgtap with schema extensions;
select plan(45);

create temp table ids (k text primary key, v text);
grant all on ids to agent_rpc, authenticated;

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
create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

-- ---------- Preparação: canal, conversa, catálogo ----------
insert into omni.channel_accounts (id, org_id, channel, provider_account_id, display_name, store_id, default_ai_mode)
values ('00000000-0000-4000-8000-0000000009a7', '00000000-0000-4000-8000-000000000001', 'WHATSAPP', 'PNID-CAT', 'WhatsApp (catálogo)', '00000000-0000-4000-8000-0000000000a1', 'AI_AUTOPILOT');
insert into ids select 'conv', (omni.ingest_event(jsonb_build_object('kind', 'MESSAGE', 'channel', 'WHATSAPP', 'provider_account_id', 'PNID-CAT', 'external_id', '5548911110070',
  'phone', '5548911110070', 'display_name', 'Clara Catálogo', 'provider_message_id', 'wamid.CAT1', 'body', 'Tem top com bolso?')))->>'conversation_id';
insert into ids select 'ctx', jsonb_build_object('org', '00000000-0000-4000-8000-000000000001', 'conv', (select v from ids where k = 'conv'),
  'party', (select party_id from omni.conversations where id = (select v from ids where k = 'conv')::uuid),
  'version', (select version from omni.conversations where id = (select v from ids where k = 'conv')::uuid),
  'caps', jsonb_build_array('search_catalog', 'check_stock_by_size', 'get_product_details', 'get_store_info', 'get_order_status'))::text;

-- o top: sem estoque, descrição do site com "bolso", composição, aviso de modelagem e guia de tamanho
update inv.stock_levels set on_hand = 0, reserved = 0 where variant_id in (select id from catalog.variants where product_id = '00000000-0000-4000-8000-000000000402');
insert into catalog.size_charts (id, org_id, name, measurements) values ('00000000-0000-4000-8000-0000000007c1', '00000000-0000-4000-8000-000000000001', 'Site: Teste',
  jsonb_build_object('html', '<p><strong>TABELA DE MEDIDAS</strong></p><table><tbody><tr><td><p><strong>Dimens&atilde;o (cm)</strong></p></td><td><p>&nbsp;P (36)</p></td></tr><tr><td>Busto</td><td><p>85-89 CM</p></td></tr></tbody></table>'));
update catalog.products set description = '<p>Top com bolso interno &amp; alças finas.</p>', composition = '90% Poliamida / 10% Elastano', backorder = false,
  size_chart_id = '00000000-0000-4000-8000-0000000007c1', custom_fields = custom_fields || '{"site": {"fit": "Modelagem menor que o padrão."}}'
where id = '00000000-0000-4000-8000-000000000402';
insert into catalog.product_media (org_id, product_id, color_id, storage_path, source_url, position)
select '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000402', v.color_id, 'https://cdn.shopify.com/top.jpg', 'https://cdn.shopify.com/top.jpg', 1
from catalog.variants v where v.product_id = '00000000-0000-4000-8000-000000000402' limit 1;

-- ---------- Utilitários ----------
select is(private.html_text('<p>Ol&aacute;<br>mundo</p>'), E'Olá\nmundo', 'HTML vira texto (quebra e acento)');
select ok(private.html_text((select measurements ->> 'html' from catalog.size_charts where id = '00000000-0000-4000-8000-0000000007c1')) like E'%| Busto | 85-89 CM |%', 'tabela de medidas vira linhas');
select is(private.sort_sizes(array['G', 'PP', 'M', 'GG', 'P', 'M']), array['PP', 'P', 'M', 'G', 'GG'], 'tamanhos na ordem da grade, sem repetir');
select is(private.order_status_label('READY_FOR_PICKUP'), 'pronto para retirar', 'situação do pedido em texto');

-- ---------- search_catalog ----------
select is(jsonb_array_length((pg_temp.agent_call('search_catalog', '{"query":"top bolso"}'))->'products'), 0, 'sem estoque e sem encomenda: não aparece');
select is((pg_temp.agent_call('search_catalog', '{"query":"top bolso", "in_stock_only": false}'))->'products'->0->>'availability', 'OUT_OF_STOCK', 'pedindo tudo, aparece como esgotado');
update catalog.products set backorder = true where id = '00000000-0000-4000-8000-000000000402';
select is((pg_temp.agent_call('search_catalog', '{"query":"top bolso"}'))->'products'->0->>'availability', 'BACKORDER', 'liberado para encomenda: aparece como encomendável');
select ok((pg_temp.agent_call('search_catalog', '{"query":"top bolso"}'))->>'hint' like '%request_handoff%', 'e orienta a transferir a encomenda');
select ok(jsonb_array_length((pg_temp.agent_call('search_catalog', '{"query":"top bolso"}'))->'products'->0->'backorder_sizes') > 0, 'com os tamanhos que podem ser encomendados');
select is((pg_temp.agent_call('search_catalog', '{"query":"poliamida"}'))->'products'->0->>'name', 'Top Demo Strappy', 'procura também na composição');
select is((pg_temp.agent_call('search_catalog', '{"query":"top bolso"}'))->'products'->0->>'fit_note', 'Modelagem menor que o padrão.', 'traz o aviso de modelagem');
select is((pg_temp.agent_call('search_catalog', '{"query":"top bolso"}'))->'products'->0->>'photo', 'https://cdn.shopify.com/top.jpg', 'foto ainda só no site: link de origem');
select is((pg_temp.agent_call('search_catalog', '{"query":"legging preta"}'))->'products'->0->>'name', 'Legging Demo Sculpt', 'busca antiga continua funcionando');
select is((pg_temp.agent_call('search_catalog', '{"query":"legging preta"}'))->'products'->0->>'availability', 'IN_STOCK', 'peça com estoque');
select ok(not ((pg_temp.agent_call('search_catalog', '{"query":"top bolso"}'))->'products'->0 ? 'site_compare_at'), 'preço "de" do site não vai para a IA das clientes');

-- ---------- check_stock_by_size ----------
select is((pg_temp.agent_call('check_stock_by_size', '{"product_id":"00000000-0000-4000-8000-000000000402"}'))->'variants'->0->>'backorder_ok', 'true', 'tamanho sem estoque de peça encomendável');
select is((pg_temp.agent_call('check_stock_by_size', jsonb_build_object('sku', 'DEMO-LEG01-PRT-M')))->'variants'->0->>'backorder_ok', 'false', 'peça com estoque não é encomenda');

-- ---------- get_product_details ----------
select is((pg_temp.agent_call('get_product_details', '{"product_id":"00000000-0000-4000-8000-000000000402"}'))->'product'->>'description', 'Top com bolso interno & alças finas.', 'descrição sem HTML');
select ok((pg_temp.agent_call('get_product_details', '{"product_id":"00000000-0000-4000-8000-000000000402"}'))->'product'->>'size_guide' like '%Busto%', 'guia de tamanho em texto');
select ok(jsonb_typeof((pg_temp.agent_call('get_product_details', '{"product_id":"00000000-0000-4000-8000-000000000402"}'))->'product'->'photos') = 'object', 'fotos por cor');
select is((pg_temp.agent_call('get_product_details', '{"product_id":"00000000-0000-4000-8000-000000000999"}'))->>'code', 'NOT_FOUND', 'produto inexistente');

-- ---------- get_store_info ----------
update core.stores set business_hours = '{}', address = '{}' where id = '00000000-0000-4000-8000-0000000000a1';
select is((pg_temp.agent_call('get_store_info'))->'stores'->0->>'hours_configured', 'false', 'loja sem horário cadastrado');
select ok((pg_temp.agent_call('get_store_info'))->>'hint' like '%não está cadastrado%', 'e a IA é orientada a não inventar');
update core.stores set business_hours = '{"days":{"0":[["10:00","18:00"]],"1":[["10:00","19:00"]],"2":[["10:00","19:00"]],"3":[["10:00","19:00"]],"4":[["10:00","19:00"]],"5":[["10:00","19:00"]],"6":[["09:00","14:00"]]}}',
       address = '{"street": "Rua da Loja", "number": "10", "city": "Florianópolis"}' where id = '00000000-0000-4000-8000-0000000000a1';
select is(jsonb_array_length((pg_temp.agent_call('get_store_info'))->'stores'->0->'next_7_days'), 7, 'horário dos próximos 7 dias');
select is((pg_temp.agent_call('get_store_info'))->'stores'->0->'address'->>'street', 'Rua da Loja', 'endereço da loja (não o da empresa)');
select ok(not ((pg_temp.agent_call('get_store_info')) ? 'hint'), 'tudo cadastrado: sem aviso');

-- ---------- Fotos guardadas no Storage ----------
select is(jsonb_array_length(catalog.media_to_mirror('00000000-0000-4000-8000-000000000001')), (select count(*)::int from catalog.product_media where storage_path like 'http%' and source_url is not null), 'fotos só no link entram na fila de cópia');
select throws_ok($$ select catalog.set_media_mirror((select id from catalog.product_media where source_url = 'https://cdn.shopify.com/top.jpg'), '../fora/x.jpg') $$, 'P0340', null, 'caminho fora da pasta da organização é recusado');
select lives_ok($$ select catalog.set_media_mirror((select id from catalog.product_media where source_url = 'https://cdn.shopify.com/top.jpg'), '00000000-0000-4000-8000-000000000001/DEMO-TOP01/x/abc.jpg', 'abc', 1000) $$, 'cópia confirmada');
select is((pg_temp.agent_call('search_catalog', '{"query":"top bolso"}'))->'products'->0->>'photo', 'https://cdn.shopify.com/top.jpg', 'sem endereço público do bucket, a IA continua com o link do site');
insert into core.settings (org_id, key, value) values ('00000000-0000-4000-8000-000000000001', 'catalog_media', '{"public_base_url": "https://loja.exemplo/"}')
on conflict (org_id, key) do update set value = excluded.value;
select is((pg_temp.agent_call('search_catalog', '{"query":"top bolso"}'))->'products'->0->>'photo',
  'https://loja.exemplo/storage/v1/object/public/catalog-media/00000000-0000-4000-8000-000000000001/DEMO-TOP01/x/abc.jpg', 'com endereço público, a foto sai do bucket');

-- a sincronização do site não refaz a cópia já guardada
select lives_ok($$ select catalog.upsert_site_product(jsonb_build_object('org_id', '00000000-0000-4000-8000-000000000001', 'model_code', '99070', 'external_id', 'ext-70', 'handle', 'short-teste-foto', 'title', 'Short Teste Foto',
  'model_name', 'Short Teste Foto', 'color_code', '070', 'color_name', 'Cor Teste 70', 'category', 'Short', 'variants', jsonb_build_array(jsonb_build_object('sku', '99070070P', 'size', 'P', 'price', 100)),
  'images', jsonb_build_array('https://cdn.shopify.com/a.jpg', 'https://cdn.shopify.com/b.jpg'))) $$, 'produto do site com 2 fotos');
select lives_ok($$ select catalog.set_media_mirror((select id from catalog.product_media where source_url = 'https://cdn.shopify.com/a.jpg'), '00000000-0000-4000-8000-000000000001/99070/070/a.jpg') $$, 'primeira foto copiada');
select lives_ok($$ select catalog.upsert_site_product(jsonb_build_object('org_id', '00000000-0000-4000-8000-000000000001', 'model_code', '99070', 'external_id', 'ext-70', 'handle', 'short-teste-foto', 'title', 'Short Teste Foto',
  'model_name', 'Short Teste Foto', 'color_code', '070', 'color_name', 'Cor Teste 70', 'category', 'Short', 'variants', jsonb_build_array(jsonb_build_object('sku', '99070070P', 'size', 'P', 'price', 100)),
  'images', jsonb_build_array('https://cdn.shopify.com/c.jpg', 'https://cdn.shopify.com/a.jpg'))) $$, 'o site troca uma foto e muda a ordem');
select is((select storage_path || '#' || position from catalog.product_media where source_url = 'https://cdn.shopify.com/a.jpg'), '00000000-0000-4000-8000-000000000001/99070/070/a.jpg#2', 'a cópia guardada fica, na nova posição');
select is((select count(*)::int from catalog.product_media where source_url in ('https://cdn.shopify.com/b.jpg', 'https://cdn.shopify.com/c.jpg')), 1, 'a foto que saiu do site é tirada; a nova entra para copiar');

-- ---------- Central ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((catalog.search_products('{"query":"bolso"}'))->0->>'backorder', 'true', 'Central acha pela descrição e sabe que é encomendável');
select ok((catalog.search_products('{"query":"bolso"}'))->0->'photo' ? 'path', 'com a foto');
select ok((sales.backorder_overview()) ? 'counts' and (inv.loans_overview()) ? 'overdue' and jsonb_typeof(catalog.recent_price_changes()) = 'array', 'consultas de encomendas, malinhas e preços');
select lives_ok($$ select ai.daily_briefing() $$, 'resumo do dia com os itens novos');
reset role;
select ok(pg_get_functiondef('private.assistant_dispatch(ai.assistant_actions)'::regprocedure) like '%sales.create_backorder%'
          and private.assistant_tool_perm('malinha') = 'sales.write', 'cartões de encomenda e malinha');

-- ---------- Base de conhecimento a partir do catálogo ----------
insert into catalog.site_items (org_id, external_id, handle, title, product_id) values ('00000000-0000-4000-8000-000000000001', 'kb-70', 'kb-70', 'KB', '00000000-0000-4000-8000-000000000402');
select is((private.draft_catalog_knowledge('00000000-0000-4000-8000-000000000001')) ->> 'Modelagens que vestem menor', 'CREATED', 'rascunho das modelagens que vestem menor');
select is((select status from ai.knowledge_docs where title = 'Guia de tamanhos — Teste'), 'DRAFT', 'guia de tamanho vira rascunho (a IA não lê rascunho)');
update ai.knowledge_docs set status = 'PUBLISHED', body_md = 'texto publicado', version = 1 where title = 'Modelagens que vestem menor';
update catalog.products set custom_fields = custom_fields || '{"site": {"fit": "Veste bem menor."}}' where id = '00000000-0000-4000-8000-000000000402';
select is((private.draft_catalog_knowledge('00000000-0000-4000-8000-000000000001')) ->> 'Modelagens que vestem menor', 'UPDATED', 'catálogo mudou: o rascunho acompanha');
select is((select body_md from ai.knowledge_docs where title = 'Modelagens que vestem menor'), 'texto publicado', 'e o texto publicado só muda quando alguém publicar');

select * from finish();
rollback;
