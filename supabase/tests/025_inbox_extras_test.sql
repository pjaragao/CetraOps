begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

create or replace function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare m record;
begin
  select id, org_id into m from core.members where user_id = p_user;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('org_id', m.org_id, 'member_id', m.id))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

-- Conversa do seed de desenvolvimento (...0621), em Copiloto; sócio = ...0101, vendedora = ...0102
insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, body, provider_message_id)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000621', '00000000-0000-4000-8000-000000000601', 'IN', 'CUSTOMER', 'Tem no M?', 'inbox-extras-1');
update omni.conversations set ai_paused_until = null, ai_instruction = null, assignee_member_id = null, mode = 'AI_COPILOT', status = 'OPEN' where id = '00000000-0000-4000-8000-000000000621';

select pg_temp.login('00000000-0000-4000-8000-0000000000f2');   -- vendedora (omni.write)

-- ---------- Pausar a IA ----------
select throws_ok($$ select omni.pause_ai('00000000-0000-4000-8000-000000000621', 2000) $$, 'P0220', null, 'pausa de no máximo 24 horas');
select ok((omni.pause_ai('00000000-0000-4000-8000-000000000621', 120)).ai_paused_until between now() + interval '119 minutes' and now() + interval '121 minutes', 'pausa por 2 horas');
reset role;
select is((omni.claim_router('00000000-0000-4000-8000-000000000621', (select id from omni.messages where provider_message_id = 'inbox-extras-1')) ->> 'ai_paused')::boolean, true, 'o roteador enxerga a pausa');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is((omni.pause_ai('00000000-0000-4000-8000-000000000621', 0)).ai_paused_until, null, 'zero retoma a IA');
select throws_ok($$ select omni.pause_ai('00000000-0000-4000-8000-0000000000ff', 30) $$, 'P0222', null, 'conversa inexistente');

-- ---------- Atribuir ----------
select throws_ok($$ select omni.assign_conversation('00000000-0000-4000-8000-000000000621', '00000000-0000-4000-8000-0000000000ee') $$, 'P0220', null, 'só pessoas da equipe');
select is((omni.assign_conversation('00000000-0000-4000-8000-000000000621', '00000000-0000-4000-8000-000000000101')).assignee_member_id, '00000000-0000-4000-8000-000000000101'::uuid, 'atribuída ao sócio');
reset role;
select ok(exists (select 1 from core.notifications where kind = 'ASSIGNED' and member_id = '00000000-0000-4000-8000-000000000101' and payload ->> 'conversation_id' = '00000000-0000-4000-8000-000000000621'), 'o sócio é avisado');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is((omni.assign_conversation('00000000-0000-4000-8000-000000000621', null)).assignee_member_id, null, 'tirar o dono');

-- ---------- Notas internas ----------
select throws_ok($$ select omni.add_note('00000000-0000-4000-8000-000000000621', '   ') $$, 'P0220', null, 'nota vazia');
select is((omni.add_note('00000000-0000-4000-8000-000000000621', '@Sócio ela pediu o link, pode ver?', array['00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-0000000000ee']::uuid[])).mentions, array['00000000-0000-4000-8000-000000000101']::uuid[], 'só menciona quem é da equipe');
reset role;
select ok(exists (select 1 from core.notifications where kind = 'MENTION' and member_id = '00000000-0000-4000-8000-000000000101' and title like 'Vendedora (teste) mencionou você%'), 'a pessoa mencionada recebe o aviso');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select is((select count(*)::int from core.notifications where kind = 'MENTION' and member_id = '00000000-0000-4000-8000-000000000102'), 0, 'quem escreve não se avisa');
select is((select count(*)::int from omni.messages where conversation_id = '00000000-0000-4000-8000-000000000621' and body like '%pediu o link%'), 0, 'a nota nunca vira mensagem para a cliente');
select is((select member_id from omni.internal_notes where body like '@Sócio%'), '00000000-0000-4000-8000-000000000102'::uuid, 'fica registrado quem escreveu');

-- ---------- Devolver para a IA ----------
select throws_ok($$ select omni.return_to_ai('00000000-0000-4000-8000-000000000621', 'HUMAN') $$, 'P0220', null, 'só devolve para Copiloto ou Piloto');
select throws_ok($$ select omni.return_to_ai('00000000-0000-4000-8000-000000000621', 'AI_COPILOT', repeat('x', 501)) $$, 'P0220', null, 'instrução curta');
select omni.set_mode('00000000-0000-4000-8000-000000000621', 'HUMAN');
select is((omni.return_to_ai('00000000-0000-4000-8000-000000000621', 'AI_COPILOT', 'Confirme o endereço e envie o link')).ai_instruction, 'Confirme o endereço e envie o link', 'devolvida com instrução');
select ok((select mode = 'AI_COPILOT' and ai_paused_until is null from omni.conversations where id = '00000000-0000-4000-8000-000000000621'), 'volta ao modo da IA e tira a pausa');
reset role;
select is(omni.claim_router('00000000-0000-4000-8000-000000000621', (select id from omni.messages where provider_message_id = 'inbox-extras-1')) ->> 'instruction', 'Confirme o endereço e envie o link', 'o roteador entrega a instrução à IA');
select pg_temp.login('00000000-0000-4000-8000-0000000000f2');
select ok(exists (select 1 from omni.internal_notes where body = 'Devolvida para a IA com a instrução: Confirme o endereço e envie o link'), 'a instrução fica registrada na conversa');
select omni.set_mode('00000000-0000-4000-8000-000000000621', 'HUMAN');
select is((select ai_instruction from omni.conversations where id = '00000000-0000-4000-8000-000000000621'), null, 'quando uma pessoa assume, a instrução deixa de valer');

reset role;
select ok(not has_function_privilege('authenticated', 'private.conversation_for_update(uuid)', 'execute') and has_function_privilege('authenticated', 'omni.add_note(uuid,text,uuid[])', 'execute'), 'privilégios');

select * from finish();
rollback;
