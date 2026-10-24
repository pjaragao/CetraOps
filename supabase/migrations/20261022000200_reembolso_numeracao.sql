-- Reembolsos: número curto REE-AAAA-NNNN (4 dígitos), o mesmo padrão que já aparece na lista; as demais séries
-- (VEN, PC, PAG, RCB...) seguem com 6 dígitos. O bot do WhatsApp passa a pegar o número daqui, então tela e bot
-- compartilham um único contador.
create or replace function core.next_number(p_org uuid, p_doc_type text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v bigint;
  y int := extract(year from (now() at time zone 'America/Sao_Paulo'))::int;
begin
  insert into core.document_sequences as ds (org_id, doc_type, year, last_value)
  values (p_org, p_doc_type, y, 1)
  on conflict (org_id, doc_type, year) do update set last_value = ds.last_value + 1
  returning ds.last_value into v;
  return p_doc_type || '-' || y || '-' || lpad(v::text, case when p_doc_type = 'REE' then 4 else 6 end, '0');
end $$;

-- O contador de REE acompanha o maior número já usado no ano (idempotente)
update core.document_sequences ds
   set last_value = greatest(0, coalesce((select max(substring(r.number from '(\d+)$')::int) from fin.reimbursements r
                                          where r.org_id = ds.org_id and r.number like 'REE-' || ds.year || '-%'), 0))
 where ds.doc_type = 'REE';
