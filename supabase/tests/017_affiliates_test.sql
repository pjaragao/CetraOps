begin;
create extension if not exists pgtap with schema extensions;
select plan(48);

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
  ('00000000-0000-4000-8000-0000000009a1', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Trainer Ana (teste)'),
  ('00000000-0000-4000-8000-0000000009a2', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Trainer Bia (teste)'),
  ('00000000-0000-4000-8000-0000000009a3', '00000000-0000-4000-8000-000000000001', 'PERSON', 'Trainer Cris (teste)');
insert into ids select 'entity', id::text from core.legal_entities limit 1;
insert into ids select 'comp', date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date::text;
create function pg_temp.order_for(p_n text, p_aff uuid, p_party uuid, p_sub numeric, p_disc numeric, p_cc uuid, p_status text default 'PAID') returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into sales.orders (org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, profit_cost_center_id, attribution, subtotal, discount_total, total, idempotency_key)
  values ('00000000-0000-4000-8000-000000000001', (select v::uuid from ids where k = 'entity'), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'AFF-' || p_n, 'POS', p_status::sales.order_status,
          p_party, p_cc, case when p_aff is null then '{}'::jsonb else jsonb_build_object('affiliate_party_id', p_aff) end, p_sub, p_disc, p_sub - p_disc, 'aff-' || p_n) returning id into v_id;
  return v_id;
end $$;

-- ---------- Sem permissão ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora: crm.write, sem fin.*
select throws_ok($$ select aff.generate_statement(gen_random_uuid(), now()::date) $$, '42501', null, 'vendedora não gera extrato');
select throws_ok($$ select aff.approve_statement(gen_random_uuid()) $$, '42501', null, 'vendedora não aprova extrato');
select is((select count(*)::int from aff.statements), 0, 'vendedora não vê extratos');

-- ---------- Cadastro ----------
select throws_ok($$ select aff.save_affiliate('{"party_id":"00000000-0000-4000-8000-0000000009a1","coupon_code":"a b"}') $$, 'P0160', null, 'cupom com espaço');
select throws_ok($$ select aff.save_affiliate('{"party_id":"00000000-0000-4000-8000-0000000009a1","coupon_code":"ANA10","student_discount_pct":0}') $$, 'P0160', null, 'desconto zero');
select throws_ok($$ select aff.save_affiliate('{"party_id":"00000000-0000-4000-8000-0000000009a1","coupon_code":"ANA10","student_discount_pct":60}') $$, 'P0160', null, 'desconto acima de 50%');
select throws_ok($$ select aff.save_affiliate('{"party_id":"00000000-0000-4000-8000-0000000009a1","coupon_code":"ANA10","commission_pct":31}') $$, 'P0160', null, 'comissão acima de 30%');
select throws_ok($$ select aff.save_affiliate('{"party_id":"00000000-0000-4000-8000-0000000009a1","coupon_code":"ANA10","payout_mode":"DINHEIRO"}') $$, 'P0160', null, 'forma de pagamento inválida');
select throws_ok($$ select aff.save_affiliate(jsonb_build_object('party_id', gen_random_uuid(), 'coupon_code', 'ANA10')) $$, 'P0160', null, 'pessoa inexistente');
insert into ids select 'affA', (aff.save_affiliate('{"party_id":"00000000-0000-4000-8000-0000000009a1","coupon_code":"ana10","student_discount_pct":10,"commission_pct":8,"payout_mode":"STORE_CREDIT"}')).id::text;
select is((select upper(c.code) || '/' || c.kind || '/' || c.value || '/' || (c.affiliate_party_id is not null) from sales.coupons c join aff.affiliates a on a.coupon_id = c.id where a.id = (select v from ids where k = 'affA')::uuid), 'ANA10/PERCENT/10.00/true', 'cria o cupom da trainer (código em maiúsculas)');
select ok(exists (select 1 from crm.party_roles where party_id = '00000000-0000-4000-8000-0000000009a1' and role = 'AFFILIATE_TRAINER'), 'pessoa ganha o papel de afiliada');
select throws_ok($$ select aff.save_affiliate('{"party_id":"00000000-0000-4000-8000-0000000009a1","coupon_code":"OUTRO1"}') $$, 'P0160', null, 'a mesma pessoa não é afiliada duas vezes');
select throws_ok($$ select aff.save_affiliate('{"party_id":"00000000-0000-4000-8000-0000000009a2","coupon_code":"ANA10"}') $$, 'P0160', null, 'código de cupom repetido');
insert into ids select 'affB', (aff.save_affiliate('{"party_id":"00000000-0000-4000-8000-0000000009a2","coupon_code":"BIA15","student_discount_pct":15,"commission_pct":10,"payout_mode":"PIX"}')).id::text;
insert into ids select 'affC', (aff.save_affiliate('{"party_id":"00000000-0000-4000-8000-0000000009a3","coupon_code":"CRIS10"}')).id::text;
select is((select payout_mode || '/' || commission_pct || '/' || student_discount_pct from aff.affiliates where id = (select v from ids where k = 'affC')::uuid), 'STORE_CREDIT/8.00/10.00', 'padrões: vale-troca, 8% de comissão, 10% de desconto');
select is((aff.save_affiliate(jsonb_build_object('id', (select v from ids where k = 'affC'), 'party_id', '00000000-0000-4000-8000-0000000009a3', 'coupon_code', 'CRIS12', 'student_discount_pct', 12, 'commission_pct', 9))).commission_pct, 9.00, 'edita comissão');
select is((select upper(code) || '/' || value from sales.coupons where id = (select coupon_id from aff.affiliates where id = (select v from ids where k = 'affC')::uuid)), 'CRIS12/12.00', 'e o cupom acompanha (código e desconto)');
select is((aff.set_affiliate_status((select v from ids where k = 'affC')::uuid, 'PAUSED')).status, 'PAUSED', 'pausa a afiliada');
select is((select active from sales.coupons where id = (select coupon_id from aff.affiliates where id = (select v from ids where k = 'affC')::uuid)), false, 'cupom pausado não vale');
select is((aff.set_affiliate_status((select v from ids where k = 'affC')::uuid, 'ACTIVE')).status, 'ACTIVE', 'reativa');
select is((select active from sales.coupons where id = (select coupon_id from aff.affiliates where id = (select v from ids where k = 'affC')::uuid)), true, 'cupom volta a valer');
select throws_ok($$ select aff.set_affiliate_status((select v from ids where k = 'affC')::uuid, 'TALVEZ') $$, 'P0160', null, 'situação inválida');
select throws_ok($$ select aff.set_affiliate_status(gen_random_uuid(), 'PAUSED') $$, 'P0162', null, 'afiliada inexistente');

-- ---------- Extrato ----------
reset role;
insert into ids select 'o1', pg_temp.order_for('1', '00000000-0000-4000-8000-0000000009a1', '00000000-0000-4000-8000-000000000501', 1000, 100, '00000000-0000-4000-8000-0000000000c3')::text;
insert into ids select 'o2', pg_temp.order_for('2', '00000000-0000-4000-8000-0000000009a1', '00000000-0000-4000-8000-000000000501', 500, 0, '00000000-0000-4000-8000-0000000000c4')::text;
select pg_temp.order_for('3', '00000000-0000-4000-8000-0000000009a1', '00000000-0000-4000-8000-0000000009a1', 800, 0, '00000000-0000-4000-8000-0000000000c3');          -- compra da própria trainer: fora
select pg_temp.order_for('4', '00000000-0000-4000-8000-0000000009a1', '00000000-0000-4000-8000-000000000501', 700, 0, '00000000-0000-4000-8000-0000000000c3', 'CANCELLED');  -- cancelado: fora
select pg_temp.order_for('5', '00000000-0000-4000-8000-0000000009a2', '00000000-0000-4000-8000-000000000501', 900, 0, '00000000-0000-4000-8000-0000000000c3');          -- cupom de outra trainer: fora
select pg_temp.order_for('6', null, '00000000-0000-4000-8000-000000000501', 900, 0, '00000000-0000-4000-8000-0000000000c3');                                                -- sem cupom: fora
insert into sales.returns (org_id, number, order_id, type, reason, amount, party_id) values ('00000000-0000-4000-8000-000000000001', 'DEV-AFF-1', (select v from ids where k = 'o1')::uuid, 'RETURN_REFUND', 'OTHER', 100, '00000000-0000-4000-8000-000000000501');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
insert into ids select 'stA', (aff.generate_statement((select v from ids where k = 'affA')::uuid, (select v::date from ids where k = 'comp'))).id::text;
select is((select orders_count || '/' || sales_amount || '/' || returns_amount || '/' || commission from aff.statements where id = (select v from ids where k = 'stA')::uuid), '2/1400.00/100.00/104.00', 'base = itens − desconto − devoluções; só pedidos da trainer; comissão de 8%');
select is((select jsonb_array_length(detail -> 'groups') from aff.statements where id = (select v from ids where k = 'stA')::uuid), 2, 'comissão separada por centro de custo (balcão e digital)');
select is((select sum((g ->> 'commission')::numeric) from aff.statements s, jsonb_array_elements(s.detail -> 'groups') g where s.id = (select v from ids where k = 'stA')::uuid), 104.00, 'e as partes somam o total');
reset role;
select pg_temp.order_for('7', '00000000-0000-4000-8000-0000000009a1', '00000000-0000-4000-8000-000000000501', 100, 0, '00000000-0000-4000-8000-0000000000c4');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((aff.generate_statement((select v from ids where k = 'affA')::uuid, (select v::date from ids where k = 'comp'))).commission, 112.00, 'rascunho recalcula com a venda nova');
select is((select count(*)::int from aff.statements where affiliate_id = (select v from ids where k = 'affA')::uuid), 1, 'sem duplicar o extrato do mês');

-- ---------- Aprovar (vale-troca) ----------
select is((aff.approve_statement((select v from ids where k = 'stA')::uuid)).status, 'PAID', 'vale-troca: aprovar já paga');
select is((select sum(amount) from sales.store_credit_ledger where party_id = '00000000-0000-4000-8000-0000000009a1' and reason = 'AFFILIATE_COMMISSION'), 112.00, 'crédito no livro de vales da trainer');
select ok((select paid_at is not null and approved_by is not null from aff.statements where id = (select v from ids where k = 'stA')::uuid), 'registra quem aprovou e quando pagou');
select is((select count(*)::int from fin.journal_entries where source_type = 'aff.statements' and kind = 'AFFILIATE_COMMISSION'), 1, 'um lançamento contábil por empresa');
select is((select sum(l.debit) - sum(l.credit) from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id where e.source_type = 'aff.statements'), 0.00, 'lançamento balanceado');
select is((select sum(l.debit) from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id where e.source_type = 'aff.statements'), 112.00, 'despesa de afiliada = comissão');
select is((select count(*)::int from fin.journal_lines l join fin.journal_entries e on e.id = l.entry_id where e.source_type = 'aff.statements' and l.debit > 0 and l.cost_center_id is not null), 2, 'a despesa cai nos centros de custo da venda');
select ok(exists (select 1 from crm.timeline_events where source_id = (select v from ids where k = 'stA')::uuid and kind = 'AFFILIATE_STATEMENT'), 'na linha do tempo da trainer');
select throws_ok($$ select aff.approve_statement((select v from ids where k = 'stA')::uuid) $$, 'P0161', null, 'não aprova duas vezes');
select is((aff.generate_statement((select v from ids where k = 'affA')::uuid, (select v::date from ids where k = 'comp'))).status, 'PAID', 'extrato pago não é recalculado');

-- ---------- Aprovar (Pix) ----------
reset role;
select pg_temp.order_for('8', '00000000-0000-4000-8000-0000000009a2', '00000000-0000-4000-8000-000000000501', 2000, 200, '00000000-0000-4000-8000-0000000000c3');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
insert into ids select 'stB', (aff.generate_statement((select v from ids where k = 'affB')::uuid, (select v::date from ids where k = 'comp'))).id::text;
select is((select commission from aff.statements where id = (select v from ids where k = 'stB')::uuid), 270.00, 'Pix: 10% de 2.700 (900 do pedido 5 + 1.800 do pedido 8, itens menos desconto)');
select is((aff.approve_statement((select v from ids where k = 'stB')::uuid)).status, 'APPROVED', 'Pix: fica aprovado até o pagamento');
select is((select cardinality(payable_title_ids) from aff.statements where id = (select v from ids where k = 'stB')::uuid), 1, 'um título a pagar');
select is((select t.total_amount || '/' || t.origin_type || '/' || t.approval_status || '/' || t.direction::text || '/' || (t.accrual_entry_id is not null) from fin.titles t where t.id = (select payable_title_ids[1] from aff.statements where id = (select v from ids where k = 'stB')::uuid)),
  '270.00/COMMISSION_STATEMENT/APPROVED/PAYABLE/true', 'título aprovado, da origem certa, já contabilizado');
select is((select t.party_id::text from fin.titles t where t.id = (select payable_title_ids[1] from aff.statements where id = (select v from ids where k = 'stB')::uuid)), '00000000-0000-4000-8000-0000000009a2', 'a pagar para a trainer');
select is((select count(*)::int from sales.store_credit_ledger where party_id = '00000000-0000-4000-8000-0000000009a2'), 0, 'Pix não gera vale-troca');

-- ---------- Sem comissão ----------
insert into ids select 'stC', (aff.generate_statement((select v from ids where k = 'affC')::uuid, (select v::date from ids where k = 'comp'))).id::text;
select is((select commission from aff.statements where id = (select v from ids where k = 'stC')::uuid), 0.00, 'sem vendas, sem comissão');
select throws_ok($$ select aff.approve_statement((select v from ids where k = 'stC')::uuid) $$, 'P0161', null, 'não aprova extrato zerado');
select throws_ok($$ select aff.generate_statement(gen_random_uuid(), now()::date) $$, 'P0162', null, 'afiliada inexistente no extrato');
select throws_ok($$ select aff.approve_statement(gen_random_uuid()) $$, 'P0162', null, 'extrato inexistente');

-- ---------- Privilégios ----------
select ok(has_function_privilege('authenticated', 'aff.approve_statement(uuid)', 'execute') and has_function_privilege('authenticated', 'aff.save_affiliate(jsonb)', 'execute'), 'funções da tela chamáveis');

select * from finish();
rollback;
