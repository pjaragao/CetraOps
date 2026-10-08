begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

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

select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
insert into ids select 'aniv', crm.quick_customer('48999990101', 'Aniversariante (teste)', false);
insert into ids select 'outra', crm.quick_customer('48999990102', 'Outra Cliente (teste)', false);
insert into ids select 'prox', crm.quick_customer('48999990103', 'Aniversário em 3 dias (teste)', false);
reset role;
update crm.parties set birth_date = (private.today_sp() - interval '30 years')::date where id = (select v from ids where k = 'aniv');
update crm.parties set birth_date = (private.today_sp() + 3 - interval '30 years')::date where id = (select v from ids where k = 'prox');
insert into crm.party_roles (party_id, org_id, role) select p.id, p.org_id, 'CUSTOMER' from crm.parties p where p.id in (select v from ids) on conflict do nothing;

-- lista de aniversariantes: a mesma regra do resumo do dia
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select ok((select (select v from ids where k = 'aniv') = any (array(select crm.birthday_party_ids('today')))), 'aniversariante de hoje entra na lista');
select ok((select (select v from ids where k = 'outra') <> all (array(select crm.birthday_party_ids('month')))), 'quem não faz aniversário fica de fora');
select ok((select x ->> 'href' = '/clientes?aniversario=hoje' from jsonb_array_elements(ai.daily_briefing() -> 'items') x where x ->> 'key' = 'aniversariantes'), 'sem tarefa de aniversário, o resumo leva para quem faz aniversário hoje');

-- régua de aniversário: cupom padrão de 5%, ligada e sem grupo de controle
reset role;
select is((select (trigger_config #>> '{coupon,percent}')::numeric from mkt.journeys where org_id = '00000000-0000-4000-8000-000000000001' and key = 'aniversario'), 5::numeric, 'régua de aniversário nasce com cupom de 5%');
select ok((select active and holdout_pct = 0 from mkt.journeys where org_id = '00000000-0000-4000-8000-000000000001' and key = 'aniversario'), 'régua ligada e sem grupo de controle');

insert into mkt.journey_enrollments (org_id, journey_id, party_id, source_key, grp)
select j.org_id, j.id, (select v from ids where k = 'aniv'), 'teste-cupom', 'TREATMENT' from mkt.journeys j where j.org_id = '00000000-0000-4000-8000-000000000001' and j.key = 'aniversario';
select matches(private.render_journey_text((select id from mkt.journey_enrollments where source_key = 'teste-cupom'), (select v from ids where k = 'aniv'), 'Cupom {cupom}: {desconto} até {validade_cupom}', null),
  '^Cupom ANIV-[0-9A-F]{6}: 5% até \d\d/\d\d$', 'texto da régua traz o cupom, o desconto e a validade');
select is((select count(*)::int from sales.coupons where party_id = (select v from ids where k = 'aniv')), 1, 'um cupom por aniversariante');
select is((select count(*)::int from (select private.render_journey_text((select id from mkt.journey_enrollments where source_key = 'teste-cupom'), (select v from ids where k = 'aniv'), '{cupom}', null)) z), 1, 'montar o texto de novo não cria outro cupom');
select is((select count(*)::int from sales.coupons where party_id = (select v from ids where k = 'aniv')), 1, 'continua um só');

-- cupom pessoal: só a aniversariante usa
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select is((sales.validate_coupon((select code from sales.coupons where party_id = (select v from ids where k = 'aniv')), 1000, (select v from ids where k = 'outra'))) ->> 'valid', 'false', 'prévia recusa o cupom pessoal para outra cliente');
select is((sales.validate_coupon((select code from sales.coupons where party_id = (select v from ids where k = 'aniv')), 1000, (select v from ids where k = 'aniv'))) ->> 'discount', '50.00', 'prévia dá 5% para a aniversariante');

-- campanha: começa 10 dias antes do aniversário e vai até 20 depois; entra sozinha no carrinho; eficácia medida
select is((select (trigger_config ->> 'days_before')::int from mkt.journeys where org_id = '00000000-0000-4000-8000-000000000001' and key = 'aniversario'), 10, 'a cliente entra 10 dias antes do aniversário');
select ok((select c.valid_to > now() + interval '19 days' and c.valid_to < now() + interval '22 days' from sales.coupons c where c.party_id = (select v from ids where k = 'aniv')), 'o cupom vale até 20 dias depois do aniversário (aniversário hoje)');
select is((sales.party_auto_coupon((select v from ids where k = 'aniv'))) ->> 'code', (select code from sales.coupons where party_id = (select v from ids where k = 'aniv')), 'o cupom vigente da cliente entra sozinho no carrinho');
select ok((mkt.journey_coupon_report((select id from mkt.journeys where org_id = '00000000-0000-4000-8000-000000000001' and key = 'aniversario')) ->> 'issued')::int >= 1, 'relatório de eficácia conta os cupons emitidos');

-- janela: entra quem faz aniversário até "dias antes" à frente (não só no dia exato); o contato e a tarefa ficam no dia do aniversário
reset role;
select is(private.next_birthday('2000-02-29', '2027-02-01'), '2027-02-28'::date, '29/02 vira 28/02 em ano comum');
select is(private.next_birthday('1990-01-05', '2026-12-20'), '2027-01-05'::date, 'aniversário de janeiro visto em dezembro é no ano seguinte');
select ok(private.journey_enroll_birthday((select j from mkt.journeys j where j.org_id = '00000000-0000-4000-8000-000000000001' and j.key = 'aniversario')) >= 1,
  'entra quem faz aniversário dentro da janela, não só no dia exato');
select ok(exists (select 1 from mkt.journey_enrollments e join mkt.journeys j on j.id = e.journey_id
              where j.key = 'aniversario' and e.party_id = (select v from ids where k = 'prox')
                and (e.next_run_at at time zone 'America/Sao_Paulo')::date = private.today_sp() + 3),
  'quem faz aniversário em 3 dias entra já, com o contato marcado para o dia');   -- (consulta separada: a inscrição acima só é vista no comando seguinte)
select is(private.journey_task_due((select e.id from mkt.journey_enrollments e where e.party_id = (select v from ids where k = 'prox') limit 1), 48),
  ((private.today_sp() + 3) + time '20:00') at time zone 'America/Sao_Paulo', 'a tarefa de aniversário vence no dia, às 20h');

select * from finish();
rollback;
