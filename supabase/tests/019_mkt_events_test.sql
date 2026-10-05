begin;
create extension if not exists pgtap with schema extensions;
select plan(59);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
create temp table ids (k text primary key, v text);
grant all on ids to authenticated;

-- ---------- Preparação (dono do banco) ----------
insert into crm.parties (id, org_id, kind, display_name) values
  ('00000000-0000-4000-8000-0000000009d1', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Convidada 1 (teste)'),
  ('00000000-0000-4000-8000-0000000009d2', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Convidada 2 (teste)'),
  ('00000000-0000-4000-8000-0000000009d3', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Convidada 3 (teste)'),
  ('00000000-0000-4000-8000-0000000009d4', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Convidada 4 (teste)');
insert into crm.parties (id, org_id, kind, display_name, merged_into_id) values ('00000000-0000-4000-8000-0000000009d5', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Duplicada (teste)', '00000000-0000-4000-8000-0000000009d1');

-- ---------- Sem permissão ----------
set local role anon;
select throws_ok($$ select mkt.save_event('{}') $$, '42501', null, 'anônimo não cria evento');
reset role;

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (crm.write)
-- ---------- Evento: validações ----------
select throws_ok($$ select mkt.save_event('{"kind":"DROP","name":"Oi","starts_at":"2026-12-10T19:00:00-03:00"}') $$, 'P0180', null, 'nome curto');
select throws_ok($$ select mkt.save_event('{"kind":"FESTA","name":"Drop 02","starts_at":"2026-12-10T19:00:00-03:00"}') $$, 'P0180', null, 'tipo inválido');
select throws_ok($$ select mkt.save_event('{"kind":"DROP","name":"Drop 02"}') $$, 'P0180', null, 'sem data');
select throws_ok($$ select mkt.save_event('{"kind":"DROP","name":"Drop 02","starts_at":"2026-12-10T19:00:00-03:00","ends_at":"2026-12-10T18:00:00-03:00"}') $$, 'P0180', null, 'fim antes do início');
select throws_ok($$ select mkt.save_event('{"kind":"DROP","name":"Drop 02","starts_at":"2026-12-10T19:00:00-03:00","capacity":-1}') $$, 'P0180', null, 'capacidade negativa');
select throws_ok($$ select mkt.save_event(jsonb_build_object('kind', 'DROP', 'name', 'Drop 02', 'starts_at', '2026-12-10T19:00:00-03:00', 'store_id', gen_random_uuid())) $$, 'P0180', null, 'loja inexistente');
select throws_ok($$ select mkt.save_event(jsonb_build_object('kind', 'DROP', 'name', 'Drop 02', 'starts_at', '2026-12-10T19:00:00-03:00', 'collection_id', gen_random_uuid())) $$, 'P0180', null, 'coleção inexistente');

-- ---------- Criar e editar ----------
insert into ids select 'ev', (mkt.save_event(jsonb_build_object('kind', 'drop', 'name', 'Drop 02 — Inverno', 'store_id', '00000000-0000-4000-8000-0000000000a1', 'starts_at', (now() - interval '1 day'), 'ends_at', (now() - interval '1 day' + interval '3 hours'),
  'capacity', 2, 'target_revenue', 8000, 'venue', 'Loja Piloto', 'create_cost_center', true))).id::text;
select is((select kind || '/' || status || '/' || capacity from mkt.events where id = (select v from ids where k = 'ev')::uuid), 'DROP/PLANNED/2', 'tipo em maiúsculas, nasce planejado');
reset role;
select is((select c.kind::text || '/' || (c.code like 'EVT-%') || '/' || (c.parent_id = '00000000-0000-4000-8000-0000000000c2') from mkt.events e join core.cost_centers c on c.id = e.cost_center_id where e.id = (select v from ids where k = 'ev')::uuid), 'PROJECT_EVENT/true/true', 'cria o centro de custo do projeto, filho da loja');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is((mkt.save_event(jsonb_build_object('id', (select v from ids where k = 'ev'), 'kind', 'DROP', 'name', 'Drop 02 — Coleção Inverno (teste)', 'starts_at', (select starts_at from mkt.events where id = (select v from ids where k = 'ev')::uuid), 'capacity', 2))).name, 'Drop 02 — Coleção Inverno (teste)', 'edita o evento');
select throws_ok($$ select mkt.save_event(jsonb_build_object('id', gen_random_uuid(), 'kind', 'DROP', 'name', 'Fantasma', 'starts_at', now())) $$, 'P0182', null, 'evento inexistente');

-- ---------- Convidadas ----------
select throws_ok($$ select mkt.invite_guests((select v from ids where k = 'ev')::uuid, '{}'::uuid[]) $$, 'P0180', null, 'sem ninguém para convidar');
select throws_ok($$ select mkt.invite_guests((select v from ids where k = 'ev')::uuid, array['00000000-0000-4000-8000-0000000009d1']::uuid[], 'ROBO') $$, 'P0180', null, 'origem inválida');
select is(mkt.invite_guests((select v from ids where k = 'ev')::uuid, array['00000000-0000-4000-8000-0000000009d1', '00000000-0000-4000-8000-0000000009d2', '00000000-0000-4000-8000-0000000009d3', '00000000-0000-4000-8000-0000000009d4',
  '00000000-0000-4000-8000-0000000009d5', gen_random_uuid()]::uuid[], 'CUSTOMER'), 4, 'convida quatro (pessoa duplicada e inexistente ficam de fora)');
select is(mkt.invite_guests((select v from ids where k = 'ev')::uuid, array['00000000-0000-4000-8000-0000000009d1']::uuid[]), 0, 'não convida duas vezes');
select is((select count(*)::int from crm.deals d join crm.pipelines p on p.id = d.pipeline_id where p.kind = 'EVENT' and d.title = 'Drop 02 — Coleção Inverno (teste)'), 4, 'cada convidada vira oportunidade no funil de eventos');
select is((select count(*)::int from mkt.event_guests g join crm.deals d on d.id = g.deal_id join crm.pipeline_stages s on s.id = d.stage_id where g.event_id = (select v from ids where k = 'ev')::uuid and s.position = 1), 4, 'todas começam em "Convidada"');
select ok(exists (select 1 from crm.timeline_events where party_id = '00000000-0000-4000-8000-0000000009d1' and kind = 'EVENT_INVITED'), 'convite na linha do tempo');
insert into ids select 'g1', id::text from mkt.event_guests where party_id = '00000000-0000-4000-8000-0000000009d1';
insert into ids select 'g2', id::text from mkt.event_guests where party_id = '00000000-0000-4000-8000-0000000009d2';
insert into ids select 'g3', id::text from mkt.event_guests where party_id = '00000000-0000-4000-8000-0000000009d3';
insert into ids select 'g4', id::text from mkt.event_guests where party_id = '00000000-0000-4000-8000-0000000009d4';

-- ---------- RSVP e capacidade ----------
select throws_ok($$ select mkt.set_rsvp((select v from ids where k = 'g1')::uuid, 'TALVEZ') $$, 'P0180', null, 'situação inválida');
select throws_ok($$ select mkt.set_rsvp((select v from ids where k = 'g1')::uuid, 'CONFIRMED', 9) $$, 'P0180', null, 'acompanhantes de 0 a 5');
select throws_ok($$ select mkt.set_rsvp(gen_random_uuid(), 'CONFIRMED') $$, 'P0182', null, 'convidada inexistente');
select is((mkt.set_rsvp((select v from ids where k = 'g1')::uuid, 'CONFIRMED')).rsvp_status, 'CONFIRMED', 'confirma');
select is((select s.position from mkt.event_guests g join crm.deals d on d.id = g.deal_id join crm.pipeline_stages s on s.id = d.stage_id where g.id = (select v from ids where k = 'g1')::uuid), 2, 'a oportunidade vai para "Confirmou presença"');
select is((mkt.set_rsvp((select v from ids where k = 'g2')::uuid, 'CONFIRMED', 1)).rsvp_status, 'WAITLIST', 'com acompanhante passaria da capacidade (2): lista de espera');
select is((select s.position from mkt.event_guests g join crm.deals d on d.id = g.deal_id join crm.pipeline_stages s on s.id = d.stage_id where g.id = (select v from ids where k = 'g2')::uuid), 1, 'e continua como convidada no funil');
select is((mkt.set_rsvp((select v from ids where k = 'g3')::uuid, 'CONFIRMED')).rsvp_status, 'CONFIRMED', 'a próxima cabe');
select is((mkt.event_results((select v from ids where k = 'ev')::uuid) ->> 'headcount')::int, 2, 'ocupação = confirmadas + acompanhantes');
select throws_ok($$ select mkt.set_rsvp((select v from ids where k = 'g4')::uuid, 'ATTENDED') $$, 'P0181', null, 'lotado: não registra presença de quem não estava confirmada');
select is((mkt.set_rsvp((select v from ids where k = 'g2')::uuid, 'DECLINED')).rsvp_status, 'DECLINED', 'recusa');
select is((select d.status || '/' || d.lost_reason from mkt.event_guests g join crm.deals d on d.id = g.deal_id where g.id = (select v from ids where k = 'g2')::uuid), 'LOST/Recusou o convite', 'recusa encerra a oportunidade com motivo');
select ok((mkt.set_rsvp((select v from ids where k = 'g1')::uuid, 'ATTENDED')).checked_in_at is not null, 'presença marca a hora');
select is((select s.position from mkt.event_guests g join crm.deals d on d.id = g.deal_id join crm.pipeline_stages s on s.id = d.stage_id where g.id = (select v from ids where k = 'g1')::uuid), 3, 'oportunidade em "Compareceu"');
select throws_ok($$ select mkt.remove_guest((select v from ids where k = 'g1')::uuid) $$, 'P0181', null, 'quem compareceu não sai da lista');
select lives_ok($$ select mkt.remove_guest((select v from ids where k = 'g4')::uuid) $$, 'remove convidada que não respondeu');
select is((select count(*)::int from crm.deals where party_id = '00000000-0000-4000-8000-0000000009d4' and title = 'Drop 02 — Coleção Inverno (teste)'), 0, 'e a oportunidade dela');

-- ---------- Orçamento ----------
select throws_ok($$ select mkt.save_budget_line(jsonb_build_object('event_id', (select v from ids where k = 'ev'), 'category', 'X', 'planned', 100)) $$, 'P0180', null, 'categoria curta');
select throws_ok($$ select mkt.save_budget_line(jsonb_build_object('event_id', (select v from ids where k = 'ev'), 'category', 'Buffet', 'planned', -1)) $$, 'P0180', null, 'valor negativo');
select throws_ok($$ select mkt.save_budget_line(jsonb_build_object('event_id', gen_random_uuid(), 'category', 'Buffet', 'planned', 100)) $$, 'P0182', null, 'evento inexistente');
insert into ids select 'bl', (mkt.save_budget_line(jsonb_build_object('event_id', (select v from ids where k = 'ev'), 'category', 'Buffet', 'planned', 1500, 'memo', 'Café e quitutes'))).id::text;
select is((mkt.save_budget_line(jsonb_build_object('id', (select v from ids where k = 'bl'), 'event_id', (select v from ids where k = 'ev'), 'category', 'Buffet', 'planned', 1800))).planned, 1800.00, 'edita linha');
select lives_ok($$ select mkt.save_budget_line(jsonb_build_object('event_id', (select v from ids where k = 'ev'), 'category', 'Fotografia', 'planned', 700)) $$, 'segunda linha');
select lives_ok($$ select mkt.delete_budget_line((select v from ids where k = 'bl')::uuid) $$, 'exclui linha');
select throws_ok($$ select mkt.delete_budget_line((select v from ids where k = 'bl')::uuid) $$, 'P0182', null, 'linha já excluída');

-- ---------- Resultado ----------
reset role;
insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, subtotal, total, cost_total, idempotency_key) values
  ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'EVT-1', 'POS', 'PAID', '00000000-0000-4000-8000-0000000009d1', 1000, 1000, 400, 'evt-1'),
  ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'EVT-2', 'POS', 'CANCELLED', '00000000-0000-4000-8000-0000000009d3', 500, 500, 200, 'evt-2'),
  ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'EVT-3', 'POS', 'PAID', '00000000-0000-4000-8000-000000000501', 900, 900, 300, 'evt-3');
select private.insert_title(jsonb_build_object('direction', 'PAYABLE', 'legal_entity_id', (select id from core.legal_entities limit 1), 'description', 'Buffet do Drop 02', 'document_kind', 'NF', 'competence_date', current_date, 'issue_date', current_date,
  'installments', jsonb_build_array(jsonb_build_object('due_date', current_date + 10, 'amount', 300)), 'approval_status', 'APPROVED',
  'lines', jsonb_build_array(jsonb_build_object('chart_account_id', private.acct('00000000-0000-4000-8000-000000000001', 'AFFILIATE_EXPENSE'), 'cost_center_id', (select cost_center_id from mkt.events where id = (select v from ids where k = 'ev')::uuid), 'amount', 300))), null);
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((mkt.event_results((select v from ids where k = 'ev')::uuid) ->> 'revenue')::numeric, 1000.00, 'receita = pedidos pagos das convidadas na janela (cancelado e não convidada ficam fora)');
select is((mkt.event_results((select v from ids where k = 'ev')::uuid) ->> 'margin')::numeric, 600.00, 'margem = receita − custo das mercadorias');
select is((mkt.event_results((select v from ids where k = 'ev')::uuid) ->> 'spent')::numeric, 300.00, 'custo real = títulos do Financeiro no centro de custo do evento');
select is((mkt.event_results((select v from ids where k = 'ev')::uuid) ->> 'roi')::numeric, 1.0000, 'ROI = (margem − custo) / custo');
select is((mkt.event_results((select v from ids where k = 'ev')::uuid) ->> 'planned')::numeric, 700.00, 'orçado = soma das linhas');
select is((mkt.event_results((select v from ids where k = 'ev')::uuid) -> 'guests' ->> 'CONFIRMED')::int, 1, 'contagem por situação');
select is((select orders::text || '/' || revenue from mkt.event_guest_sales((select v from ids where k = 'ev')::uuid) where party_id = '00000000-0000-4000-8000-0000000009d1'), '1/1000.00', 'quanto cada convidada comprou');
select is((select count(*)::int from mkt.event_guest_sales((select v from ids where k = 'ev')::uuid)), 1, 'só quem comprou aparece');

-- ---------- Encerrar ----------
select throws_ok($$ select mkt.set_event_status((select v from ids where k = 'ev')::uuid, 'TALVEZ') $$, 'P0180', null, 'situação inválida');
select is((mkt.set_event_status((select v from ids where k = 'ev')::uuid, 'CONFIRMED')).status, 'CONFIRMED', 'confirma o evento');
select is((mkt.set_event_status((select v from ids where k = 'ev')::uuid, 'DONE')).status, 'DONE', 'encerra');
select is((select rsvp_status from mkt.event_guests where id = (select v from ids where k = 'g3')::uuid), 'NO_SHOW', 'quem confirmou e não apareceu vira "não veio"');
select is((select d.status from mkt.event_guests g join crm.deals d on d.id = g.deal_id where g.id = (select v from ids where k = 'g3')::uuid), 'LOST', 'e a oportunidade é perdida');
select throws_ok($$ select mkt.set_event_status((select v from ids where k = 'ev')::uuid, 'PLANNED') $$, 'P0181', null, 'evento encerrado não volta');
select throws_ok($$ select mkt.invite_guests((select v from ids where k = 'ev')::uuid, array['00000000-0000-4000-8000-0000000009d4']::uuid[]) $$, 'P0181', null, 'encerrado não recebe convidadas');
select ok(not has_function_privilege('authenticated', 'private.event_headcount(uuid)', 'execute') and has_function_privilege('authenticated', 'mkt.set_rsvp(uuid,text,integer)', 'execute'), 'privilégios');

select * from finish();
rollback;
