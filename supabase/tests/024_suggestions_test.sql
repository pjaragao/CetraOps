begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

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

-- ---------- Preparação: um pouco de cada problema ----------
insert into ids select 'variant', id::text from catalog.variants limit 1;
insert into inv.stock_levels (org_id, location_id, variant_id, on_hand) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000b1', (select v from ids where k = 'variant')::uuid, -3)
  on conflict (location_id, variant_id) do update set on_hand = -3;
insert into sales.cash_registers (id, org_id, store_id, name) values ('00000000-0000-4000-8000-0000000009f0', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'Caixa sugestões')
  on conflict do nothing;
insert into sales.cash_sessions (id, org_id, register_id, store_id, opened_by, opening_float, closed_by, closed_at, expected_cash, counted_cash, difference, status)
values ('00000000-0000-4000-8000-0000000009f1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009f0', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000102', 100,
        '00000000-0000-4000-8000-000000000102', now() - interval '3 hours', 500, 440, -60, 'CLOSED');
create function pg_temp.ord(p_n text, p_status text, p_sub numeric, p_disc numeric, p_total numeric, p_cost numeric, p_at timestamptz, p_seller uuid default null) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, seller_member_id, subtotal, discount_total, total, cost_total, idempotency_key, created_at)
  values ('00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'SUG-' || p_n, 'POS', p_status::sales.order_status, p_seller, p_sub, p_disc, p_total, p_cost, 'sug-' || p_n, p_at)
  returning id into v_id;
  return v_id;
end $$;
insert into ids select 'disc', pg_temp.ord('D1', 'PAID', 1000, 400, 600, 200, now() - interval '3 hours')::text;                    -- 40% de desconto
insert into ids select 'neg', pg_temp.ord('N1', 'PAID', 100, 0, 100, 250, now() - interval '3 hours')::text;                       -- vendido abaixo do custo
select pg_temp.ord('C' || g, 'CANCELLED', 100, 0, 100, 0, now() - interval '1 day', '00000000-0000-4000-8000-000000000102') from generate_series(1, 4) g;   -- 4 cancelamentos da vendedora
select pg_temp.ord('W' || w, 'PAID', 1000, 0, 1000, 400, (((now() at time zone 'America/Sao_Paulo')::date - 1 - 7 * w)::timestamp + interval '12 hours') at time zone 'America/Sao_Paulo') from generate_series(1, 4) w;   -- mesmo dia da semana nas 4 semanas anteriores
select pg_temp.ord('Y1', 'PAID', 100, 0, 100, 40, (((now() at time zone 'America/Sao_Paulo')::date - 1)::timestamp + interval '12 hours') at time zone 'America/Sao_Paulo');                 -- ontem vendeu pouco

-- ---------- Detecção ----------
select cmp_ok(private.detect_anomalies(), '>=', 6, 'a varredura abre as sugestões');
select is((select count(*)::int from ai.suggestions where status = 'OPEN' and payload ->> 'rule' = 'NEGATIVE_STOCK' and target_id = (select v from ids where k = 'variant')::uuid), 1, 'estoque negativo');
select is((select payload ->> 'severity' from ai.suggestions where payload ->> 'rule' = 'CASH_DIFFERENCE' and target_id = '00000000-0000-4000-8000-0000000009f1'), 'HIGH', 'diferença de caixa de R$ 60 é grave');
select is((select payload ->> 'title' from ai.suggestions where payload ->> 'rule' = 'DISCOUNT_OUTLIER' and target_id = (select v from ids where k = 'disc')::uuid), 'Desconto alto no pedido SUG-D1 (40%)', 'desconto fora do padrão, com o percentual');
select is((select payload ->> 'rule' from ai.suggestions where target_id = (select v from ids where k = 'neg')::uuid and payload ->> 'rule' = 'NEGATIVE_MARGIN'), 'NEGATIVE_MARGIN', 'margem negativa');
select is((select count(*)::int from ai.suggestions where payload ->> 'rule' = 'CANCELLATIONS' and target_id = '00000000-0000-4000-8000-000000000102'), 1, 'cancelamentos em série');
select is((select count(*)::int from ai.suggestions where payload ->> 'rule' = 'SALES_DROP' and status = 'OPEN'), 1, 'queda de vendas em relação ao mesmo dia da semana');
select ok((select bool_and(payload ? 'href' and payload ? 'detail' and payload ? 'title') from ai.suggestions where status = 'OPEN'), 'toda sugestão diz o que é, o que fazer e onde resolver');
select is(private.detect_anomalies(), 0, 'rodar de novo não duplica');
select ok(exists (select 1 from core.notifications where kind = 'SUGGESTION' and title like 'Estoque negativo%'), 'as graves avisam a equipe');
select cmp_ok((select count(*)::int from core.notifications where kind = 'SUGGESTION' and title like 'Pedido SUG-N1%'), '>=', 1, 'quem tem permissão na área de IA recebe o aviso');

-- ---------- Some sozinha quando resolve ----------
update inv.stock_levels set on_hand = 5 where variant_id = (select v from ids where k = 'variant')::uuid and location_id = '00000000-0000-4000-8000-0000000000b1';
select private.detect_anomalies();
select is((select status from ai.suggestions where payload ->> 'rule' = 'NEGATIVE_STOCK' and target_id = (select v from ids where k = 'variant')::uuid order by created_at desc limit 1), 'AUTO_APPLIED', 'saldo corrigido: a sugestão se encerra sozinha');
update inv.stock_levels set on_hand = -2 where variant_id = (select v from ids where k = 'variant')::uuid and location_id = '00000000-0000-4000-8000-0000000000b1';
select cmp_ok(private.detect_anomalies(), '>=', 1, 'se voltar a ficar negativo, abre outra');

-- ---------- Decidir ----------
insert into ids select 'sg', id::text from ai.suggestions where payload ->> 'rule' = 'CASH_DIFFERENCE' and target_id = '00000000-0000-4000-8000-0000000009f1';
insert into ids select 'sg2', id::text from ai.suggestions where payload ->> 'rule' = 'DISCOUNT_OUTLIER' and target_id = (select v from ids where k = 'disc')::uuid;
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora: lê (ai.read), não decide
select cmp_ok((select count(*)::int from ai.suggestions), '>=', 6, 'quem tem acesso à área de IA vê as sugestões');
select throws_ok($$ select ai.decide_suggestion((select v from ids where k = 'sg')::uuid, 'ACCEPTED') $$, '42501', null, 'mas não decide');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
select throws_ok($$ select ai.decide_suggestion((select v from ids where k = 'sg')::uuid, 'TALVEZ') $$, 'P0210', null, 'situação inválida');
select throws_ok($$ select ai.decide_suggestion((select v from ids where k = 'sg')::uuid, 'DISMISSED') $$, 'P0210', null, 'ignorar exige motivo');
select throws_ok($$ select ai.decide_suggestion((select v from ids where k = 'sg')::uuid, 'DISMISSED', 'ok') $$, 'P0210', null, 'motivo curto demais');
select is((ai.decide_suggestion((select v from ids where k = 'sg')::uuid, 'ACCEPTED', 'Conferi o caixa, faltou registrar uma sangria')).status, 'ACCEPTED', 'resolvida');
select ok((select decided_by is not null and decided_at is not null and decision_note like 'Conferi%' from ai.suggestions where id = (select v from ids where k = 'sg')::uuid), 'fica registrado quem decidiu, quando e a nota');
select is((ai.decide_suggestion((select v from ids where k = 'sg2')::uuid, 'DISMISSED', 'Desconto autorizado pela sócia')).status, 'DISMISSED', 'ignorada com motivo');
select throws_ok($$ select ai.decide_suggestion((select v from ids where k = 'sg')::uuid, 'DISMISSED', 'de novo') $$, 'P0212', null, 'sugestão já decidida');
reset role;
select is(private.detect_anomalies(), 0, 'o que o sócio já decidiu não volta');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is(ai.run_detectors(), 0, '"verificar agora" roda os detectores (nada novo)');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select ai.run_detectors() $$, '42501', null, 'só quem decide pode pedir a verificação');
reset role;
select is((select count(*)::int from cron.job where jobname = 'sie-detect-anomalies'), 1, 'varredura agendada todo dia às 06:00');
select ok(not has_function_privilege('authenticated', 'private.detect_anomalies()', 'execute') and has_function_privilege('authenticated', 'ai.decide_suggestion(uuid,text,text)', 'execute'), 'privilégios');

select * from finish();
rollback;
