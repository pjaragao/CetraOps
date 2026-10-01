begin;
create extension if not exists pgtap with schema extensions;
select plan(50);

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

insert into ids select 'party', '00000000-0000-4000-8000-000000000501';
insert into ids select 'b2c', id::text from crm.pipelines where kind = 'B2C';
insert into ids select 'event', id::text from crm.pipelines where kind = 'EVENT';
insert into ids select 's_' || position, id::text from crm.pipeline_stages where pipeline_id = (select v from ids where k = 'b2c')::uuid;
insert into ids select 'e_1', id::text from crm.pipeline_stages where pipeline_id = (select v from ids where k = 'event')::uuid and position = 1;
update crm.parties set lifecycle_stage = 'LEAD' where id = '00000000-0000-4000-8000-000000000501';

-- ---------- Seed dos funis ----------
select ok((select count(*) from crm.pipeline_stages where pipeline_id = (select v from ids where k = 'event')::uuid) >= 5, 'funil de eventos tem etapas');
select is((select count(distinct pipeline_id)::int from crm.pipeline_stages), 4, 'os quatro funis têm etapas');
select ok((select bool_and(exists (select 1 from crm.pipeline_stages s where s.pipeline_id = p.id and s.is_won) and exists (select 1 from crm.pipeline_stages s where s.pipeline_id = p.id and s.is_lost)) from crm.pipelines p),
  'todo funil tem etapa de ganho e de perda');

-- ---------- Sem permissão ----------
set local role anon;
select throws_ok($$ select crm.save_deal('{}') $$, '42501', null, 'anônimo não cria oportunidade');
reset role;

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (crm.write)
-- ---------- Oportunidades: validações ----------
select throws_ok($$ select crm.save_deal(jsonb_build_object('party_id', (select v from ids where k = 'party'), 'pipeline_id', (select v from ids where k = 'b2c'), 'title', 'A')) $$, 'P0150', null, 'título curto demais');
select throws_ok($$ select crm.save_deal(jsonb_build_object('party_id', (select v from ids where k = 'party'), 'pipeline_id', (select v from ids where k = 'b2c'), 'title', 'Kit treino', 'value_estimated', -5)) $$, 'P0150', null, 'valor negativo');
select throws_ok($$ select crm.save_deal(jsonb_build_object('party_id', gen_random_uuid(), 'pipeline_id', (select v from ids where k = 'b2c'), 'title', 'Kit treino')) $$, 'P0150', null, 'cliente inexistente');
select throws_ok($$ select crm.save_deal(jsonb_build_object('party_id', (select v from ids where k = 'party'), 'pipeline_id', gen_random_uuid(), 'title', 'Kit treino')) $$, 'P0150', null, 'funil inexistente');
select throws_ok($$ select crm.save_deal(jsonb_build_object('party_id', (select v from ids where k = 'party'), 'pipeline_id', (select v from ids where k = 'b2c'), 'title', 'Kit treino', 'owner_member_id', gen_random_uuid())) $$, 'P0150', null, 'responsável inexistente');

-- ---------- Criar e editar ----------
insert into ids select 'deal', (crm.save_deal(jsonb_build_object('party_id', (select v from ids where k = 'party'), 'pipeline_id', (select v from ids where k = 'b2c'), 'title', 'Kit treino inverno', 'value_estimated', 890))).id::text;
select is((select stage_id::text from crm.deals where id = (select v from ids where k = 'deal')::uuid), (select v from ids where k = 's_1'), 'entra na primeira etapa do funil');
select is((select owner_member_id::text from crm.deals where id = (select v from ids where k = 'deal')::uuid), '00000000-0000-4000-8000-000000000102', 'responsável padrão é quem criou');
select is((select count(*)::int from crm.deal_stage_history where deal_id = (select v from ids where k = 'deal')::uuid), 1, 'histórico de etapas começa na criação');
select is((select summary from crm.timeline_events where source_id = (select v from ids where k = 'deal')::uuid and kind = 'DEAL_CREATED'), 'Oportunidade criada: Kit treino inverno', 'entra na linha do tempo da cliente');
select is((crm.save_deal(jsonb_build_object('id', (select v from ids where k = 'deal'), 'party_id', (select v from ids where k = 'party'), 'pipeline_id', (select v from ids where k = 'b2c'), 'title', 'Kit treino de inverno', 'value_estimated', 950))).value_estimated, 950.00, 'edita título e valor');
select throws_ok($$ select crm.save_deal(jsonb_build_object('id', gen_random_uuid(), 'title', 'Fantasma')) $$, 'P0152', null, 'oportunidade inexistente');

-- ---------- Mover ----------
select throws_ok($$ select crm.move_deal((select v from ids where k = 'deal')::uuid, (select v from ids where k = 'e_1')::uuid) $$, 'P0150', null, 'etapa de outro funil não serve');
select is((crm.move_deal((select v from ids where k = 'deal')::uuid, (select v from ids where k = 's_3')::uuid)).status, 'OPEN', 'mover para etapa aberta mantém aberta');
select is((select count(*)::int from crm.deal_stage_history where deal_id = (select v from ids where k = 'deal')::uuid), 2, 'cada mudança de etapa vai para o histórico');
select is((crm.move_deal((select v from ids where k = 'deal')::uuid, (select v from ids where k = 's_3')::uuid)).stage_id::text, (select v from ids where k = 's_3'), 'mover para a mesma etapa não faz nada');
select is((select count(*)::int from crm.deal_stage_history where deal_id = (select v from ids where k = 'deal')::uuid), 2, 'e não duplica o histórico');
select throws_ok($$ select crm.move_deal((select v from ids where k = 'deal')::uuid, (select v from ids where k = 's_6')::uuid) $$, 'P0150', null, 'perda exige motivo');
select throws_ok($$ select crm.move_deal((select v from ids where k = 'deal')::uuid, (select v from ids where k = 's_6')::uuid, 'ok') $$, 'P0150', null, 'motivo curto demais');
select is((crm.move_deal((select v from ids where k = 'deal')::uuid, (select v from ids where k = 's_6')::uuid, 'Achou caro')).status, 'LOST', 'perdida com motivo');
select is((select lost_reason from crm.deals where id = (select v from ids where k = 'deal')::uuid), 'Achou caro', 'motivo guardado');
select ok(exists (select 1 from crm.timeline_events where source_id = (select v from ids where k = 'deal')::uuid and kind = 'DEAL_LOST' and summary like '%Achou caro%'), 'perda na linha do tempo');
select throws_ok($$ select crm.save_deal(jsonb_build_object('id', (select v from ids where k = 'deal'), 'title', 'Tentando editar')) $$, 'P0151', null, 'encerrada não se edita');
select is((crm.move_deal((select v from ids where k = 'deal')::uuid, (select v from ids where k = 's_2')::uuid)).status, 'OPEN', 'reabre movendo para etapa aberta');
select is((select lost_reason from crm.deals where id = (select v from ids where k = 'deal')::uuid), null, 'e o motivo da perda some');
select is((select lifecycle_stage::text from crm.parties where id = (select v from ids where k = 'party')::uuid), 'LEAD', 'ainda lead enquanto não ganha');
select is((crm.move_deal((select v from ids where k = 'deal')::uuid, (select v from ids where k = 's_5')::uuid)).status, 'WON', 'ganha');
select is((select lifecycle_stage::text from crm.parties where id = (select v from ids where k = 'party')::uuid), 'CUSTOMER', 'ganhar transforma lead em cliente');
select ok(exists (select 1 from crm.timeline_events where source_id = (select v from ids where k = 'deal')::uuid and kind = 'DEAL_WON'), 'ganho na linha do tempo');

-- ---------- Excluir ----------
insert into ids select 'deal2', (crm.save_deal(jsonb_build_object('party_id', (select v from ids where k = 'party'), 'pipeline_id', (select v from ids where k = 'b2c'), 'title', 'Teste de exclusão'))).id::text;
select lives_ok($$ select crm.delete_deal((select v from ids where k = 'deal2')::uuid) $$, 'exclui oportunidade');
select throws_ok($$ select crm.delete_deal((select v from ids where k = 'deal2')::uuid) $$, 'P0152', null, 'já excluída');
-- ---------- Tarefas ----------
select throws_ok($$ select crm.save_task('{"title":"x"}') $$, 'P0150', null, 'título curto');
select throws_ok($$ select crm.save_task('{"title":"Ligar para a cliente","type":"VOAR"}') $$, 'P0150', null, 'tipo inválido');
select throws_ok($$ select crm.save_task('{"title":"Ligar para a cliente","party_id":"00000000-0000-0000-0000-000000000000"}') $$, 'P0150', null, 'cliente inexistente');
insert into ids select 'task', (crm.save_task(jsonb_build_object('deal_id', (select v from ids where k = 'deal'), 'title', 'Mandar fotos do look', 'type', 'message', 'due_at', now() + interval '1 day',
  'suggested_message', 'Oi! Separei o look que você gostou.'))).id::text;
select is((select party_id::text || '/' || type || '/' || assignee_member_id::text from crm.tasks where id = (select v from ids where k = 'task')::uuid), (select v from ids where k = 'party') || '/MESSAGE/00000000-0000-4000-8000-000000000102', 'cliente vem da oportunidade, tipo em maiúsculas, responsável padrão');
select is((crm.save_task(jsonb_build_object('id', (select v from ids where k = 'task'), 'deal_id', (select v from ids where k = 'deal'), 'title', 'Mandar fotos do look novo'))).title, 'Mandar fotos do look novo', 'edita tarefa aberta');
select is((crm.reschedule_task((select v from ids where k = 'task')::uuid, now() + interval '3 days')).due_at > now() + interval '2 days', true, 'adia');
select is((crm.set_task_status((select v from ids where k = 'task')::uuid, 'DONE')).completed_at is not null, true, 'concluir marca a data');
select ok(exists (select 1 from crm.timeline_events where source_id = (select v from ids where k = 'task')::uuid and kind = 'TASK_DONE'), 'tarefa concluída na linha do tempo');
select throws_ok($$ select crm.reschedule_task((select v from ids where k = 'task')::uuid, now()) $$, 'P0152', null, 'encerrada não se adia');
select throws_ok($$ select crm.save_task(jsonb_build_object('id', (select v from ids where k = 'task'), 'title', 'Reeditar')) $$, 'P0152', null, 'encerrada não se edita');
select is((crm.set_task_status((select v from ids where k = 'task')::uuid, 'OPEN')).completed_at is null, true, 'reabrir limpa a data de conclusão');
select is((crm.set_task_status((select v from ids where k = 'task')::uuid, 'CANCELLED')).status, 'CANCELLED', 'cancela');
select throws_ok($$ select crm.set_task_status((select v from ids where k = 'task')::uuid, 'TALVEZ') $$, 'P0150', null, 'situação inválida');
select throws_ok($$ select crm.set_task_status(gen_random_uuid(), 'DONE') $$, 'P0152', null, 'tarefa inexistente');

-- ---------- Privilégios ----------
select ok(not has_function_privilege('authenticated', 'private.timeline(uuid,uuid,text,text,uuid,text,jsonb)', 'execute'), 'a linha do tempo só é escrita por dentro das funções');
select ok(has_function_privilege('authenticated', 'crm.move_deal(uuid,uuid,text)', 'execute'), 'mover oportunidade é chamável pela tela');

select * from finish();
rollback;
