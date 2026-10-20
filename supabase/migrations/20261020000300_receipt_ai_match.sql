-- Recebimento de NF-e: sugestão da IA para ligar cada item ao catálogo (peça existente, nova cor/tamanho de um produto, ou
-- produto novo agrupado pela referência e com a coleção), como padrão ao importar a nota.
--   * ao importar (insert em purch.receipts) a nota entra na fila ai_tasks/RECEIPT_MATCH — o worker chama a rota de IA
--     'extract' com os itens e os produtos candidatos do catálogo e grava a sugestão em purch.receipt_items.ai_suggestion;
--     peça existente em item ainda sem vínculo também vira variant_id + match_status SUGGESTED (o botão "Confirmar sugestões" de sempre);
--   * purch.request_ai_match roda de novo à mão (p_all = true revisa também os itens já ligados e aponta vínculo suspeito);
--   * purch.apply_ai_suggestions aplica: cria o que falta (catalog.apply_brand_items: um produto por referência), põe a coleção
--     no produto que ainda não tem e liga o item. Nada entra no estoque: conferir, contar e lançar continuam com a pessoa.
-- Desligar o automático: core.settings 'purch.ai_match' = false.

alter table purch.receipt_items add column if not exists ai_suggestion jsonb, add column if not exists ai_suggested_at timestamptz;
alter table purch.receipts add column if not exists ai_status text check (ai_status in ('QUEUED', 'RUNNING', 'DONE', 'FAILED')), add column if not exists ai_note text;

create or replace function private.receipt_ai_auto() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select value <> 'false'::jsonb from core.settings where org_id = new.org_id and key = 'purch.ai_match'), true) then
    new.ai_status := 'QUEUED';
    perform private.enqueue('ai_tasks', jsonb_build_object('action', 'RECEIPT_MATCH', 'org_id', new.org_id, 'receipt_id', new.id, 'all', false), 5);
  end if;
  return new;
end $$;
drop trigger if exists trg_receipt_ai_auto on purch.receipts;
create trigger trg_receipt_ai_auto before insert on purch.receipts for each row execute function private.receipt_ai_auto();

create or replace function purch.request_ai_match(p_receipt uuid, p_all boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare rc purch.receipts;
begin
  perform private.require_perm('purch.write');
  select * into rc from purch.receipts where id = p_receipt and org_id = private.org_id();
  if rc.id is null then raise exception 'Recebimento não encontrado' using errcode = 'P0460'; end if;
  if rc.status = 'POSTED' then raise exception 'Recebimento já lançado no estoque' using errcode = 'P0083'; end if;
  update purch.receipts set ai_status = 'QUEUED', ai_note = null where id = rc.id;
  perform private.enqueue('ai_tasks', jsonb_build_object('action', 'RECEIPT_MATCH', 'org_id', rc.org_id, 'receipt_id', rc.id, 'all', coalesce(p_all, false)), 0);
end $$;

-- Aplica as sugestões da IA (todas, ou só p_items). Cada item é independente: um erro não desfaz os outros.
create or replace function purch.apply_ai_suggestions(p_receipt uuid, p_items uuid[] default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  rc purch.receipts; ri purch.receipt_items; s jsonb; v_res jsonb; v_var uuid; v_prod uuid; v_coll uuid; v_doc text;
  n_ok int := 0; v_errors jsonb := '[]';
begin
  perform private.require_perm('purch.write');
  select * into rc from purch.receipts where id = p_receipt and org_id = private.org_id();
  if rc.id is null then raise exception 'Recebimento não encontrado' using errcode = 'P0460'; end if;
  if rc.status = 'POSTED' then raise exception 'Recebimento já lançado no estoque' using errcode = 'P0083'; end if;
  v_doc := 'NF-e ' || rc.number;
  for ri in select * from purch.receipt_items where receipt_id = rc.id and ai_suggestion is not null
            and coalesce(ai_suggestion ->> 'acao', '') in ('vincular', 'trocar', 'nova_variante', 'novo_produto')
            and (p_items is null or id = any (p_items)) order by n_item loop
    s := ri.ai_suggestion;
    begin
      if s ->> 'acao' in ('vincular', 'trocar') then
        v_var := (s ->> 'variant_id')::uuid;
      else
        v_res := catalog.apply_brand_items(jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                   'product_id', nullif(s ->> 'product_id', ''), 'reference', nullif(s ->> 'reference', ''), 'name', nullif(s ->> 'name', ''),
                   'gender', nullif(s ->> 'gender', ''), 'category', nullif(s ->> 'category', ''), 'color_name', nullif(s ->> 'color', ''),
                   'size', s ->> 'size', 'price', nullif(s ->> 'price', ''), 'ncm', ri.ncm, 'gtin', ri.cean, 'supplier_sku', ri.supplier_cprod,
                   'source', 'NFE', 'document', v_doc))));
        if jsonb_array_length(coalesce(v_res -> 'erros', '[]')) > 0 then raise exception '%', v_res -> 'erros' -> 0 ->> 'erro'; end if;
        v_var := (v_res -> 'items' -> 0 ->> 'variant_id')::uuid;
        v_prod := (v_res -> 'items' -> 0 ->> 'product_id')::uuid;
        if nullif(trim(coalesce(s ->> 'collection', '')), '') is not null then
          select id into v_coll from catalog.collections where org_id = rc.org_id and lower(name) = lower(trim(s ->> 'collection')) limit 1;
          if v_coll is null then
            insert into catalog.collections (org_id, name, kind) values (rc.org_id, trim(s ->> 'collection'), 'DROP') returning id into v_coll;
          end if;
          update catalog.products set collection_id = v_coll where id = v_prod and collection_id is null;
        end if;
      end if;
      perform purch.set_receipt_item(ri.id, jsonb_build_object('variant_id', v_var, 'learn', true));
      update purch.receipt_items set ai_suggestion = null where id = ri.id;
      n_ok := n_ok + 1;
    exception when others then
      v_errors := v_errors || jsonb_build_object('n_item', ri.n_item, 'descricao', ri.description, 'erro', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('aplicadas', n_ok, 'erros', v_errors);
end $$;

insert into private.internal_functions (fqname) values ('private.receipt_ai_auto') on conflict do nothing;
select private.lock_functions();
