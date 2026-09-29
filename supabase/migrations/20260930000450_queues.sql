-- =====================================================================
-- Filas (Supabase Queues / pgmq). Cada fila tem uma DLQ; o worker move a mensagem para a DLQ quando read_ct > 5.
-- Enfileirar na MESMA transação da escrita de domínio = outbox transacional.
-- =====================================================================
do $$
declare q text;
begin
  foreach q in array array[
    'inbound_events', 'conversation_router', 'outbound_messages', 'media_processing',
    'fiscal_emission', 'acquirer_sync', 'bank_sync', 'ai_tasks', 'capi_events', 'notifications'
  ] loop
    perform pgmq.create(q);
    perform pgmq.create(q || '_dlq');
  end loop;
end $$;

-- Wrapper para enfileirar a partir das funções de domínio (search_path vazio nas funções security definer)
create or replace function private.enqueue(p_queue text, p_payload jsonb, p_delay int default 0) returns bigint
language sql security definer set search_path = '' as $$
  select pgmq.send(p_queue, p_payload, p_delay)
$$;
revoke execute on function private.enqueue(text, jsonb, int) from public, anon, authenticated;
