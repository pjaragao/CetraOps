-- Busca do catálogo pela IA (agent.t_search_catalog): cor por sinônimo e gênero da peça (23/11/2026).
--
-- Caso real: o cliente (homem) perguntou "e camiseta branca, tem?". A IA buscou query "camiseta" + cor "Branco" e só voltou a
-- Blusa Iza (feminina, categoria Camiseta, cor "Branco"); as Camisetas Pierre cadastradas como "White" e "Off-White" não casaram.
-- • Cor: "branca" agora casa White, Off-White, Pérola…; "preta" casa Black; "cinza" casa Grey/Chumbo/Mescla; etc. Palavra de cor
--   dentro da query ("camiseta branca") vira filtro de cor com os mesmos sinônimos, em vez de exigir a palavra no nome.
-- • Gênero: parâmetro `gender` (MASC, FEM ou UNISSEX) e, sem ele, o gênero do cadastro do cliente (crm.parties.gender M/F).
--   Peças unissex sempre entram. Sem nada do gênero, a busca devolve as do outro gênero marcadas com um aviso (pode ser presente).

create or replace function private.color_patterns(p_word text)
returns text[] language sql immutable set search_path = '' as $$
  select g.pats from (values
    (array['branc', 'white', 'offwhite', 'off', 'perola', 'marfim', 'gelo'], array['%branc%', '%white%', '%perola%', '%marfim%', '%gelo%']),
    (array['pret', 'black', 'onix'], array['%pret%', '%black%', '%onix%']),
    (array['cinz', 'grey', 'gray', 'chumbo', 'grafite', 'mescla'], array['%cinz%', '%grey%', '%gray%', '%chumbo%', '%grafite%', '%mescla%', '%platinum%']),
    (array['marinh', 'navy', 'naval'], array['%marinh%', '%navy%', '%naval%', '%nautico%']),
    (array['azul', 'blue'], array['%azul%', '%blue%', '%marinh%', '%navy%', '%naval%', '%nautico%', '%sky%', '%pacifico%']),
    (array['verd', 'green', 'oliv', 'militar'], array['%verd%', '%green%', '%oliv%', '%esmeralda%', '%militar%']),
    (array['vermelh', 'red'], array['%vermelh%', '% red%', 'red%', '%framboesa%']),
    (array['rosa', 'pink', 'rose', 'blush'], array['%rosa%', '%pink%', '%rose%', '%blush%', '%ballerina%']),
    (array['beg', 'beige', 'nude', 'areia', 'caqui'], array['%beg%', '%beige%', '%nude%', '%areia%', '%caqui%', '%cappuccino%', '%centeio%']),
    (array['marrom', 'brown', 'cafe', 'chocolate'], array['%marrom%', '%brown%', '%cafe%', '%mocha%', '%chocolate%', '%avela%', '%mascavo%']),
    (array['amarel', 'yellow'], array['%amarel%', '%yellow%', '%butter%']),
    (array['rox', 'lilas', 'lilac', 'purple', 'lavanda'], array['%rox%', '%lilas%', '%lilac%', '%purple%', '%malva%', '%lavanda%']),
    (array['vinho', 'wine', 'bordo'], array['%vinho%', '%wine%', '%bordo%', '%figo%'])
  ) as g(keys, pats)
  where exists (select 1 from unnest(g.keys) k where replace(private.norm(p_word), '-', '') like k || '%')
  limit 1
$$;

create or replace function agent.t_search_catalog(c omni.conversations, a jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_store uuid; v_q text := private.norm(coalesce(a ->> 'query', '')); v_tokens text[] := '{}'; v_in_stock boolean := coalesce((a ->> 'in_stock_only')::boolean, true);
  v_max numeric := (a ->> 'price_max')::numeric; v_color_pats text[]; v_query_colors text[] := '{}'; t text; v_pats text[];
  v_cat text := nullif(private.norm(coalesce(a ->> 'category', '')), ''); v_out jsonb;
  v_gender text := case upper(coalesce(a ->> 'gender', '')) when 'MASC' then 'MASC' when 'MASCULINO' then 'MASC' when 'M' then 'MASC'
                                                             when 'FEM' then 'FEM' when 'FEMININO' then 'FEM' when 'F' then 'FEM'
                                                             when 'UNISSEX' then 'UNISSEX' when 'UNISEX' then 'UNISSEX' end;
  v_gender_explicit boolean; v_other_gender boolean := false;
begin
  select ca.store_id into v_store from omni.channel_accounts ca where ca.id = c.channel_account_id;
  v_gender_explicit := v_gender is not null;
  if v_gender is null then
    select case upper(coalesce(p.gender, '')) when 'M' then 'MASC' when 'MASC' then 'MASC' when 'F' then 'FEM' when 'FEM' then 'FEM' end
      into v_gender from crm.parties p where p.id = c.party_id;
  end if;

  -- cor pedida: sinônimos (branco ↔ white/off-white…); palavra de cor na query vira filtro de cor
  if nullif(trim(coalesce(a ->> 'color', '')), '') is not null then
    select coalesce(array_agg(distinct x), '{}') into v_color_pats
    from unnest(regexp_split_to_array(private.norm(a ->> 'color'), '[\s/,]+')) w, unnest(coalesce(private.color_patterns(w), array[]::text[])) x;
    if cardinality(v_color_pats) = 0 then
      v_color_pats := array['%' || regexp_replace(private.norm(a ->> 'color'), '(as|os|es|a|o|e|s)$', '') || '%'];
    end if;
  end if;
  foreach t in array regexp_split_to_array(v_q, '\s+') loop
    continue when length(t) < 2 or t = any (array['de', 'da', 'do', 'das', 'dos', 'com', 'para', 'pra', 'um', 'uma', 'que', 'tem', 'em', 'no', 'na', 'nos', 'nas', 'os', 'as', 'cor']);
    v_pats := private.color_patterns(t);
    if v_pats is not null then
      v_query_colors := v_query_colors || v_pats;
    else
      v_tokens := v_tokens || ('%' || case when length(t) >= 5 then regexp_replace(t, '(as|os|es|a|o|e|s)$', '') else t end || '%');
    end if;
  end loop;
  if v_color_pats is null and cardinality(v_query_colors) > 0 then v_color_pats := v_query_colors; end if;

  for pass in 1..2 loop
    with base as (
      select p.id, p.name, p.reference_code, p.gender, p.backorder, p.composition, nullif(p.custom_fields -> 'site' ->> 'fit', '') as fit_note,
             cat.name as category, coll.name as line,
             private.norm(p.name || ' ' || p.reference_code || ' ' || coalesce(cat.name, '')) as key_main,
             private.norm(coalesce(coll.name, '') || ' ' || coalesce(p.description, '') || ' ' || coalesce(p.composition, '') || ' ' ||
                          coalesce((select string_agg(t2, ' ') from jsonb_array_elements_text(case when jsonb_typeof(p.custom_fields -> 'site' -> 'tags') = 'array'
                                                                                                 then p.custom_fields -> 'site' -> 'tags' else '[]' end) t2), '')) as key_more
      from catalog.products p
      left join catalog.categories cat on cat.id = p.category_id
      left join catalog.collections coll on coll.id = p.collection_id
      where p.org_id = c.org_id and p.status = 'ACTIVE' and p.product_kind = 'GOODS'
        and (v_gender is null or v_gender = 'UNISSEX' or p.gender::text in (v_gender, 'UNISSEX'))
        and (v_cat is null or private.norm(coalesce(cat.name, '')) like '%' || v_cat || '%' or private.norm(coalesce(coll.name, '')) like '%' || v_cat || '%')
    ), vars as (
      select b.*, v.size, col.name as color, st.avail, catalog.current_price(v.id) as price,
             (cardinality(v_tokens) = 0 or (b.key_main || ' ' || private.norm(coalesce(col.name, ''))) like all (v_tokens)) as main_hit
      from base b
      join catalog.variants v on v.product_id = b.id and v.active
      left join catalog.colors col on col.id = v.color_id
      left join lateral (select coalesce(sum(sl.available), 0) as avail from inv.stock_levels sl join inv.locations l on l.id = sl.location_id and l.is_sellable
                         and (v_store is null or l.store_id = v_store) where sl.variant_id = v.id) st on true
      where (v_color_pats is null or private.norm(coalesce(col.name, '')) like any (v_color_pats))
        and (cardinality(v_tokens) = 0 or (b.key_main || ' ' || private.norm(coalesce(col.name, '')) || ' ' || b.key_more) like all (v_tokens))
    ), agg as (
      select id, name, reference_code, gender, backorder, composition, fit_note, category, line, bool_or(main_hit) as main_hit,
             min(price) as price, coalesce(sum(avail), 0) as total,
             private.sort_sizes(array_agg(size) filter (where avail > 0)) as sizes_in_stock,
             coalesce(array_agg(distinct color) filter (where avail > 0 and color is not null), '{}') as colors_in_stock,
             case when backorder then private.sort_sizes(array_agg(size) filter (where avail <= 0)) else '{}' end as sizes_backorder,
             case when backorder then coalesce(array_agg(distinct color) filter (where color is not null), '{}') else '{}' end as colors_all
      from vars
      group by id, name, reference_code, gender, backorder, composition, fit_note, category, line
      having (not v_in_stock or coalesce(sum(avail), 0) > 0 or backorder) and (v_max is null or min(price) <= v_max)
      order by bool_or(main_hit) desc, (gender::text = coalesce(v_gender, '')) desc, (coalesce(sum(avail), 0) > 0) desc, coalesce(sum(avail), 0) desc, name
      limit 8
    )
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'product_id', g.id, 'name', g.name, 'reference', g.reference_code, 'gender', g.gender, 'category', g.category, 'line', g.line,
             'price', g.price, 'composition', g.composition, 'fit_note', g.fit_note,
             'availability', case when g.total > 0 then 'IN_STOCK' when g.backorder then 'BACKORDER' else 'OUT_OF_STOCK' end,
             'colors', g.colors_in_stock, 'sizes_in_stock', g.sizes_in_stock, 'total_available', g.total,
             'backorder_sizes', case when g.backorder then to_jsonb(g.sizes_backorder) end,
             'backorder_colors', case when g.backorder then to_jsonb(g.colors_all) end,
             'photo', (select private.catalog_photo_url(c.org_id, m.storage_path, m.source_url)
                       from catalog.product_media m left join catalog.colors mc on mc.id = m.color_id
                       where m.product_id = g.id
                       order by (v_color_pats is not null and private.norm(coalesce(mc.name, '')) like any (v_color_pats)) desc,
                                (mc.name = any (g.colors_in_stock)) desc nulls last, m.position limit 1)))), '[]') into v_out
    from agg g;
    exit when jsonb_array_length(v_out) > 0 or v_gender is null or v_gender = 'UNISSEX' or v_gender_explicit;
    v_gender := null;                                     -- nada do gênero do cadastro: mostra o resto, avisando
    v_other_gender := true;
  end loop;

  return jsonb_strip_nulls(jsonb_build_object('ok', true, 'products', v_out,
    'hint', nullif(concat_ws(' ',
      case when v_out @? '$[*] ? (@.availability == "BACKORDER")'
           then 'Peça BACKORDER: sem estoque na loja, mas pode ser encomendada. Ofereça a encomenda e, se a cliente quiser, transfira com request_handoff (BACKORDER) informando modelo, cor e tamanho. Não prometa prazo.' end,
      case when v_other_gender and jsonb_array_length(v_out) > 0
           then 'Nenhuma peça do gênero do cadastro do cliente com esses critérios; estas são de outro gênero (veja gender). Não ofereça como se fossem para ele(a): diga que não há no modelo pedido e só sugira se for presente ou se pedir.' end), '')));
end $$;

revoke execute on function agent.t_search_catalog(omni.conversations, jsonb) from public, anon, authenticated;
grant execute on function agent.t_search_catalog(omni.conversations, jsonb) to agent_rpc, service_role;
