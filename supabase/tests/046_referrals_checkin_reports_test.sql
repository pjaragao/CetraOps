begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;

insert into ids select 'ana', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 90000-0011', 'Ana Indica', 'TEST');
insert into ids select 'bia', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 90000-0012', 'Bia Amiga', 'TEST');
insert into ids select 'cris', crm.resolve_identity('00000000-0000-4000-8000-000000000001', 'WHATSAPP', '+55 48 90000-0013', 'Cris Cliente', 'TEST');

-- ---------- Indicação ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora
select throws_ok($$ select crm.save_referral_settings('{"enabled":true}') $$, '42501', null, 'só sócios ligam a indicação');
select lives_ok($$ insert into ids select 'link', (crm.ensure_referral_link((select v from ids where k = 'ana'))).id $$, 'cria o link pessoal de indicação');
select is((crm.ensure_referral_link((select v from ids where k = 'ana'))).id, (select v from ids where k = 'link'), 'o link é um só por cliente');
select ok((select code like 'ind-ana%' and kind = 'REFERRAL' from mkt.tracking_links where id = (select v from ids where k = 'link')), 'código legível do link');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
select lives_ok($$ select crm.save_referral_settings('{"enabled":true,"reward_amount":50,"wait_days":0,"monthly_cap":1}') $$, 'sócio liga a indicação');
select throws_ok($$ select crm.save_referral_settings('{"reward_amount":5000}') $$, 'P0410', null, 'vale acima do teto é recusado');
reset role;
select lives_ok($$ select private.register_referral('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'ana'), (select v from ids where k = 'bia'), (select v from ids where k = 'link')) $$, 'amiga nova gera a indicação');
select is((select count(*)::int from crm.referrals where friend_party = (select v from ids where k = 'bia')), 1, 'indicação pendente criada');
select private.register_referral('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'cris'), (select v from ids where k = 'bia'), null);
select is((select count(*)::int from crm.referrals where friend_party = (select v from ids where k = 'bia')), 1, 'amiga só pode ser indicada uma vez');
select private.register_referral('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'ana'), (select v from ids where k = 'ana'), null);
select is((select count(*)::int from crm.referrals where friend_party = (select v from ids where k = 'ana')), 0, 'ninguém indica a si mesma');
select is(private.sweep_referrals(), 0, 'sem compra da amiga, nada é pago');
insert into sales.orders (id, org_id, legal_entity_id, store_id, location_id, number, channel, status, party_id, subtotal, discount_total, total, cost_total, idempotency_key)
values ('00000000-0000-4000-8000-0000000009e1', '00000000-0000-4000-8000-000000000001', (select id from core.legal_entities limit 1), '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1',
        'IND-1', 'POS', 'PAID', (select v from ids where k = 'bia'), 200, 0, 200, 80, 'ind-1');
select is((select order_id::text from crm.referrals where friend_party = (select v from ids where k = 'bia')), '00000000-0000-4000-8000-0000000009e1', 'a 1ª compra da amiga fica ligada à indicação');
select ok(exists (select 1 from crm.tasks where source_rule like 'referral-welcome:%' and party_id = (select v from ids where k = 'bia')), 'tarefa de mimo de boas-vindas');
select is(private.sweep_referrals(), 1, 'passado o prazo de troca, quem indicou ganha o vale');
select is((select status || '/' || reward_amount from crm.referrals where friend_party = (select v from ids where k = 'bia')), 'REWARDED/50.00', 'indicação premiada');
select is((select amount::text || '/' || reason from sales.store_credit_ledger where id = (select reward_ledger_id from crm.referrals where friend_party = (select v from ids where k = 'bia'))), '50.00/GOODWILL', 'vale-troca emitido para quem indicou');
select is(private.sweep_referrals(), 0, 'e não paga duas vezes');

-- ---------- Check-in ----------
insert into mkt.events (id, org_id, kind, name, starts_at, status) values ('00000000-0000-4000-8000-0000000009e2', '00000000-0000-4000-8000-000000000001', 'DROP', 'Drop teste QR', now() + interval '1 hour', 'CONFIRMED');
insert into mkt.event_guests (org_id, event_id, party_id, source, rsvp_status) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009e2', (select v from ids where k = 'cris'), 'MANUAL', 'CONFIRMED');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select mkt.guest_by_token('inexistente') $$, 'P0412', null, 'QR desconhecido');
select is((mkt.checkin_by_token((select checkin_token from mkt.event_guests where party_id = (select v from ids where k = 'cris') and event_id = '00000000-0000-4000-8000-0000000009e2'), 1) ->> 'already'), 'false', 'check-in confirma a presença');
select is((mkt.checkin_by_token((select checkin_token from mkt.event_guests where party_id = (select v from ids where k = 'cris') and event_id = '00000000-0000-4000-8000-0000000009e2')) ->> 'already'), 'true', 'repetir o QR não duplica');
select is((select rsvp_status from mkt.event_guests where party_id = (select v from ids where k = 'cris') and event_id = '00000000-0000-4000-8000-0000000009e2'), 'ATTENDED', 'convidada marcada como presente');
select is((mkt.checkin_walkin(jsonb_build_object('event_id', '00000000-0000-4000-8000-0000000009e2', 'name', 'Dani Sem Convite', 'phone', '48 90000-0014', 'accept_marketing', true)) ->> 'guest_id') is not null, true, 'quem chega sem convite é cadastrada e confirmada');

-- ---------- Relatórios ----------
select lives_ok($$ select * from crm.report_acquisition(current_date - 30, current_date) $$, 'relatório de aquisição por origem');
select lives_ok($$ select * from sales.report_cohorts(12) $$, 'coortes de recompra');
select lives_ok($$ select * from mkt.report_journeys(current_date - 30, current_date) $$, 'desempenho das réguas');
select lives_ok($$ select * from omni.report_satisfaction(current_date - 60, current_date) $$, 'satisfação por mês');
select lives_ok($$ select * from crm.report_lost_reasons(current_date - 30, current_date) $$, 'motivos de perda');

select * from finish();
rollback;
