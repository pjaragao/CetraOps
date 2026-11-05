begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

-- ---------- Horários do cron ----------
select is((select count(*)::int from (select schedule from cron.job where jobname like 'centralops-%' and schedule ~ '^(0|\*/(5|10|15|30)|\*) ' group by schedule) s
           where (select count(*) from cron.job j where j.schedule = s.schedule and j.jobname like 'centralops-%') > 1), 0,
          'nenhum horário de virada de hora é dividido por duas rotinas');
select ok(exists (select 1 from cron.job where jobname = 'centralops-ops-watch') and exists (select 1 from cron.job where jobname = 'centralops-month-close-watch'),
          'plantão e lembrete do fechamento agendados');

-- ---------- Causa provável ----------
select alike(private.explain_error('Brasil NFe 404: serviço não encontrado'), '%endereço da API%', '404 → endereço da API');
select alike(private.explain_error('Stone/Pagar.me: credencial recusada'), '%credencial%', 'credencial recusada → gerar outra');
select alike(private.explain_error('job startup timeout'), '%relógio do servidor%', 'falha do pg_cron explicada (salto de relógio)');
select is(private.explain_error('algo inédito'), null, 'erro desconhecido fica sem causa (não inventa)');

-- ---------- Preparação (dono do banco) ----------
insert into crm.parties (id, org_id, kind, display_name) values
  ('00000000-0000-4000-8000-0000000077a1', '00000000-0000-4000-8000-000000000001', 'COMPANY', 'Fornecedor (teste 077)');
insert into core.integration_connections (org_id, provider, capability, status, last_error) values
  ('00000000-0000-4000-8000-000000000001', 'BRASIL_NFE', 'FISCAL', 'ERROR', 'Brasil NFe 404: ObterNotasFiscais não encontrado'),
  ('00000000-0000-4000-8000-000000000001', 'STONE', 'ACQUIRER', 'ACTIVE', null);
insert into ai.runs (org_id, route_task, status, error) values
  ('00000000-0000-4000-8000-000000000001', 'extract', 'ERROR', 'HTTP 503 unavailable'),
  ('00000000-0000-4000-8000-000000000001', 'extract', 'ERROR', 'HTTP 503 unavailable');
insert into fiscal.inbound_dfe (org_id, legal_entity_id, access_key, issuer_name, amount, issue_at, manifest_status) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '42260947624258000122550010000011521000000770', 'CABIDES (teste)', 900, '2026-09-20 10:00-03', 'CONFIRMADA');
insert into fin.reimbursements (org_id, number, legal_entity_id, party_id, purpose, status, total) values
  ('00000000-0000-4000-8000-000000000001', 'REE-T-077', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000077a1', 'Cabides', 'SUBMITTED', 450);
update fin.reimbursements set created_at = '2026-09-25 10:00-03' where number = 'REE-T-077';
-- aviso velho de uma integração que já voltou a funcionar
insert into core.notifications (org_id, member_id, kind, title, payload)
select m.org_id, m.id, 'INTEGRATION_ERROR', 'Integração STONE com erro: credencial recusada', '{}' from core.members m where m.user_id = '00000000-0000-4000-8000-0000000000f1';

-- ---------- Plantão ----------
select ok(exists (select 1 from private.ops_problems('00000000-0000-4000-8000-000000000001') p where p.area = 'Integração' and p.item = 'BRASIL_NFE' and p.cause like '%endereço%'),
          'integração com erro entra com a causa provável');
select ok(exists (select 1 from private.ops_problems('00000000-0000-4000-8000-000000000001') p where p.area = 'IA' and p.n = 2),
          'erros repetidos de IA entram agrupados por rota');
select ok(not exists (select 1 from private.ops_problems('00000000-0000-4000-8000-000000000001') p where p.item = 'STONE'), 'integração ativa não aparece');

select is(private.ops_watch(), 1, 'o plantão manda um resumo para a organização com problema');
select ok((select read_at is not null and payload ? 'resolvido_sozinho' from core.notifications where title = 'Integração STONE com erro: credencial recusada'),
          'aviso de integração que voltou a funcionar é fechado sozinho');
select is((select count(*)::int from core.notifications n join core.members m on m.id = n.member_id
           where n.kind = 'OPS_WATCH' and n.read_at is null and m.user_id = '00000000-0000-4000-8000-0000000000f1'), 1, 'o sócio recebe um aviso OPS_WATCH');
select private.ops_watch();
select is((select count(*)::int from core.notifications n join core.members m on m.id = n.member_id
           where n.kind = 'OPS_WATCH' and n.read_at is null and m.user_id = '00000000-0000-4000-8000-0000000000f1'), 1, 'rodar de novo substitui o resumo (não acumula)');

-- ---------- Fechamento do mês ----------
select is(private.month_close_watch('2026-10-20'), 0, 'depois do dia 15 não lembra');
select is(private.month_close_watch('2026-10-03'), 0, 'sábado não lembra');
select is(private.month_close_watch('2026-10-05'), 1, 'dia útil do início do mês: roda o checklist de setembro');
select ok((select n.payload -> 'itens' @> '[{"chave":"INBOUND_DFE"},{"chave":"REIMBURSEMENTS"}]' from core.notifications n
           where n.kind = 'MONTH_CLOSE' and n.read_at is null limit 1), 'o aviso lista a nota sem destino e o reembolso parado');
select ok((select title like 'Fechamento de 09/2026:%pendência(s)' from core.notifications where kind = 'MONTH_CLOSE' and read_at is null limit 1),
          'título diz o mês e quantas pendências');

-- ---------- Telas ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select ok((select count(*) from core.ops_status()) >= 2, 'o administrador vê o plantão na tela');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select * from core.ops_status() $$, '42501', null, 'a vendedora não vê o plantão');

select * from finish();
rollback;
