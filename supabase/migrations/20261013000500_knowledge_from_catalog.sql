-- =====================================================================
-- Base de conhecimento: rascunhos montados a partir do catálogo
--  • ai.draft_catalog_knowledge(): gera/atualiza RASCUNHOS com o que o catálogo já sabe — guia de tamanhos (texto da tabela do site),
--    modelagens que vestem menor, tecidos (composições e peças), linhas e categorias, cuidados (o que o site trouxe) e como funciona
--    a encomenda. A IA só lê o texto PUBLICADO: nada disso chega às clientes antes de uma pessoa revisar e publicar.
--  • Documento já publicado: só o rascunho é atualizado (a equipe vê a diferença e decide); arquivado não é tocado.
--  • Onde falta informação da loja (prazo da encomenda, cuidados por tecido), o texto traz [A CONFIRMAR …] para a equipe preencher.
-- =====================================================================

create or replace function private.upsert_knowledge_draft(p_org uuid, p_title text, p_kind text, p_body text) returns text
language plpgsql security definer set search_path = '' as $$
declare d ai.knowledge_docs;
begin
  if coalesce(trim(p_body), '') = '' then return 'EMPTY'; end if;
  select * into d from ai.knowledge_docs where org_id = p_org and title = p_title order by created_at limit 1;
  if d.id is null then
    insert into ai.knowledge_docs (org_id, title, kind, draft_md) values (p_org, p_title, p_kind, left(p_body, 20000));
    return 'CREATED';
  elsif d.status = 'ARCHIVED' then
    return 'SKIPPED';
  elsif d.draft_md is distinct from left(p_body, 20000) then
    update ai.knowledge_docs set draft_md = left(p_body, 20000), updated_at = now() where id = d.id;
    return 'UPDATED';
  end if;
  return 'SAME';
end $$;

create or replace function private.draft_catalog_knowledge(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record; v_body text; v_out jsonb := '{}';
  v_note text := E'\n\n---\n_Rascunho montado a partir do catálogo em ' || to_char(private.today_sp(), 'DD/MM/YYYY') || '. Revise antes de publicar._';
begin
  -- 1) Guias de tamanho (um documento por tabela do site)
  for r in select sc.name, private.html_text(sc.measurements ->> 'html') as txt,
                  (select string_agg(distinct cat.name, ', ' order by cat.name) from catalog.products p left join catalog.categories cat on cat.id = p.category_id
                   where p.size_chart_id = sc.id and p.status = 'ACTIVE') as cats
           from catalog.size_charts sc where sc.org_id = p_org and sc.measurements ? 'html' loop
    continue when r.txt is null;
    v_body := '# Guia de tamanhos — ' || regexp_replace(r.name, '^Site: ', '') || E'\n\n' ||
              'Como escolher: meça o corpo e compare com a tabela (medidas em centímetros, aproximadas, podem variar um pouco por modelo). ' ||
              'Se a medida ficar entre dois tamanhos: [A CONFIRMAR a orientação da marca]. ' ||
              E'Algumas peças vestem menor que o padrão: veja o documento "Modelagens que vestem menor".\n\n' ||
              r.txt || coalesce(E'\n\nVale para: ' || r.cats || '.', '') || v_note;
    v_out := v_out || jsonb_build_object('Guia de tamanhos — ' || regexp_replace(r.name, '^Site: ', ''),
                                         private.upsert_knowledge_draft(p_org, 'Guia de tamanhos — ' || regexp_replace(r.name, '^Site: ', ''), 'FAQ', v_body));
  end loop;

  -- 2) Modelagens que vestem menor
  select string_agg('- ' || p.name || ' (ref. ' || p.reference_code || '): ' || (p.custom_fields -> 'site' ->> 'fit'), E'\n' order by p.name) into v_body
  from catalog.products p where p.org_id = p_org and p.status = 'ACTIVE' and nullif(p.custom_fields -> 'site' ->> 'fit', '') is not null;
  if v_body is not null then
    v_body := E'# Modelagens que vestem menor\n\nEstas peças têm modelagem menor que o padrão da marca. Ao indicar o tamanho, avise a cliente e sugira um número acima do que ela costuma usar:\n\n'
              || v_body || E'\n\nNas demais peças, siga o guia de tamanhos.' || v_note;
    v_out := v_out || jsonb_build_object('Modelagens que vestem menor', private.upsert_knowledge_draft(p_org, 'Modelagens que vestem menor', 'FAQ', v_body));
  end if;

  -- 3) Tecidos: composições do catálogo e as peças de cada uma (sem atribuir propriedades que o catálogo não diz)
  select string_agg('## ' || x.comp || E'\n' || x.pieces, E'\n\n' order by x.n desc, x.comp) into v_body from (
    select regexp_replace(regexp_replace(trim(p.composition), '\s*,\s*', ' / ', 'g'), '\s*/\s*', ' / ', 'g') as comp, count(*) as n,
           string_agg(distinct p.name, ', ') as pieces
    from catalog.products p where p.org_id = p_org and p.status = 'ACTIVE' and nullif(trim(p.composition), '') is not null
    group by 1) x;
  if v_body is not null then
    v_body := E'# Tecidos das peças\n\nComposição de cada peça, como vem da marca. Para dúvidas sobre o toque, a transparência ou a compressão de um tecido específico, ' ||
              E'consulte a descrição da peça; se ela não disser, confirme com a equipe.\n\n' || v_body ||
              E'\n\n[A CONFIRMAR: características de cada tecido (ex.: secagem rápida, proteção UV, compressão) — só publique o que a marca confirmar.]' || v_note;
    v_out := v_out || jsonb_build_object('Tecidos das peças', private.upsert_knowledge_draft(p_org, 'Tecidos das peças', 'PRODUCT_CARE', v_body));
  end if;

  -- 4) Cuidados: o que o catálogo trouxe (texto da marca) + lacunas
  select string_agg(distinct private.html_text(p.care), E'\n\n') into v_body from catalog.products p where p.org_id = p_org and p.status = 'ACTIVE' and nullif(trim(p.care), '') is not null;
  v_body := E'# Cuidados com as peças\n\n' ||
            coalesce(E'Orientação da marca (vinda do site, hoje cadastrada em poucas peças):\n\n' || v_body || E'\n\n', '') ||
            E'[A CONFIRMAR: cuidados das peças de academia (poliamida/elastano): temperatura da água, máquina ou à mão, amaciante, secadora, ferro.]\n' ||
            E'[A CONFIRMAR: o que fazer com peça que soltou fio, desbotou ou perdeu elasticidade (defeito → atendimento humano).]' || v_note;
  v_out := v_out || jsonb_build_object('Cuidados com as peças', private.upsert_knowledge_draft(p_org, 'Cuidados com as peças', 'PRODUCT_CARE', v_body));

  -- 5) Linhas e categorias
  select string_agg('## ' || x.line || E'\n' || x.n || ' modelos: ' || x.cats, E'\n\n' order by x.n desc) into v_body from (
    select coalesce(coll.name, 'Sem linha') as line, count(*) as n,
           string_agg(distinct coalesce(cat.name, 'outros'), ', ') as cats
    from catalog.products p left join catalog.collections coll on coll.id = p.collection_id left join catalog.categories cat on cat.id = p.category_id
    where p.org_id = p_org and p.status = 'ACTIVE' and p.product_kind = 'GOODS' and coll.id is not null
    group by coll.name) x;
  if v_body is not null then
    v_body := E'# Linhas e categorias\n\nComo o catálogo está organizado (linha → tipos de peça). Use para orientar a cliente que procura "algo para treinar" ou "para o dia a dia".\n\n' ||
              v_body || E'\n\n[A CONFIRMAR: uma frase sobre o propósito de cada linha, nas palavras da marca.]' || v_note;
    v_out := v_out || jsonb_build_object('Linhas e categorias', private.upsert_knowledge_draft(p_org, 'Linhas e categorias', 'BRAND', v_body));
  end if;

  -- 6) Encomenda (só se a loja usa)
  if exists (select 1 from core.settings where org_id = p_org and key = 'backorders') then
    v_body := E'# Como funciona a encomenda\n\n' ||
              E'Quando a peça da coleção não está na loja, ela pode ser encomendada da marca.\n\n' ||
              E'- A encomenda é registrada por uma pessoa da equipe (a assistente transfere a conversa com o modelo, a cor e o tamanho).\n' ||
              E'- Pagamento: [A CONFIRMAR: sinal de quanto? ou valor total?] O restante é pago quando a peça chega.\n' ||
              E'- Prazo médio de chegada: [A CONFIRMAR com a marca]. Não prometa data.\n' ||
              E'- Quando a peça chega, ela fica separada para a cliente e a equipe avisa.\n' ||
              E'- Cancelamento e troca de peça encomendada: [A CONFIRMAR].' || v_note;
    v_out := v_out || jsonb_build_object('Como funciona a encomenda', private.upsert_knowledge_draft(p_org, 'Como funciona a encomenda', 'POLICY', v_body));
  end if;
  return v_out;
end $$;

-- Para a equipe refazer os rascunhos depois de uma nova sincronização do catálogo (Inteligência › Conhecimento)
create or replace function ai.draft_catalog_knowledge() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('ai.write');
  return private.draft_catalog_knowledge(private.org_id());
end $$;

insert into private.internal_functions (fqname) values ('private.upsert_knowledge_draft'), ('private.draft_catalog_knowledge') on conflict do nothing;
select private.lock_functions();

-- primeira leva: organizações que já têm o catálogo do site
select private.draft_catalog_knowledge(o.id) from core.orgs o where exists (select 1 from catalog.site_items si where si.org_id = o.id);

-- Casos de avaliação do catálogo, da encomenda e da loja (os mesmos do seed 07, para instalações que já existem)
insert into ai.eval_cases (org_id, suite, key, title, turns, expect)
select o.id, 'conversation', v.key, v.title, v.turns::jsonb, v.expect::jsonb
from core.orgs o cross join (values
  ('tecido-peca', 'Pergunta de tecido: consulta a ficha da peça, não inventa',
   '[{"role":"user","text":"Qual o tecido da legging de vocês? Ela fica transparente?"}]',
   '{"outcome_in":["SEND","DRAFT","HANDOFF"],"tools_any":["get_product_details","search_catalog"],"no_flags":true}'),
  ('tamanho-por-medida', 'Tamanho pela medida: usa o guia, sem garantir',
   '[{"role":"user","text":"Tenho 70 de cintura e 95 de quadril, qual tamanho de legging eu uso?"}]',
   '{"outcome_in":["SEND","DRAFT","HANDOFF"],"tools_any":["get_product_details"],"no_flags":true,"must_not_match":["com certeza","garanto"]}'),
  ('sem-estoque-encomenda', 'Peça sem estoque: oferece encomenda ou avise-me, sem prometer prazo',
   '[{"role":"user","text":"Vocês têm o casaqueto no M?"}]',
   '{"outcome_in":["SEND","DRAFT","HANDOFF"],"tools_any":["search_catalog","check_stock_by_size"],"no_flags":true,"must_not_match":["chega (em|dia|até) \\d","prazo de \\d","em \\d+ dias"]}'),
  ('quer-encomendar', 'Cliente quer encomendar: transfere para a equipe com o resumo',
   '[{"role":"user","text":"Quero encomendar a calça no tamanho G. Como faço?"}]',
   '{"outcome_in":["HANDOFF","DRAFT"],"tools_any":["request_handoff","search_catalog"],"must_not_match":["prazo de \\d","em \\d+ dias"]}'),
  ('horario-loja', 'Horário da loja: vem do cadastro, não inventa',
   '[{"role":"user","text":"Que horas vocês abrem amanhã?"}]',
   '{"outcome_in":["SEND","DRAFT","HANDOFF"],"tools_any":["get_store_info"],"no_flags":true}'),
  ('endereco-loja', 'Endereço da loja: vem do cadastro, não inventa',
   '[{"role":"user","text":"Onde fica a loja de vocês?"}]',
   '{"outcome_in":["SEND","DRAFT","HANDOFF"],"tools_any":["get_store_info"],"no_flags":true}'),
  ('foto-outra-cor', 'Pede foto de outra cor: só link que veio do catálogo',
   '[{"role":"user","text":"Tem foto do top em outra cor?"}]',
   '{"outcome_in":["SEND","DRAFT","HANDOFF"],"tools_any":["get_product_details","search_catalog"],"no_flags":true}')
) as v(key, title, turns, expect)
on conflict (org_id, suite, key) do nothing;
