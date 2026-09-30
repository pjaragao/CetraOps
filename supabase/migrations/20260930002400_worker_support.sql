-- =====================================================================
-- Suporte ao worker: mensagens de sistema (opt-out, espera), payload da NFC-e/NF-e e registro do resultado da emissão.
-- Só service_role.
-- =====================================================================

-- Ordem das linhas do pedido: o cupom fiscal (e as telas) seguem a ordem em que os itens foram lançados, não a de um UUID aleatório
alter table sales.order_items add column if not exists line_no bigint generated always as identity;

-- Mensagem automática (confirmação de opt-out, aviso de espera): respeita a janela e vai pela mesma fila de envio
create or replace function omni.queue_system_message(p_conversation uuid, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cv omni.conversations; w record; m omni.messages;
begin
  select * into cv from omni.conversations where id = p_conversation;
  if cv.id is null then raise exception 'Conversa não encontrada' using errcode = 'P0002'; end if;
  select * into w from omni.check_send_window(cv.id, 'AI');
  if not w.allowed then return null; end if;
  insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, body, status, client_dedupe_key, payload)
  values (cv.org_id, cv.id, cv.channel_account_id, 'OUT', 'SYSTEM', p_body, 'QUEUED', gen_random_uuid()::text, jsonb_build_object('send_mode', w.mode))
  returning * into m;
  perform private.enqueue('outbound_messages', jsonb_build_object('message_id', m.id, 'org_id', cv.org_id));
  return m.id;
end $$;

-- ---------------------------------------------------------------------
-- Payload de emissão fiscal (formato Focus NFe v2, NFC-e). A matriz CFOP/CSOSN e o modelo para vendas com entrega
-- são CONFIGURAÇÃO a validar com o contador (core.settings: fiscal_matrix).
-- ---------------------------------------------------------------------
create or replace function fiscal.emission_payload(p_order uuid, p_purpose text default 'SALE') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o sales.orders; le core.legal_entities; matrix jsonb; v_items jsonb; v_pay jsonb; v_model text; v_items_sum numeric; v_coupon numeric; v_ratio numeric;
begin
  select * into o from sales.orders where id = p_order;
  if o.id is null then raise exception 'Pedido não encontrado' using errcode = 'P0002'; end if;
  select * into le from core.legal_entities where id = o.legal_entity_id;
  select value into matrix from core.settings where org_id = o.org_id and key = 'fiscal_matrix';
  matrix := coalesce(matrix, '{}');
  if p_purpose <> 'SALE' then
    return jsonb_build_object('ref', o.id::text || ':' || p_purpose, 'purpose', p_purpose, 'requires_review', true, 'order_number', o.number,
      'note', 'Devolução: o tratamento fiscal (cancelamento da NFC-e ou NF-e de entrada) depende da matriz validada com o contador');
  end if;
  v_model := case when o.channel = 'B2B' then '55'
                  when o.fulfillment_type in ('MOTOBOY', 'CARRIER') then coalesce(matrix ->> 'remote_delivery_model', '65') else '65' end;
  select coalesce(sum(total), 0) into v_items_sum from sales.order_items where order_id = o.id;
  select coalesce(sum(amount), 0) into v_coupon from sales.coupon_redemptions where order_id = o.id;
  v_ratio := case when v_items_sum > 0 then greatest(1 - v_coupon / v_items_sum, 0) else 1 end;

  select jsonb_agg(jsonb_build_object(
      'numero_item', x.n, 'codigo_produto', x.sku, 'descricao', x.name || ' ' || x.color || ' ' || x.size, 'codigo_ncm', coalesce(x.ncm, matrix ->> 'default_ncm'),
      'cfop', coalesce(matrix ->> 'cfop_balcao', '5102'), 'unidade_comercial', 'UN', 'quantidade_comercial', x.qty, 'valor_unitario_comercial', x.list_price,
      'valor_bruto', round(x.list_price * x.qty, 2), 'unidade_tributavel', 'UN', 'quantidade_tributavel', x.qty, 'valor_unitario_tributavel', x.list_price,
      'valor_desconto', round(x.list_price * x.qty - x.total * v_ratio, 2), 'icms_origem', x.origin,
      'icms_situacao_tributaria', coalesce(matrix ->> 'csosn', '102'), 'inclui_no_total', 1) order by x.n) into v_items
  from (select row_number() over (order by i.line_no) as n, v.sku, p.name, coalesce(c.name, '') as color, v.size, p.ncm, p.origin, i.qty, i.list_price, i.total
        from sales.order_items i join catalog.variants v on v.id = i.variant_id join catalog.products p on p.id = v.product_id left join catalog.colors c on c.id = v.color_id
        where i.order_id = o.id) x;

  select jsonb_agg(jsonb_build_object('forma_pagamento', case pm.method when 'CASH' then '01' when 'CREDIT' then '03' when 'DEBIT' then '04' when 'PIX' then '17' when 'PAYMENT_LINK' then '03'
      when 'BOLETO' then '15' when 'STORE_CREDIT' then '05' when 'PERMUTA' then '99' else '99' end, 'valor_pagamento', pm.amount)) into v_pay
  from sales.payments pm where pm.order_id = o.id and pm.status in ('AUTHORIZED', 'CAPTURED');

  return jsonb_build_object('ref', o.id::text || ':SALE', 'purpose', 'SALE', 'model', v_model, 'order_id', o.id, 'order_number', o.number, 'legal_entity_id', o.legal_entity_id,
    'provider_ref', le.fiscal_provider_ref, 'series', case when v_model = '65' then le.nfce_series else le.nfe_series end,
    'document', jsonb_build_object('natureza_operacao', 'VENDA AO CONSUMIDOR', 'data_emissao', to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI:SS') || '-03:00',
      'presenca_comprador', case when o.fulfillment_type in ('MOTOBOY', 'CARRIER') then 4 else 1 end, 'modalidade_frete', case when o.fulfillment_type in ('MOTOBOY', 'CARRIER') then 0 else 9 end,
      'local_destino', 1, 'finalidade_emissao', 1, 'consumidor_final', 1, 'cnpj_emitente', le.cnpj, 'cpf_destinatario', nullif(regexp_replace(coalesce(o.cpf_on_invoice, ''), '\D', '', 'g'), ''),
      'valor_frete', case when o.shipping_total > 0 then o.shipping_total end, 'itens', v_items, 'formas_pagamento', v_pay));
end $$;

-- Resultado da emissão (assíncrona): grava/atualiza o documento fiscal de saída de forma idempotente por ref
-- p = {ref, order_id, legal_entity_id, model, status: PROCESSING|AUTHORIZED|REJECTED|CANCELLED|DENIED, series?, number?, access_key?, protocol?, sefaz_code?, sefaz_msg?, provider_ref?, xml_path?, danfe_path?, event?}
create or replace function fiscal.record_emission(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o sales.orders; d fiscal.documents; v_status text := p ->> 'status';
begin
  if v_status not in ('PROCESSING', 'AUTHORIZED', 'REJECTED', 'CANCELLED', 'DENIED') then raise exception 'Situação fiscal inválida: %', v_status using errcode = 'P0103'; end if;
  select * into o from sales.orders where id = (p ->> 'order_id')::uuid;
  if o.id is null then raise exception 'Pedido não encontrado' using errcode = 'P0002'; end if;
  insert into fiscal.documents (org_id, legal_entity_id, direction, model, series, number, access_key, status, issue_at, protocol, sefaz_code, sefaz_msg, counterpart_party_id,
                                totals, order_id, provider_ref, xml_path, danfe_path, idempotency_key, events)
  values (o.org_id, o.legal_entity_id, 'OUT', coalesce(p ->> 'model', '65'), (p ->> 'series')::int, (p ->> 'number')::int, nullif(p ->> 'access_key', ''), v_status::text,
          case when v_status = 'AUTHORIZED' then now() end, p ->> 'protocol', p ->> 'sefaz_code', p ->> 'sefaz_msg', o.party_id,
          jsonb_build_object('vNF', o.total), o.id, p ->> 'provider_ref', p ->> 'xml_path', p ->> 'danfe_path', p ->> 'ref', jsonb_build_array(coalesce(p -> 'event', jsonb_build_object('status', v_status, 'at', now()))))
  on conflict (org_id, idempotency_key) where idempotency_key is not null do update set
    status = excluded.status, series = coalesce(excluded.series, fiscal.documents.series), number = coalesce(excluded.number, fiscal.documents.number),
    access_key = coalesce(excluded.access_key, fiscal.documents.access_key), protocol = coalesce(excluded.protocol, fiscal.documents.protocol),
    sefaz_code = excluded.sefaz_code, sefaz_msg = excluded.sefaz_msg, xml_path = coalesce(excluded.xml_path, fiscal.documents.xml_path),
    danfe_path = coalesce(excluded.danfe_path, fiscal.documents.danfe_path), issue_at = coalesce(fiscal.documents.issue_at, excluded.issue_at),
    events = fiscal.documents.events || excluded.events
  returning * into d;
  return d.id;
end $$;

-- Notificação de rejeição fiscal / alerta operacional para a inbox de notificações (tabela core.notifications se existir; senão fila)
create or replace function private.notify(p_org uuid, p_kind text, p_payload jsonb) returns void
language sql security definer set search_path = '' as $$
  select private.enqueue('notifications', jsonb_build_object('org_id', p_org, 'kind', p_kind) || p_payload)
$$;

insert into private.internal_functions (fqname) values ('omni.queue_system_message'), ('fiscal.emission_payload'), ('fiscal.record_emission')
on conflict do nothing;

select private.lock_functions();

-- ---------------------------------------------------------------------
-- Notificações para quem tem a permissão (ou para um membro específico)
-- ---------------------------------------------------------------------
create or replace function core.notify(p_org uuid, p_kind text, p_title text, p_payload jsonb default '{}', p_perm text default null, p_member uuid default null) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into core.notifications (org_id, member_id, kind, title, payload)
  select p_org, m.id, p_kind, p_title, p_payload from core.members m
  where m.org_id = p_org and m.status = 'ACTIVE' and (p_member is null or m.id = p_member)
    and (p_perm is null or exists (
      select 1 from core.member_roles mr join core.roles r on r.id = mr.role_id
      left join core.role_permissions rp on rp.role_id = r.id and rp.permission_key = p_perm
      where mr.member_id = m.id and (r.is_superuser or rp.permission_key is not null)));
  get diagnostics n = row_count;
  return n;
end $$;

-- Mídia baixada/transcrita: grava e devolve a mensagem ao roteador (que pode ter esperado a transcrição)
create or replace function omni.attach_media(p_message uuid, p_path text, p_transcript text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare m omni.messages; v_last uuid;
begin
  update omni.messages set media_path = coalesce(p_path, media_path), transcript = coalesce(p_transcript, transcript) where id = p_message returning * into m;
  if m.id is null then return; end if;
  select id into v_last from omni.messages where conversation_id = m.conversation_id and direction = 'IN' order by created_at desc, seq desc limit 1;
  if v_last = m.id and p_transcript is not null then
    perform private.enqueue('conversation_router', jsonb_build_object('conversation_id', m.conversation_id, 'message_id', m.id), 0);
  end if;
end $$;

insert into private.internal_functions (fqname) values ('core.notify'), ('omni.attach_media') on conflict do nothing;
select private.lock_functions();
