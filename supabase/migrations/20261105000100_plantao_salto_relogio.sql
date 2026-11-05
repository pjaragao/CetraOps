-- Plantão do sistema (05/11/2026): "job startup timeout" deixa de virar problema em aberto quando a rotina já voltou a rodar.
--   As falhas de 04 e 05/11 não eram rotinas demais no mesmo minuto: o relógio do Windows (homelab) estava ~34 s adiantado e sem
--   sincronizar, o WSL alternava entre a hora do Windows e a da internet, e a cada salto o pg_cron perdia as rotinas daquele minuto
--   (sempre 34 s de atraso antes da falha). A causa provável passa a dizer isso, e a rotina só aparece no plantão se ainda está
--   falhando (última rodada com erro) ou falhou em 10% ou mais das rodadas. Os outros erros seguem a regra de antes (3 em 24 h).

create or replace function private.explain_error(p text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p is null then null
    when p ~* 'job startup timeout' then 'o agendador não conseguiu abrir a conexão a tempo: relógio do servidor que saltou (sincronize a hora do Windows/servidor) ou banco reiniciando; se a última rodada deu certo, não precisa fazer nada'
    when p ~* 'certificad' then 'certificado digital vencido, ausente ou com senha errada: confira em Configurações › Integrações'
    when p ~* '(\m401\M|\m403\M|credencial|recusad|unauthori|forbidden|secret key|token inv)' then 'credencial inválida ou expirada: gere outra no painel do provedor e salve em Integrações'
    when p ~* '(\m404\M|não encontrad|not found)' then 'endereço da API errado ou serviço não contratado no provedor: confira a URL e o plano'
    when p ~* '(\m429\M|rate limit|too many)' then 'limite de chamadas do provedor: costuma passar sozinho; se repetir, diminua a frequência'
    when p ~* '(timeout|fora do ar|inacess|connect|\m50[234]\M|unavailable)' then 'serviço do provedor fora do ar ou lento: costuma voltar sozinho'
    when p ~* '(orçamento|budget)' then 'orçamento diário da rota de IA esgotado: aumente em Inteligência › Modelos & custos'
  end
$$;

create or replace function private.ops_problems(p_org uuid)
returns table (area text, item text, detail text, cause text, n int, href text, since timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare q record; v_depth bigint;
begin
  -- integrações com erro
  for area, item, detail, n, href, since in
    select 'Integração', c.provider, coalesce(c.last_error, 'falha na verificação'), 1, '/configuracoes/integracoes', c.updated_at
    from core.integration_connections c where c.org_id = p_org and c.status = 'ERROR' loop
    cause := private.explain_error(detail); return next;
  end loop;

  -- filas de mensagens que falharam de vez (comuns a todas as organizações)
  begin
    for q in select queue_name from pgmq.list_queues() where right(queue_name, 4) = '_dlq' loop
      select queue_length into v_depth from pgmq.metrics(q.queue_name);
      continue when coalesce(v_depth, 0) = 0;
      area := 'Fila com falhas'; item := q.queue_name; n := v_depth; since := null; href := '/configuracoes/integracoes';
      detail := v_depth || ' mensagem(ns) desistiram depois das novas tentativas';
      cause := 'o worker não conseguiu processar; veja o erro da integração ligada à fila e reprocesse depois de corrigir';
      return next;
    end loop;
  exception when others then null;   -- sem pgmq (banco de teste): segue sem as filas
  end;

  -- rotinas agendadas que falharam nas últimas 24 h (3 ou mais vezes). "job startup timeout" é o pg_cron sem conseguir abrir a conexão
  -- a tempo (relógio do servidor que saltou, banco reiniciando): só conta se a rotina ainda está falhando (a última rodada falhou)
  -- ou se falhou em 10% ou mais das rodadas; falha avulsa que já voltou a rodar não é problema em aberto.
  begin
    for area, item, detail, n, since in
      select 'Rotina agendada', j.jobname, max(d.return_message) filter (where d.status = 'failed'),
             count(*) filter (where d.status = 'failed')::int, max(d.start_time) filter (where d.status = 'failed')
      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where d.start_time > now() - interval '24 hours' and j.jobname like 'centralops-%' and d.status in ('succeeded', 'failed')
      group by j.jobname
      having count(*) filter (where d.status = 'failed') >= 3
         and (bool_or(d.status = 'failed' and d.return_message !~* 'job startup timeout')
              or (array_agg(d.status order by d.start_time desc))[1] = 'failed'
              or count(*) filter (where d.status = 'failed') >= 0.1 * count(*)) loop
      detail := n || ' falha(s) em 24 h: ' || left(coalesce(detail, ''), 160); href := null;
      cause := private.explain_error(detail); return next;
    end loop;
  exception when others then null;
  end;

  -- chamadas de IA com erro nas últimas 24 h
  for area, item, detail, n, since in
    select 'IA', r.route_task, max(r.error), count(*)::int, max(r.created_at)
    from ai.runs r where r.org_id = p_org and r.status = 'ERROR' and r.created_at > now() - interval '24 hours'
    group by r.route_task having count(*) >= 2 loop
    detail := n || ' erro(s) em 24 h: ' || left(coalesce(detail, ''), 160); href := '/ia/modelos';
    cause := coalesce(private.explain_error(detail), 'modelo da rota fora do ar ou sem chave: confira em Inteligência › Modelos & custos'); return next;
  end loop;

  -- leituras da IA que falharam (ficaram esperando uma pessoa)
  for area, item, detail, n, href, since in
    select 'Recebimento', r.number, coalesce(r.ai_note, 'a sugestão da IA falhou'), 1, '/produtos/recebimento/' || r.id, r.created_at
    from purch.receipts r where r.org_id = p_org and r.ai_status = 'FAILED' and r.status <> 'POSTED' loop
    cause := coalesce(private.explain_error(detail), 'peça a sugestão de novo na tela do recebimento'); return next;
  end loop;
  for area, item, detail, n, href, since in
    select 'Nota recebida', coalesce(d.issuer_name, d.access_key), coalesce(d.triage_note, 'a triagem da IA falhou'), 1, '/fiscal/recebidas/nota/' || d.access_key, d.triage_at
    from fiscal.inbound_dfe d where d.org_id = p_org and d.triage_status = 'FAILED' and d.destination is null loop
    cause := coalesce(private.explain_error(detail), 'escolha o destino na tela da nota'); return next;
  end loop;
end $$;
