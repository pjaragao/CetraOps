-- Lote de entrada (13/11/2026): três caixas do mesmo pedido, três NF-e, uma bipagem só. Antes a pessoa precisava marcar as notas de novo
-- toda vez que reabria a bipagem. Agora as notas escolhidas viram um lote salvo, que fica visível na lista de recebimentos
-- até ser finalizado (ou até todas as notas serem lançadas no estoque).
--  • purch.receipt_batches: o lote (notas, quem criou, aberto/finalizado).
--  • purch.open_receipt_batch: abre o lote das notas escolhidas (se já existe um aberto com as mesmas notas, devolve esse).
--  • purch.get_receipt_batch / purch.finish_receipt_batch / purch.receipt_batches_overview (andamento de cada lote para a lista).

create table if not exists purch.receipt_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  receipt_ids uuid[] not null check (cardinality(receipt_ids) between 2 and 20),
  status text not null default 'OPEN' check (status in ('OPEN', 'DONE')),
  created_by uuid references core.members(id),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  finished_by uuid references core.members(id)
);
create index if not exists receipt_batches_open_idx on purch.receipt_batches (org_id, status);

select private.apply_rls('purch', array['receipt_batches'], 'purch.read', 'purch.write');
select private.rpc_only('purch', array['receipt_batches']);

create or replace function purch.open_receipt_batch(p_receipts uuid[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_ids uuid[]; v_id uuid;
begin
  perform private.require_perm('purch.write');
  select coalesce(array_agg(s.id order by s.id), '{}'::uuid[]) into v_ids from (
    select distinct r.id from purch.receipts r where r.id = any(coalesce(p_receipts, '{}'::uuid[])) and r.org_id = v_org and r.status <> 'POSTED') s;
  if cardinality(v_ids) < 2 then raise exception 'Escolha ao menos 2 notas em aberto para bipar juntas' using errcode = 'P0086'; end if;
  if cardinality(v_ids) > 20 then raise exception 'No máximo 20 notas por lote' using errcode = 'P0086'; end if;
  select id into v_id from purch.receipt_batches where org_id = v_org and status = 'OPEN' and receipt_ids = v_ids limit 1;
  if v_id is null then
    insert into purch.receipt_batches (org_id, receipt_ids, created_by) values (v_org, v_ids, private.member_id()) returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function purch.get_receipt_batch(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b purch.receipt_batches;
begin
  perform private.require_perm('purch.read');
  select * into b from purch.receipt_batches where id = p_batch and org_id = private.org_id();
  if b.id is null then raise exception 'Lote não encontrado'; end if;
  return jsonb_build_object('id', b.id, 'status', b.status, 'receipt_ids', to_jsonb(b.receipt_ids));
end $$;

create or replace function purch.finish_receipt_batch(p_batch uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('purch.write');
  update purch.receipt_batches set status = 'DONE', finished_at = now(), finished_by = private.member_id()
   where id = p_batch and org_id = private.org_id() and status = 'OPEN';
end $$;

-- Lotes em aberto com o andamento de cada nota (lista de recebimentos). Lote cujas notas já foram todas lançadas se encerra sozinho.
create or replace function purch.receipt_batches_overview() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id();
begin
  perform private.require_perm('purch.read');
  update purch.receipt_batches b set status = 'DONE', finished_at = now()
   where b.org_id = v_org and b.status = 'OPEN'
     and not exists (select 1 from purch.receipts r where r.id = any(b.receipt_ids) and r.status <> 'POSTED');
  return coalesce((
    select jsonb_agg(x.j order by x.created_at desc) from (
      select b.created_at, jsonb_build_object(
        'id', b.id, 'created_at', b.created_at,
        'notes', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', r.id, 'number', r.number, 'status', r.status, 'total', r.nf_total,
                    'nf', case when d.id is null then '—' else coalesce(d.number::text, '') || coalesce('/' || d.series::text, '') end,
                    'pieces', (select coalesce(sum(i.qty_nfe), 0) from purch.receipt_items i where i.receipt_id = r.id),
                    'counted', (select coalesce(sum(least(coalesce(i.qty_counted, 0), i.qty_nfe)), 0) from purch.receipt_items i where i.receipt_id = r.id)
                  ) order by d.number), '[]'::jsonb)
                    from purch.receipts r left join fiscal.documents d on d.id = r.document_id where r.id = any(b.receipt_ids)),
        'extras', (select coalesce(sum((e ->> 'qty')::numeric), 0) from jsonb_array_elements(private.receipt_extras(b.receipt_ids)) e)
      ) as j
      from purch.receipt_batches b where b.org_id = v_org and b.status = 'OPEN') x), '[]'::jsonb);
end $$;

select private.lock_functions();
