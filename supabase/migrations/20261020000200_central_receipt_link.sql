-- Central: cartão 'vincular_nota' — liga os itens de uma NF-e em recebimento ao catálogo, criando o que faltar.
-- Cada item vai para uma peça existente (variant_id) ou vira cor/tamanho de um produto, existente (product_id ou referência
-- já cadastrada) ou novo (referência nova + nome). Itens com a mesma referência viram variações do MESMO produto
-- (catalog.apply_brand_items acha o produto pela referência), nunca um produto por linha da nota.
-- Depois de ligar, o recebimento segue na tela (conferência, contagem e lançamento no estoque continuam com a pessoa).
-- Permissão do cartão: purch.write; criar produto/variação ainda exige catalog.write (apply_brand_items confere).

create or replace function private.assistant_tool_perm(p_tool text) returns text
language sql immutable as $$
  select case p_tool
    when 'venda_pdv' then 'sales.write' when 'cadastrar_pessoa' then 'crm.write' when 'reserva' then 'sales.write' when 'avise_me' then 'crm.write'
    when 'tarefa' then 'crm.write' when 'preferencias' then 'crm.write' when 'conta_pagar' then 'fin.write' when 'baixa' then 'fin.write'
    when 'abrir_caixa' then 'sales.write' when 'fechar_caixa' then 'sales.write' when 'campanha_rascunho' then 'crm.write'
    when 'encomenda' then 'sales.write' when 'malinha' then 'sales.write' when 'vincular_nota' then 'purch.write' end
$$;

do $x$
declare v_def text; v_old text := $y$  when 'cadastrar_pessoa' then
    v_party := private.assistant_new_party(g);$y$;
begin
  select pg_get_functiondef('private.assistant_dispatch(ai.assistant_actions)'::regprocedure) into v_def;
  if position(v_old in v_def) = 0 then raise exception 'assistant_dispatch mudou: ajuste este patch'; end if;
  v_def := replace(v_def, v_old, $y$  when 'vincular_nota' then
    declare rc purch.receipts; ri purch.receipt_items; it jsonb; v_res jsonb; v_var uuid; v_doc text; n_link int := 0;
    begin
      select * into rc from purch.receipts where id = nullif(g ->> 'receipt_id', '')::uuid and org_id = private.org_id();
      if rc.id is null then raise exception 'Nota não encontrada' using errcode = 'P0460'; end if;
      if rc.status = 'POSTED' then raise exception 'Esta nota já foi lançada no estoque' using errcode = 'P0083'; end if;
      v_doc := 'NF-e ' || coalesce(rc.number::text, '');
      for it in select * from jsonb_array_elements(coalesce(g -> 'itens', '[]')) loop
        select * into ri from purch.receipt_items where id = nullif(it ->> 'item_id', '')::uuid and receipt_id = rc.id;
        if ri.id is null then raise exception 'Item % não é desta nota', it ->> 'item_id' using errcode = 'P0460'; end if;
        if nullif(it ->> 'variant_id', '') is not null then
          v_var := (it ->> 'variant_id')::uuid;
        else
          v_res := catalog.apply_brand_items(jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                     'product_id', nullif(it ->> 'product_id', ''), 'reference', nullif(it ->> 'reference', ''), 'name', nullif(it ->> 'name', ''),
                     'gender', nullif(it ->> 'gender', ''), 'category', nullif(it ->> 'category', ''), 'color_name', nullif(it ->> 'color', ''),
                     'size', it ->> 'size', 'price', nullif(it ->> 'price', ''), 'ncm', ri.ncm, 'gtin', ri.cean, 'supplier_sku', ri.supplier_cprod,
                     'source', 'NFE', 'document', v_doc))));
          if jsonb_array_length(coalesce(v_res -> 'erros', '[]')) > 0 then
            raise exception 'Item % (%): %', ri.n_item, ri.description, v_res -> 'erros' -> 0 ->> 'erro' using errcode = 'P0460';
          end if;
          v_var := (v_res -> 'items' -> 0 ->> 'variant_id')::uuid;
        end if;
        perform purch.set_receipt_item(ri.id, jsonb_build_object('variant_id', v_var, 'learn', true));
        n_link := n_link + 1;
      end loop;
      return jsonb_build_object('target_type', 'purch.receipts', 'target_id', rc.id, 'number', 'NF-e ' || coalesce(rc.number::text, '') || ': ' || n_link || ' item(ns) ligados',
                                'href', '/produtos/recebimento/' || rc.id);
    end;
$y$ || v_old);
  execute v_def;
end $x$;

select private.lock_functions();
