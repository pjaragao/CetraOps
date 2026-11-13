-- Lotes retroativos (13/11/2026): entradas de várias NF-e que já estavam em andamento antes do lote salvo existir não apareciam em
-- "Entradas em andamento". O grupo não foi gravado, mas dá para reconstruir: cada leitura feita com as notas juntas guardou as linhas das
-- notas em que a peça aparecia ("candidates"), e cada link de celular guardou as notas extras. Notas que aparecem juntas numa mesma
-- leitura/link pertencem ao mesmo lote; lotes se juntam quando compartilham uma nota.
--  • Só entram notas ainda não lançadas, e só se sobrarem 2 ou mais.
--  • Idempotente: não cria lote se já existe um lote aberto com as mesmas notas.
--  • Roda uma vez aqui e pode ser chamada de novo (private.backfill_receipt_batches).
-- Se o grupo antigo não tinha nenhuma peça em comum entre as notas, ele não é detectado: marque as notas na lista e toque em "Bipar juntas".

create or replace function private.backfill_receipt_batches() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  ed record; g record; v_gids int[]; v_new int; v_next int := 0; v_ids uuid[]; v_n int := 0;
begin
  create temporary table if not exists _bf_edges (org_id uuid, ids uuid[], first_at timestamptz) on commit drop;
  create temporary table if not exists _bf_groups (org_id uuid, rid uuid primary key, gid int) on commit drop;
  truncate _bf_edges, _bf_groups;

  -- 1) leituras com as notas juntas: as notas das linhas candidatas
  insert into _bf_edges (org_id, ids, first_at)
  select e.org_id, array_agg(distinct i.receipt_id), min(e.at)
    from purch.receipt_scan_events e
    cross join lateral jsonb_array_elements_text(case when jsonb_typeof(e.result -> 'candidates') = 'array' then e.result -> 'candidates' else '[]'::jsonb end) c
    join purch.receipt_items i on i.id = c::uuid
   group by e.id, e.org_id
  having count(distinct i.receipt_id) >= 2;

  -- 2) links do celular que cobriam várias notas
  insert into _bf_edges (org_id, ids, first_at)
  select l.org_id, array[l.receipt_id] || l.extra_receipt_ids, l.created_at
    from purch.receipt_scan_links l where cardinality(l.extra_receipt_ids) > 0;

  -- 3) junta as notas que aparecem juntas (componentes conexos)
  for ed in select * from _bf_edges loop
    select coalesce(array_agg(distinct gid), '{}'::int[]) into v_gids from _bf_groups where rid = any(ed.ids);
    if cardinality(v_gids) = 0 then
      v_next := v_next + 1; v_new := v_next;
    else
      select min(x) into v_new from unnest(v_gids) x;
      update _bf_groups set gid = v_new where gid = any(v_gids);
    end if;
    insert into _bf_groups (org_id, rid, gid) select ed.org_id, x, v_new from unnest(ed.ids) x on conflict (rid) do nothing;
  end loop;

  -- 4) um lote aberto por grupo com 2+ notas ainda em aberto
  for g in select distinct org_id, gid from _bf_groups loop
    select coalesce(array_agg(r.id order by r.id), '{}'::uuid[]) into v_ids
      from _bf_groups b join purch.receipts r on r.id = b.rid and r.org_id = g.org_id
     where b.gid = g.gid and r.status <> 'POSTED';
    if cardinality(v_ids) between 2 and 20
       and not exists (select 1 from purch.receipt_batches where org_id = g.org_id and status = 'OPEN' and receipt_ids = v_ids) then
      insert into purch.receipt_batches (org_id, receipt_ids, created_at)
      values (g.org_id, v_ids, coalesce((select min(e.first_at) from _bf_edges e where e.ids && v_ids), now()));
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

insert into private.internal_functions (fqname) values ('private.backfill_receipt_batches') on conflict do nothing;
select private.lock_functions();

select private.backfill_receipt_batches();
