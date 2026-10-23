-- Rotinas automáticas (23/10/2026): três procedimentos que passam a rodar sozinhos.
--   1) Rotinas agendadas em minutos diferentes: na virada da hora cerca de 12 jobs do pg_cron começavam juntos e parte falhava com
--      "job startup timeout" (178 falhas em 7 dias). Agora no máximo 2 ou 3 começam no mesmo minuto.
--   2) Plantão do sistema: private.ops_problems junta o que está quebrado (integração com erro, fila de falhas, rotina agendada falhando,
--      chamadas de IA com erro, leitura da IA que falhou) com a causa provável em português. Todo dia às 08:10 o plantão fecha sozinho os
--      avisos que já se resolveram (integração voltou, fila esvaziou, erro parou de repetir) e manda UM aviso OPS_WATCH ao administrador
--      no lugar de vários. A tela Configurações › Plantão do sistema (core.ops_status) mostra a mesma lista.
--   3) Fechamento do mês: o checklist ganha notas recebidas sem destino, recebimentos não lançados e reembolsos parados; do dia 1 ao 15,
--      em dia útil, private.month_close_watch roda o checklist do mês anterior e avisa quem cuida do financeiro (MONTH_CLOSE) até o mês
--      ser fechado. Nada é lançado nem fechado sozinho.

-- ---------------------------------------------------------------------
-- 1) Horários espalhados (mesmo comando, só muda o minuto)
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select j.jobname, j.command, x.sched
           from cron.job j join (values
             ('centralops-sweep-windows', '1-59/5 * * * *'), ('centralops-expire-reservations', '2-59/5 * * * *'),
             ('centralops-expire-locker-drops', '3-59/5 * * * *'), ('centralops-expire-pending-orders', '4-59/5 * * * *'),
             ('centralops-sweep-notices', '5-59/15 * * * *'), ('centralops-journeys', '10-59/15 * * * *'),
             ('centralops-sweep-cases', '6-59/15 * * * *'), ('centralops-close-campaigns', '8-59/15 * * * *'),
             ('centralops-check-queues', '12-59/15 * * * *'), ('centralops-sweep-ai-runs', '7-59/10 * * * *'),
             ('centralops-integration-health', '13,43 * * * *'), ('centralops-daily-briefing', '2 11 * * *'),
             ('centralops-ad-insights', '4 9 * * *'), ('centralops-hr-roll-vacations', '8 9 * * *')
           ) as x(jobname, sched) on x.jobname = j.jobname loop
    perform cron.unschedule(r.jobname);
    perform cron.schedule(r.jobname, r.sched, r.command);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2) Plantão do sistema
-- ---------------------------------------------------------------------
-- Causa provável de uma mensagem de erro (regras fixas, sem IA): o que costuma ser e o que fazer.
create or replace function private.explain_error(p text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p is null then null
    when p ~* 'job startup timeout' then 'muitas rotinas começando ao mesmo tempo com o banco ocupado; se repetir, espalhe os horários'
    when p ~* 'certificad' then 'certificado digital vencido, ausente ou com senha errada: confira em Configurações › Integrações'
    when p ~* '(\m401\M|\m403\M|credencial|recusad|unauthori|forbidden|secret key|token inv)' then 'credencial inválida ou expirada: gere outra no painel do provedor e salve em Integrações'
    when p ~* '(\m404\M|não encontrad|not found)' then 'endereço da API errado ou serviço não contratado no provedor: confira a URL e o plano'
    when p ~* '(\m429\M|rate limit|too many)' then 'limite de chamadas do provedor: costuma passar sozinho; se repetir, diminua a frequência'
    when p ~* '(timeout|fora do ar|inacess|connect|\m50[234]\M|unavailable)' then 'serviço do provedor fora do ar ou lento: costuma voltar sozinho'
    when p ~* '(orçamento|budget)' then 'orçamento diário da rota de IA esgotado: aumente em Inteligência › Modelos & custos'
  end
$$;

-- Lista do que está quebrado agora na organização (uma linha por problema).
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

  -- rotinas agendadas que falharam nas últimas 24 h (3 ou mais vezes)
  begin
    for area, item, detail, n, since in
      select 'Rotina agendada', j.jobname, max(d.return_message), count(*)::int, max(d.start_time)
      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where d.status = 'failed' and d.start_time > now() - interval '24 hours' and j.jobname like 'centralops-%'
      group by j.jobname having count(*) >= 3 loop
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

-- A mesma lista para a tela (administrador)
create or replace function core.ops_status()
returns table (area text, item text, detail text, cause text, n int, href text, since timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_perm('core.admin');
  return query select * from private.ops_problems(private.org_id());
end $$;

-- Plantão diário: fecha os avisos resolvidos e manda um resumo só
create or replace function private.ops_watch() returns int
language plpgsql security definer set search_path = '' as $$
declare o record; v_items jsonb; v_n int; v_sent int := 0;
begin
  -- integração que voltou a funcionar
  update core.notifications nt set read_at = now(), payload = nt.payload || '{"resolvido_sozinho": true}'
  where nt.read_at is null and nt.kind = 'INTEGRATION_ERROR' and nt.title like 'Integração % com erro:%'
    and not exists (select 1 from core.integration_connections c where c.org_id = nt.org_id and c.status = 'ERROR'
                    and nt.title like 'Integração ' || c.provider || ' com erro:%');
  -- erro que se repete a cada rodada (busca de notas, site) e parou de aparecer há 3 dias
  update core.notifications nt set read_at = now(), payload = nt.payload || '{"resolvido_sozinho": true}'
  where nt.read_at is null and nt.kind = 'INTEGRATION_ERROR' and nt.title not like 'Integração % com erro:%'
    and coalesce((nt.payload ->> 'ultima_vez')::timestamptz, nt.created_at) < now() - interval '3 days';
  -- fila de falhas que esvaziou
  begin
    update core.notifications nt set read_at = now(), payload = nt.payload || '{"resolvido_sozinho": true}'
    where nt.read_at is null and nt.kind = 'DLQ_ALERT' and nt.payload ? 'queue'
      and coalesce((select m.queue_length from pgmq.metrics(nt.payload ->> 'queue') m), 0) = 0;
  exception when others then null;
  end;

  for o in select id from core.orgs loop
    select count(*)::int, coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('area', p.area, 'item', p.item, 'detalhe', p.detail, 'causa', p.cause, 'href', p.href))), '[]')
      into v_n, v_items from private.ops_problems(o.id) p;
    -- o resumo novo substitui o anterior (que ficaria com a lista velha)
    update core.notifications set read_at = now() where org_id = o.id and kind = 'OPS_WATCH' and read_at is null;
    continue when v_n = 0;
    perform core.notify(o.id, 'OPS_WATCH', 'Plantão do sistema: ' || v_n || ' problema(s) em aberto', jsonb_build_object('itens', v_items, 'n', v_n), 'core.admin');
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $$;

-- ---------------------------------------------------------------------
-- 3) Fechamento do mês: checklist completo + lembrete automático
-- ---------------------------------------------------------------------
create or replace function fin.closing_checklist(p_entity uuid, p_competence date)
returns table (key text, label text, status text, detail text, n int, href text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from date := date_trunc('month', p_competence)::date;
  v_to date := (date_trunc('month', p_competence) + interval '1 month - 1 day')::date;
  v_n int; v_emps int; v_rules int; v_batch int; v_rev numeric; v_amt numeric;
begin
  perform private.require_perm('fin.read');
  if not exists (select 1 from core.legal_entities where id = p_entity and org_id = private.org_id()) then raise exception 'Empresa inválida'; end if;
  select count(*) into v_n from fin.statement_lines s where s.legal_entity_id = p_entity and s.posted_on between v_from and v_to and s.status in ('PENDING', 'PARTIAL');
  key := 'STATEMENT'; label := 'Extratos conciliados'; n := v_n; status := case when v_n = 0 then 'OK' else 'WARN' end;
  detail := case when v_n = 0 then 'Todas as linhas do extrato do mês estão conciliadas ou ignoradas' else v_n || ' linha(s) de extrato sem conciliar' end;
  href := '/financeiro/conciliacao'; return next;

  select count(*) into v_n from fin.cash_transactions t where t.legal_entity_id = p_entity and t.occurred_on between v_from and v_to and not t.reconciled and not t.voided
    and t.kind not in ('CASH_SALE');
  key := 'CASH'; label := 'Movimentos de caixa/banco conferidos'; n := v_n; status := case when v_n = 0 then 'OK' else 'WARN' end;
  detail := case when v_n = 0 then 'Todos os movimentos do mês têm lançamento no extrato' else v_n || ' movimento(s) sem par no extrato' end;
  href := '/financeiro/movimentacoes'; return next;

  select count(*) into v_n from fin.titles t where t.legal_entity_id = p_entity and t.competence_date between v_from and v_to and t.approval_status = 'DRAFT' and t.status <> 'CANCELLED';
  key := 'DRAFT_TITLES'; label := 'Contas a pagar aprovadas'; n := v_n; status := case when v_n = 0 then 'OK' else 'BLOCK' end;
  detail := case when v_n = 0 then 'Nenhum título do mês aguardando aprovação' else v_n || ' título(s) em rascunho com competência do mês' end;
  href := '/financeiro/pagar'; return next;

  -- notas emitidas contra o CNPJ até o fim do mês sem destino (nem mercadoria importada, nem despesa, patrimônio, reembolso…)
  select count(*), coalesce(sum(d.amount), 0) into v_n, v_amt from fiscal.inbound_dfe d
  where d.legal_entity_id = p_entity and d.issue_at < v_to + 1 and d.destination is null and d.document_id is null
    and d.manifest_status not in ('DESCONHECIDA', 'NAO_REALIZADA');
  key := 'INBOUND_DFE'; label := 'Notas recebidas com destino'; n := v_n; status := case when v_n = 0 then 'OK' else 'WARN' end;
  detail := case when v_n = 0 then 'Toda nota emitida contra o CNPJ virou estoque, despesa, patrimônio ou foi descartada'
                 else v_n || ' nota(s) recebida(s) sem destino (R$ ' || translate(to_char(v_amt, 'FM999,999,990.00'), ',.', '.,') || ')' end;
  href := '/fiscal/recebidas'; return next;

  select count(*) into v_n from purch.receipts r where r.legal_entity_id = p_entity and r.status <> 'POSTED' and r.created_at < v_to + 1;
  key := 'RECEIPTS'; label := 'Recebimentos lançados no estoque'; n := v_n; status := case when v_n = 0 then 'OK' else 'WARN' end;
  detail := case when v_n = 0 then 'Nenhuma nota de mercadoria esperando conferência' else v_n || ' recebimento(s) em conferência: o estoque e a conta a pagar ainda não entraram' end;
  href := '/produtos/recebimento'; return next;

  select count(*), coalesce(sum(r.total), 0) into v_n, v_amt from fin.reimbursements r
  where r.legal_entity_id = p_entity and r.status in ('SUBMITTED', 'APPROVED') and r.title_id is null and r.created_at < v_to + 1;
  key := 'REIMBURSEMENTS'; label := 'Reembolsos decididos'; n := v_n; status := case when v_n = 0 then 'OK' else 'WARN' end;
  detail := case when v_n = 0 then 'Nenhum reembolso esperando aprovação ou lançamento'
                 else v_n || ' reembolso(s) sem conta a pagar (R$ ' || translate(to_char(v_amt, 'FM999,999,990.00'), ',.', '.,') || '): a despesa ainda não está no mês' end;
  href := '/financeiro/reembolsos'; return next;

  select count(*) into v_emps from hr.employees e where e.legal_entity_id = p_entity and e.status = 'ACTIVE' and e.contract_type in ('CLT', 'INTERMITENTE', 'TEMPORARIO', 'APRENDIZ') and e.hire_date <= v_to;
  select count(*) into v_n from hr.payroll_runs r where r.legal_entity_id = p_entity and r.competence = v_from and r.kind = 'MONTHLY' and r.status in ('APPROVED', 'PAID');
  key := 'PAYROLL'; label := 'Folha do mês aprovada'; n := v_emps;
  status := case when v_emps = 0 or v_n > 0 then 'OK' else 'BLOCK' end;
  detail := case when v_emps = 0 then 'Sem colaboradores CLT no mês' when v_n > 0 then 'Folha aprovada' else 'Folha mensal ainda não aprovada' end;
  href := '/equipe/folha'; return next;

  select count(*) into v_n from hr.provision_runs pr where pr.legal_entity_id = p_entity and pr.competence = v_from;
  key := 'PROVISIONS'; label := 'Provisões de 13º, férias e FGTS'; n := v_n;
  status := case when v_emps = 0 or v_n > 0 then 'OK' else 'WARN' end;
  detail := case when v_emps = 0 or v_n > 0 then 'Provisionado' else 'Provisão do mês não lançada' end;
  href := '/equipe/folha'; return next;

  select count(*) into v_n from fiscal.tax_periods tp where tp.legal_entity_id = p_entity and tp.competence = v_from;
  select coalesce(sum(l.credit - l.debit), 0) into v_rev from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id join fin.chart_accounts a on a.id = l.account_id
    where e.legal_entity_id = p_entity and e.entry_date between v_from and v_to and a."group" = 'REVENUE' and e.ledger = 'LEGAL';
  key := 'DAS'; label := 'DAS do mês apurado'; n := v_n;
  status := case when v_n > 0 or v_rev <= 0 then 'OK' else 'WARN' end;
  detail := case when v_n > 0 then 'Guia gerada' when v_rev <= 0 then 'Sem receita no mês' else 'Receita apurada sem guia do DAS' end;
  href := '/fiscal'; return next;

  select count(*) into v_n from inv.stock_levels sl join inv.locations l on l.id = sl.location_id where l.legal_entity_id = p_entity and sl.on_hand < 0;
  key := 'NEGATIVE_STOCK'; label := 'Estoque sem saldo negativo'; n := v_n; status := case when v_n = 0 then 'OK' else 'WARN' end;
  detail := case when v_n = 0 then 'Nenhuma variante negativa' else v_n || ' variante(s) com saldo negativo' end;
  href := '/produtos/estoque'; return next;

  select count(*) into v_n from fin.v_open_installments i
    where i.legal_entity_id = p_entity and i.direction = 'RECEIVABLE' and i.due_date < v_to and i.days_overdue > 30;
  key := 'OVERDUE_AR'; label := 'Recebimentos em atraso (> 30 dias)'; n := v_n; status := case when v_n = 0 then 'OK' else 'WARN' end;
  detail := case when v_n = 0 then 'Sem atrasos relevantes' else v_n || ' parcela(s) a receber vencida(s) há mais de 30 dias' end;
  href := '/financeiro/receber'; return next;

  select count(*) into v_rules from fin.allocation_rules r where r.active and (r.legal_entity_id is null or r.legal_entity_id = p_entity);
  select count(*) into v_batch from fin.allocation_batches b where b.legal_entity_id = p_entity and b.competence = v_from and b.status = 'APPLIED';
  key := 'ALLOCATION'; label := 'Rateio por direcionadores'; n := v_rules;
  status := case when v_rules = 0 or v_batch > 0 then 'OK' else 'INFO' end;
  detail := case when v_rules = 0 then 'Sem regras de rateio cadastradas' when v_batch > 0 then 'Rateio aplicado' else 'Será aplicado automaticamente ao fechar' end;
  href := '/configuracoes/rateios'; return next;
end $$;

-- Lembrete do fechamento: dia 1 ao 15, em dia útil, até o mês anterior ser fechado. O checklist roda com a identidade do serviço
-- (claims locais à transação, só dentro desta função); o aviso vai para quem tem fin.write.
create or replace function private.month_close_watch(p_today date default null) returns int
language plpgsql security definer set search_path = '' as $$
declare
  e record; v_today date := coalesce(p_today, private.today_sp()); v_comp date; v_items jsonb; v_block int; v_warn int; v_sent int := 0; v_title text;
  v_prev text := current_setting('request.jwt.claims', true);
begin
  if extract(day from v_today) > 15 or extract(isodow from v_today) > 5 then return 0; end if;
  v_comp := (date_trunc('month', v_today) - interval '1 month')::date;
  for e in select le.id, le.org_id from core.legal_entities le loop
    continue when exists (select 1 from fin.periods p where p.legal_entity_id = e.id and p.competence = v_comp and p.status = 'CLOSED');
    perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role', 'app_metadata', jsonb_build_object('org_id', e.org_id))::text, true);
    select count(*) filter (where c.status = 'BLOCK')::int, count(*) filter (where c.status = 'WARN')::int,
           coalesce(jsonb_agg(jsonb_build_object('chave', c.key, 'item', c.label, 'situacao', c.status, 'detalhe', c.detail, 'href', c.href)
                              order by c.status, c.key) filter (where c.status in ('BLOCK', 'WARN')), '[]')
      into v_block, v_warn, v_items from fin.closing_checklist(e.id, v_comp) c;
    perform set_config('request.jwt.claims', coalesce(v_prev, ''), true);
    v_title := 'Fechamento de ' || to_char(v_comp, 'MM/YYYY') || ': '
               || case when v_block + v_warn = 0 then 'tudo pronto para fechar' else (v_block + v_warn) || ' pendência(s)' end;
    -- o aviso de hoje substitui o de ontem (que ficaria com a lista velha)
    update core.notifications set read_at = now()
    where org_id = e.org_id and kind = 'MONTH_CLOSE' and read_at is null and payload ->> 'competencia' = v_comp::text and title <> v_title;
    perform core.notify(e.org_id, 'MONTH_CLOSE', v_title,
                        jsonb_build_object('competencia', v_comp, 'legal_entity_id', e.id, 'bloqueios', v_block, 'avisos', v_warn, 'itens', v_items), 'fin.write');
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $$;

insert into private.internal_functions (fqname) values ('private.ops_problems'), ('private.ops_watch'), ('private.month_close_watch'), ('private.explain_error')
on conflict do nothing;
select private.lock_functions();

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('centralops-ops-watch', 'centralops-month-close-watch');
  perform cron.schedule('centralops-ops-watch', '10 11 * * *', 'select private.ops_watch()');            -- 08:10 em Brasília
  perform cron.schedule('centralops-month-close-watch', '20 11 * * *', 'select private.month_close_watch()');  -- 08:20
end $$;
