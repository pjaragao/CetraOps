-- Bipagem assistida (08/11/2026): o computador gera um link temporário, manda pelo WhatsApp (ou mostra o QR) e o celular,
-- apoiado ao lado do computador, vira o leitor da nota sem precisar entrar no sistema. O computador mostra cada leitura.
--  • purch.receipt_scan_links: link por nota, guardado só o hash do código; vale algumas horas e pode ser encerrado.
--  • purch.receipt_scan_events: registro das leituras (de qualquer aparelho) — o computador acompanha por ele.
--  • A lógica da leitura e do +/− passa para private.receipt_scan / private.receipt_bump; purch.scan_receipt_code e
--    purch.bump_receipt_item continuam iguais para quem está logado.
--  • public.receipt_link_*: o que o celular chama com o código do link (anon). O link só funciona enquanto quem o gerou
--    continua ativo e com purch.write, a nota não foi lançada e o prazo não venceu.

create table if not exists purch.receipt_scan_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.orgs(id),
  receipt_id uuid not null references purch.receipts(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid references core.members(id),
  label text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists receipt_scan_links_receipt_idx on purch.receipt_scan_links (receipt_id);

create table if not exists purch.receipt_scan_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  receipt_id uuid not null references purch.receipts(id) on delete cascade,
  item_id uuid references purch.receipt_items(id) on delete set null,
  link_id uuid references purch.receipt_scan_links(id) on delete set null,
  member_id uuid references core.members(id),
  code text not null,
  qty numeric not null,
  result jsonb not null,
  at timestamptz not null default now()
);
create index if not exists receipt_scan_events_receipt_idx on purch.receipt_scan_events (receipt_id, id);

select private.apply_rls('purch', array['receipt_scan_links', 'receipt_scan_events'], 'purch.read', 'purch.write');
select private.rpc_only('purch', array['receipt_scan_links', 'receipt_scan_events']);
revoke select on purch.receipt_scan_links from authenticated;   -- o hash do código não sai do banco

-- ---------- núcleo da leitura (sem checar sessão: quem chama já checou) ----------
create or replace function private.receipt_scan(p_org uuid, p_receipt uuid, p_code text, p_qty numeric, p_member uuid, p_link uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  rc purch.receipts;
  v_code text := btrim(coalesce(p_code, ''));
  v_digits boolean;
  v_vars uuid[];
  ri purch.receipt_items;
  v_room numeric; v_add numeric; v_var catalog.variants; v_res jsonb; v_ev bigint;
begin
  if v_code = '' or length(v_code) > 80 then raise exception 'Código vazio ou longo demais' using errcode = 'P0086'; end if;
  if p_qty is null or p_qty <= 0 or p_qty > 10000 then raise exception 'Quantidade por leitura inválida' using errcode = 'P0086'; end if;
  select * into rc from purch.receipts where id = p_receipt and org_id = p_org for update;   -- uma leitura por vez nesta nota
  if rc.id is null then raise exception 'Recebimento não encontrado'; end if;
  if rc.status = 'POSTED' then raise exception 'Recebimento já lançado no estoque' using errcode = 'P0083'; end if;
  v_digits := v_code ~ '^\d{8,14}$';

  select array_agg(distinct id) into v_vars from (
    select v.id from catalog.variants v
     where v.org_id = p_org and (upper(v.sku) = upper(v_code) or (v_digits and v.gtin = v_code) or upper(v.supplier_sku) = upper(v_code))
    union
    select si.variant_id from catalog.supplier_items si
     where si.org_id = p_org and si.supplier_party_id = rc.supplier_party_id and si.variant_id is not null
       and (upper(si.supplier_cprod) = upper(v_code) or (v_digits and si.supplier_ean = v_code))
  ) s;

  select * into ri from purch.receipt_items i
   where i.receipt_id = rc.id
     and ((v_digits and i.cean = v_code and i.cean !~ '^0+$') or upper(i.supplier_cprod) = upper(v_code) or i.variant_id = any(coalesce(v_vars, '{}')))
   order by (coalesce(i.qty_counted, 0) < i.qty_nfe) desc, i.n_item
   limit 1
   for update;

  if ri.id is null then
    if coalesce(array_length(v_vars, 1), 0) > 0 then
      select * into v_var from catalog.variants where id = v_vars[1];
      v_res := jsonb_build_object('status', 'NOT_IN_NOTE', 'code', v_code, 'variant_id', v_var.id, 'sku', v_var.sku,
        'label', (select concat_ws(' · ', p.name, c.name, v_var.size) from catalog.products p left join catalog.colors c on c.id = v_var.color_id where p.id = v_var.product_id),
        'photo', (select m.storage_path from catalog.product_media m where m.product_id = v_var.product_id
                   order by (m.color_id is not distinct from v_var.color_id) desc, m.position limit 1));
    else
      v_res := jsonb_build_object('status', 'UNKNOWN', 'code', v_code);
    end if;
  else
    v_room := ri.qty_nfe - coalesce(ri.qty_counted, 0);
    v_add := least(p_qty, greatest(v_room, 0));
    if v_add > 0 then
      update purch.receipt_items set qty_counted = coalesce(qty_counted, 0) + v_add where id = ri.id;
      if rc.status = 'CHECKED' then update purch.receipts set status = 'PENDING_CHECK', checked_by = null, checked_at = null where id = rc.id; end if;
    end if;
    v_res := purch.receipt_item_view(ri.id) || jsonb_build_object(
      'status', case when v_add = 0 then 'EXCESS' when v_add < p_qty then 'PARTIAL_EXCESS' else 'OK' end,
      'code', v_code, 'added', v_add, 'excess', p_qty - v_add);
  end if;

  insert into purch.receipt_scan_events (org_id, receipt_id, item_id, link_id, member_id, code, qty, result)
  values (p_org, rc.id, ri.id, p_link, p_member, v_code, p_qty, v_res) returning id into v_ev;
  return v_res || jsonb_build_object('event_id', v_ev);
end $$;

create or replace function private.receipt_bump(p_org uuid, p_item uuid, p_delta numeric, p_member uuid, p_link uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare ri purch.receipt_items; rc purch.receipts; v_new numeric; v_res jsonb; v_ev bigint;
begin
  if p_delta is null or p_delta = 0 or abs(p_delta) > 10000 then raise exception 'Quantidade inválida' using errcode = 'P0086'; end if;
  select * into ri from purch.receipt_items where id = p_item and org_id = p_org for update;
  if ri.id is null then raise exception 'Item não encontrado'; end if;
  select * into rc from purch.receipts where id = ri.receipt_id;
  if rc.status = 'POSTED' then raise exception 'Recebimento já lançado no estoque' using errcode = 'P0083'; end if;
  v_new := coalesce(ri.qty_counted, 0) + p_delta;
  if v_new > ri.qty_nfe then
    raise exception 'A nota tem % unidade(s) deste item. Sobras: peça nota complementar ao fornecedor.', trim_scale(ri.qty_nfe) using errcode = 'P0085';
  end if;
  update purch.receipt_items set qty_counted = greatest(v_new, 0) where id = ri.id;
  if rc.status = 'CHECKED' then update purch.receipts set status = 'PENDING_CHECK', checked_by = null, checked_at = null where id = rc.id; end if;
  v_res := purch.receipt_item_view(ri.id) || jsonb_build_object('status', 'ADJUST', 'code', '', 'added', p_delta);
  insert into purch.receipt_scan_events (org_id, receipt_id, item_id, link_id, member_id, code, qty, result)
  values (p_org, rc.id, ri.id, p_link, p_member, '', p_delta, v_res) returning id into v_ev;
  return v_res || jsonb_build_object('event_id', v_ev);
end $$;

-- ---------- quem está logado: mesmas assinaturas de antes ----------
create or replace function purch.scan_receipt_code(p_receipt uuid, p_code text, p_qty numeric default 1) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('purch.write');
  return private.receipt_scan(private.org_id(), p_receipt, p_code, p_qty, private.member_id(), null);
end $$;

create or replace function purch.bump_receipt_item(p_item uuid, p_delta numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('purch.write');
  return private.receipt_bump(private.org_id(), p_item, p_delta, private.member_id(), null);
end $$;

-- Quantidades, leituras novas (de outros aparelhos) e celulares ligados por link — o computador consulta a cada poucos segundos
create or replace function private.receipt_feed(p_receipt uuid, p_after bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', (select status from purch.receipts where id = p_receipt),
    'items', coalesce((select jsonb_agg(jsonb_build_object('item_id', i.id, 'qty_counted', coalesce(i.qty_counted, 0), 'qty_nfe', i.qty_nfe))
                        from purch.receipt_items i where i.receipt_id = p_receipt), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'code', e.code, 'qty', e.qty, 'by_link', e.link_id is not null, 'result', e.result) order by e.id)
                         from (select * from purch.receipt_scan_events where receipt_id = p_receipt and id > coalesce(p_after, 0) order by id desc limit 50) e), '[]'),
    'last_event', coalesce((select max(id) from purch.receipt_scan_events where receipt_id = p_receipt), 0),
    'links', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'label', l.label, 'expires_at', l.expires_at, 'last_seen_at', l.last_seen_at,
                                            'online', coalesce(l.last_seen_at > now() - interval '60 seconds', false)) order by l.created_at)
                        from purch.receipt_scan_links l where l.receipt_id = p_receipt and l.revoked_at is null and l.expires_at > now()), '[]'))
$$;

create or replace function purch.receipt_scan_feed(p_receipt uuid, p_after bigint default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('purch.read');
  if not exists (select 1 from purch.receipts where id = p_receipt and org_id = private.org_id()) then raise exception 'Recebimento não encontrado'; end if;
  return private.receipt_feed(p_receipt, p_after);
end $$;

-- ---------- link temporário ----------
create or replace function purch.create_scan_link(p_receipt uuid, p_label text default null, p_hours integer default 6) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare rc purch.receipts; v_token text; v_id uuid; v_exp timestamptz;
begin
  perform private.require_perm('purch.write');
  select * into rc from purch.receipts where id = p_receipt and org_id = private.org_id();
  if rc.id is null then raise exception 'Recebimento não encontrado'; end if;
  if rc.status = 'POSTED' then raise exception 'Recebimento já lançado no estoque' using errcode = 'P0083'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 24 then raise exception 'Validade do link: de 1 a 24 horas' using errcode = 'P0086'; end if;
  v_token := translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/', '-_');
  v_exp := now() + make_interval(hours => p_hours);
  insert into purch.receipt_scan_links (org_id, receipt_id, token_hash, created_by, label, expires_at)
  values (rc.org_id, rc.id, encode(extensions.digest(v_token, 'sha256'), 'hex'), private.member_id(), nullif(left(btrim(coalesce(p_label, '')), 80), ''), v_exp)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_exp);
end $$;

-- Encerra um link (ou todos os da nota, com p_link nulo)
create or replace function purch.revoke_scan_link(p_receipt uuid, p_link uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform private.require_perm('purch.write');
  update purch.receipt_scan_links set revoked_at = now()
   where receipt_id = p_receipt and org_id = private.org_id() and revoked_at is null and (p_link is null or id = p_link);
  get diagnostics n = row_count;
  return n;
end $$;

-- Valida o código do link: devolve o link (e marca que o celular está ligado) ou recusa
create or replace function private.scan_link(p_token text) returns purch.receipt_scan_links
language plpgsql security definer set search_path = '' as $$
declare l purch.receipt_scan_links;
begin
  if p_token is null or length(p_token) <> 24 then raise exception 'Link inválido' using errcode = 'P0090'; end if;
  select * into l from purch.receipt_scan_links where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if l.id is null then raise exception 'Link inválido' using errcode = 'P0090'; end if;
  if l.revoked_at is not null then raise exception 'Este link foi encerrado no computador' using errcode = 'P0090'; end if;
  if l.expires_at <= now() then raise exception 'Este link venceu: gere outro no computador' using errcode = 'P0090'; end if;
  -- quem gerou o link precisa continuar ativo e com permissão de bipar
  if not exists (select 1 from core.members m join core.member_roles mr on mr.member_id = m.id join core.roles r on r.id = mr.role_id
                  left join core.role_permissions rp on rp.role_id = r.id and rp.permission_key = 'purch.write'
                  where m.id = l.created_by and m.status = 'ACTIVE' and (r.is_superuser or rp.permission_key is not null)) then
    raise exception 'Link sem permissão: gere outro no computador' using errcode = 'P0090';
  end if;
  update purch.receipt_scan_links set last_seen_at = now() where id = l.id;
  return l;
end $$;

-- Celular: abre a nota (resumo + itens com foto)
create or replace function public.receipt_link_open(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l purch.receipt_scan_links; rc purch.receipts; d fiscal.documents;
begin
  l := private.scan_link(p_token);
  select * into rc from purch.receipts where id = l.receipt_id;
  select * into d from fiscal.documents where id = rc.document_id;
  return jsonb_build_object(
    'expires_at', l.expires_at, 'label', l.label,
    'summary', jsonb_build_object(
      'receiptNumber', rc.number, 'status', rc.status,
      'nfNumber', case when d.id is null then '—' else coalesce(d.number::text, '') || coalesce('/' || d.series::text, '') end,
      'issueAt', to_char(d.issue_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'),
      'supplier', coalesce((select display_name from crm.parties where id = rc.supplier_party_id), 'Fornecedor'),
      'supplierCnpj', d.counterpart_cnpj,
      'location', coalesce((select name from inv.locations where id = rc.location_id), '—'),
      'nfTotal', rc.nf_total, 'vProd', coalesce((d.totals ->> 'vProd')::numeric, 0),
      'vFrete', coalesce((d.totals ->> 'vFrete')::numeric, 0), 'vDesc', coalesce((d.totals ->> 'vDesc')::numeric, 0)),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'n_item', i.n_item, 'description', coalesce(i.description, ''), 'cprod', i.supplier_cprod, 'cean', i.cean,
        'qty_nfe', i.qty_nfe, 'qty_counted', coalesce(i.qty_counted, 0), 'item_total', i.item_total, 'variant_id', i.variant_id,
        'sku', v.sku, 'label', case when v.id is null then null else concat_ws(' · ', p.name, c.name, v.size) end,
        'photo', (select m.storage_path from catalog.product_media m where m.product_id = v.product_id
                   order by (m.color_id is not distinct from v.color_id) desc, m.position limit 1)) order by i.n_item)
      from purch.receipt_items i
      left join catalog.variants v on v.id = i.variant_id
      left join catalog.products p on p.id = v.product_id
      left join catalog.colors c on c.id = v.color_id
      where i.receipt_id = rc.id), '[]'));
end $$;

create or replace function public.receipt_link_scan(p_token text, p_code text, p_qty numeric default 1) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l purch.receipt_scan_links;
begin
  l := private.scan_link(p_token);
  return private.receipt_scan(l.org_id, l.receipt_id, p_code, p_qty, l.created_by, l.id);
end $$;

create or replace function public.receipt_link_bump(p_token text, p_item uuid, p_delta numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l purch.receipt_scan_links;
begin
  l := private.scan_link(p_token);
  if not exists (select 1 from purch.receipt_items where id = p_item and receipt_id = l.receipt_id) then raise exception 'Item não encontrado'; end if;
  return private.receipt_bump(l.org_id, p_item, p_delta, l.created_by, l.id);
end $$;

create or replace function public.receipt_link_feed(p_token text, p_after bigint default 0) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l purch.receipt_scan_links;
begin
  l := private.scan_link(p_token);
  return private.receipt_feed(l.receipt_id, p_after) - 'links' || jsonb_build_object('expires_at', l.expires_at);
end $$;

insert into private.internal_functions (fqname) values
  ('private.receipt_scan'), ('private.receipt_bump'), ('private.receipt_feed'), ('private.scan_link')
on conflict do nothing;
select private.lock_functions();

revoke execute on function public.receipt_link_open(text), public.receipt_link_scan(text, text, numeric),
  public.receipt_link_bump(text, uuid, numeric), public.receipt_link_feed(text, bigint) from public;
grant execute on function public.receipt_link_open(text), public.receipt_link_scan(text, text, numeric),
  public.receipt_link_bump(text, uuid, numeric), public.receipt_link_feed(text, bigint) to anon, authenticated, service_role;
