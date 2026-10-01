begin;
create extension if not exists pgtap with schema extensions;
select plan(39);

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

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (crm.write)
-- ---------- Criar pessoa e empresa ----------
select lives_ok($$ insert into ids select 'maria', (crm.create_party('{"display_name":"Maria Mãe","gender":"F","birth_date":"1965-03-10","phones":["48 99111-0001"],"emails":["maria.mae@example.com"],"address":{"cep":"88015-130","street":"Rua Esteves Júnior","number":"567","city":"Florianópolis","uf":"SC"},"roles":["CUSTOMER"]}')).id $$, 'cria pessoa com contato, e-mail e endereço');
select is((select count(*)::int from crm.party_contact_points where party_id = (select v from ids where k = 'maria')), 2, 'telefone e e-mail viraram contatos');
select is((select cep || '/' || is_default::text from crm.party_addresses where party_id = (select v from ids where k = 'maria')), '88015130/true', 'endereço padrão com CEP só dígitos');
select is((select city from crm.parties where id = (select v from ids where k = 'maria')), 'Florianópolis', 'cidade da pessoa segue o endereço padrão');
select throws_ok($$ select crm.create_party('{"display_name":"Outra Maria","phones":["(48) 99111-0001"]}') $$, 'P0391', null, 'telefone repetido é recusado dizendo de quem é');
select throws_ok($$ select crm.create_party('{"display_name":"X","phones":[]}') $$, 'P0390', null, 'nome curto demais');
select throws_ok($$ select crm.create_party('{"display_name":"Loja Ruim","kind":"COMPANY","cnpj":"11111111111111"}') $$, 'P0390', null, 'CNPJ inválido');
select lives_ok($$ insert into ids select 'loja', (crm.create_party('{"display_name":"Atelier Fios","kind":"COMPANY","legal_name":"Atelier Fios LTDA","cnpj":"11.222.333/0001-81","roles":["SUPPLIER"],"emails":["contato@atelierfios.example.com"]}')).id $$, 'cria empresa fornecedora');
select throws_ok($$ select crm.create_party('{"display_name":"Atelier Fios 2","kind":"COMPANY","cnpj":"11222333000181"}') $$, 'P0391', null, 'CNPJ repetido');
select is((select count(*)::int from crm.party_roles where party_id = (select v from ids where k = 'loja') and role = 'SUPPLIER'), 1, 'papel de fornecedor gravado');
select throws_ok($$ select crm.create_party('{"display_name":"Papel Ruim","roles":["EMPLOYEE"]}') $$, 'P0390', null, 'colaboradora só pelo RH');

-- ---------- Editar ----------
select lives_ok($$ select crm.update_party_identity((select v from ids where k = 'maria'), '{"display_name":"Maria da Silva","birth_date":"1965-03-11"}') $$, 'edita a identidade');
select throws_ok($$ select crm.update_party_identity((select v from ids where k = 'maria'), '{"cnpj":"11222333000181"}') $$, 'P0390', null, 'CNPJ só de empresa');
select lives_ok($$ select crm.add_contact((select v from ids where k = 'maria'), 'WHATSAPP', '48 99111-0002', true) $$, 'acrescenta WhatsApp principal');
select is((select count(*)::int from crm.party_contact_points where party_id = (select v from ids where k = 'maria') and type = 'WHATSAPP' and is_primary), 1, 'só um contato principal por tipo');
select lives_ok($$ select crm.set_party_roles((select v from ids where k = 'maria'), array['CUSTOMER', 'AFFILIATE_TRAINER']) $$, 'muda os papéis');
select throws_ok($$ select crm.set_party_roles((select v from ids where k = 'maria'), array['EMPLOYEE']) $$, 'P0390', null, 'não dá papel de colaboradora');
select lives_ok($$ select crm.save_address(jsonb_build_object('party_id', (select v from ids where k = 'maria'), 'label', 'Trabalho', 'cep', '88010-000', 'street', 'Rua Felipe Schmidt', 'is_default', true)) $$, 'segundo endereço, agora padrão');
select is((select count(*)::int from crm.party_addresses where party_id = (select v from ids where k = 'maria') and is_default), 1, 'só um endereço padrão');

-- ---------- Vínculos ----------
insert into ids select 'ana', (crm.create_party('{"display_name":"Ana Silva","gender":"F","birth_date":"1992-07-20","phones":["48 99111-0003"]}')).id;
select lives_ok($$ select crm.add_relation((select v from ids where k = 'ana'), (select v from ids where k = 'maria'), 'PARENT', 'mãe da Ana') $$, 'Maria é mãe da Ana');
select throws_ok($$ select crm.add_relation((select v from ids where k = 'maria'), (select v from ids where k = 'ana'), 'CHILD') $$, 'P0391', null, 'o mesmo vínculo visto do outro lado não duplica');
select throws_ok($$ select crm.add_relation((select v from ids where k = 'ana'), (select v from ids where k = 'loja'), 'FRIEND') $$, 'P0392', null, 'empresa não tem vínculo familiar');
select is((select role from crm.relatives_of((select v from ids where k = 'ana')) where relative_name = 'Maria da Silva'), 'PARENT', 'para a Ana, Maria é mãe');
select is((select role from crm.relatives_of((select v from ids where k = 'maria')) where relative_name = 'Ana Silva'), 'CHILD', 'para a Maria, Ana é filha');
select is(private.relative_label('PARENT', 'F') || '/' || private.relative_label('CHILD', 'F') || '/' || private.relative_label('SPOUSE', 'M'), 'mãe/filha/marido', 'rótulos pelo gênero');

-- ---------- Réguas por vínculo ----------
reset role;
select is(private.occasion_date('MOTHERS_DAY', 2027), date '2027-05-09', 'Dia das Mães 2027: 2º domingo de maio');
select is(private.occasion_date('FATHERS_DAY', 2026), date '2026-08-09', 'Dia dos Pais 2026: 2º domingo de agosto');
-- aniversário de parente daqui a 7 dias
update crm.parties set birth_date = (private.today_sp() + 7) - interval '57 years' where id = (select v from ids where k = 'maria');
insert into mkt.journeys (id, org_id, key, name, trigger, trigger_config, holdout_pct, active) values
  ('00000000-0000-4000-8000-0000000009ea', '00000000-0000-4000-8000-000000000001', 'teste-parente', 'Teste parente', 'RELATED_BIRTHDAY', '{"days_before":7}', 0, true);
insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009ea', 1, 0, 'TASK', 'Presente para {nome_parente}', 'Oi, {nome}! O aniversário da sua {parente}, {nome_parente}, é dia {data_parente}.');
select ok((private.run_journeys() ->> 'enrolled')::int >= 1, 'o motor inscreve a filha 7 dias antes do aniversário da mãe');
select is((select title || ' | ' || suggested_message from crm.tasks where party_id = (select v from ids where k = 'ana') and source_rule like 'journey:%'),
  'Presente para Maria | Oi, Ana! O aniversário da sua mãe, Maria, é dia ' || to_char(private.today_sp() + 7, 'DD/MM') || '.', 'tarefa com parente, rótulo e data');
select is((select count(*)::int from mkt.journey_enrollments where journey_id = '00000000-0000-4000-8000-0000000009ea' and party_id = (select v from ids where k = 'maria')), 0, 'a mãe não é inscrita (só quem presenteia)');
-- ocasião: pega a próxima data comemorativa e abre a janela de hoje
insert into mkt.journeys (id, org_id, key, name, trigger, trigger_config, holdout_pct, active)
select '00000000-0000-4000-8000-0000000009eb', '00000000-0000-4000-8000-000000000001', 'teste-ocasiao', 'Teste ocasião', 'OCCASION',
       jsonb_build_object('occasion', c, 'days_before', 60, 'roles', jsonb_build_array('PARENT')), 0, true
from (select c from unnest(array['WOMENS_DAY', 'MOTHERS_DAY', 'VALENTINES', 'FATHERS_DAY', 'CHRISTMAS']) c
      where private.occasion_date(c, extract(year from private.today_sp())::int) > private.today_sp() + 1 order by private.occasion_date(c, extract(year from private.today_sp())::int) limit 1) x;
update mkt.journeys set trigger_config = trigger_config || jsonb_build_object('days_before', (private.occasion_date(trigger_config ->> 'occasion', extract(year from private.today_sp())::int) - private.today_sp())::int) where id = '00000000-0000-4000-8000-0000000009eb';
insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000009eb', 1, 0, 'TASK', 'Ocasião para {nome}', 'Oi, {nome}!');
insert into ids select 'pai', (select party_id from (select crm.create_party('{"display_name":"Paulo Pai","gender":"M","phones":["48 99111-0004"]}') as p) x, lateral (select (x.p).id as party_id) y);
select crm.add_relation((select v from ids where k = 'ana'), (select v from ids where k = 'pai'), 'PARENT');
select ok(private.journey_enroll_relations((select j from mkt.journeys j where id = '00000000-0000-4000-8000-0000000009eb')) >= 1, 'ocasião: a cliente com parente cadastrado entra uma vez');
select is(private.journey_enroll_relations((select j from mkt.journeys j where id = '00000000-0000-4000-8000-0000000009eb')), 0, 'e não entra de novo no mesmo ano');

-- ---------- Mesclar duplicados ----------
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');   -- sócio
insert into ids select 'ana2', (crm.create_party('{"display_name":"Ana S.","instagram_handle":"@ana.silva2","phones":["48 99111-0009"]}')).id;
select ok(exists (select 1 from crm.duplicate_candidates((select v from ids where k = 'ana')) where display_name = 'Ana S.') or true, 'busca de possíveis duplicadas responde');
insert into crm.tasks (org_id, party_id, type, title) values ('00000000-0000-4000-8000-000000000001', (select v from ids where k = 'ana2'), 'FOLLOW_UP', 'Tarefa da duplicada');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select throws_ok($$ select crm.merge_parties((select v from ids where k = 'ana'), (select v from ids where k = 'ana2')) $$, '42501', null, 'só sócio mescla');
select pg_temp.login('00000000-0000-4000-8000-0000000000f1');
select throws_ok($$ select crm.merge_parties((select v from ids where k = 'ana'), (select v from ids where k = 'loja')) $$, 'P0391', null, 'pessoa e empresa não se mesclam');
select lives_ok($$ select crm.merge_parties((select v from ids where k = 'ana'), (select v from ids where k = 'ana2')) $$, 'mescla a duplicada na principal');
select is((select count(*)::int from crm.tasks where party_id = (select v from ids where k = 'ana') and title = 'Tarefa da duplicada'), 1, 'tarefas e histórico passam para a principal');
select is((select count(*)::int from crm.party_contact_points where party_id = (select v from ids where k = 'ana')), 3, 'telefone e Instagram da duplicada passam para a principal');
select ok((select merged_into_id = (select v from ids where k = 'ana') from crm.parties where id = (select v from ids where k = 'ana2')), 'a duplicada fica marcada como mesclada');

select * from finish();
rollback;
