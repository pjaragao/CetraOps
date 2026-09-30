-- =====================================================================
-- Clientes › Funis e Tarefas.
-- Oportunidades (deals) andam por etapas de um funil; ganhar/perder exige a etapa certa (e o motivo da perda); cada passo vai para a linha do tempo da cliente.
-- Tarefas de próxima ação (da equipe ou sugeridas pela IA) com prazo, responsável e mensagem pronta.
-- Códigos de erro: P0150 dado inválido · P0151 situação não permite · P0152 não encontrado.
-- =====================================================================

create index if not exists deals_party_idx on crm.deals (party_id);
create index if not exists deals_owner_idx on crm.deals (owner_member_id) where status = 'OPEN';
create index if not exists tasks_party_idx on crm.tasks (party_id) where status = 'OPEN';
create index if not exists tasks_deal_idx on crm.tasks (deal_id) where deal_id is not null;
drop trigger if exists trg_audit on crm.deals;
create trigger trg_audit after insert or update or delete on crm.deals for each row execute function private.audit_capture();

create or replace function private.timeline(p_org uuid, p_party uuid, p_kind text, p_source_type text, p_source uuid, p_summary text, p_payload jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into crm.timeline_events (org_id, party_id, kind, source_type, source_id, summary, payload) values (p_org, p_party, p_kind, p_source_type, p_source, p_summary, coalesce(p_payload, '{}'))
$$;

-- ---------------------------------------------------------------------
-- 1) Oportunidades
-- p = {id?, party_id, pipeline_id, title, value_estimated?, owner_member_id?, conversation_id?}
-- Nova oportunidade entra na primeira etapa do funil; a etapa só muda por crm.move_deal.
-- ---------------------------------------------------------------------
create or replace function crm.save_deal(p jsonb) returns crm.deals
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_party uuid := nullif(p ->> 'party_id', '')::uuid; v_pipe uuid := nullif(p ->> 'pipeline_id', '')::uuid;
  v_title text := trim(coalesce(p ->> 'title', '')); v_value numeric(14, 2) := nullif(p ->> 'value_estimated', '')::numeric; v_owner uuid := coalesce(nullif(p ->> 'owner_member_id', '')::uuid, private.member_id());
  v_conv uuid := nullif(p ->> 'conversation_id', '')::uuid; d crm.deals; v_stage uuid;
begin
  perform private.require_perm('crm.write');
  if length(v_title) not between 2 and 120 then raise exception 'O título da oportunidade tem de 2 a 120 caracteres' using errcode = 'P0150'; end if;
  if v_value is not null and v_value < 0 then raise exception 'O valor estimado não pode ser negativo' using errcode = 'P0150'; end if;
  if v_owner is not null and not exists (select 1 from core.members where id = v_owner and org_id = v_org) then raise exception 'Responsável inválido' using errcode = 'P0150'; end if;
  if v_conv is not null and not exists (select 1 from omni.conversations where id = v_conv and org_id = v_org) then raise exception 'Conversa inválida' using errcode = 'P0150'; end if;
  if v_id is null then
    if not exists (select 1 from crm.parties where id = v_party and org_id = v_org and merged_into_id is null) then raise exception 'Escolha a cliente' using errcode = 'P0150'; end if;
    select id into v_stage from crm.pipeline_stages where pipeline_id = v_pipe and org_id = v_org order by position limit 1;
    if v_stage is null then raise exception 'Funil sem etapas' using errcode = 'P0150'; end if;
    insert into crm.deals (org_id, party_id, pipeline_id, stage_id, title, value_estimated, owner_member_id, conversation_id)
    values (v_org, v_party, v_pipe, v_stage, v_title, v_value, v_owner, v_conv) returning * into d;
    perform private.timeline(v_org, v_party, 'DEAL_CREATED', 'deal', d.id, 'Oportunidade criada: ' || v_title, jsonb_build_object('pipeline_id', v_pipe));
  else
    select * into d from crm.deals where id = v_id and org_id = v_org for update;
    if d.id is null then raise exception 'Oportunidade não encontrada' using errcode = 'P0152'; end if;
    if d.status <> 'OPEN' then raise exception 'Oportunidade encerrada não se edita: reabra movendo para uma etapa aberta' using errcode = 'P0151'; end if;
    update crm.deals set title = v_title, value_estimated = v_value, owner_member_id = v_owner where id = v_id returning * into d;
  end if;
  return d;
end $$;

-- Move para outra etapa do MESMO funil. Etapa de perda exige motivo; etapa de ganho fecha como ganha; etapa aberta reabre.
create or replace function crm.move_deal(p_deal uuid, p_stage uuid, p_reason text default null) returns crm.deals
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); d crm.deals; s crm.pipeline_stages; v_status text; v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  perform private.require_perm('crm.write');
  select * into d from crm.deals where id = p_deal and org_id = v_org for update;
  if d.id is null then raise exception 'Oportunidade não encontrada' using errcode = 'P0152'; end if;
  select * into s from crm.pipeline_stages where id = p_stage and pipeline_id = d.pipeline_id and org_id = v_org;
  if s.id is null then raise exception 'Essa etapa não pertence ao funil da oportunidade' using errcode = 'P0150'; end if;
  if s.id = d.stage_id then return d; end if;
  v_status := case when s.is_won then 'WON' when s.is_lost then 'LOST' else 'OPEN' end;
  if v_status = 'LOST' and (v_reason is null or length(v_reason) < 3) then raise exception 'Informe o motivo da perda' using errcode = 'P0150'; end if;
  update crm.deals set stage_id = s.id, status = v_status, lost_reason = case when v_status = 'LOST' then v_reason end where id = d.id returning * into d;
  perform private.timeline(v_org, d.party_id, case v_status when 'WON' then 'DEAL_WON' when 'LOST' then 'DEAL_LOST' else 'DEAL_MOVED' end, 'deal', d.id,
    case v_status when 'WON' then 'Oportunidade ganha: ' when 'LOST' then 'Oportunidade perdida: ' else 'Oportunidade movida para ' || s.name || ': ' end || d.title
      || case when v_status = 'LOST' then ' (' || v_reason || ')' else '' end, jsonb_build_object('stage', s.name));
  if v_status = 'WON' then
    update crm.parties set lifecycle_stage = 'CUSTOMER' where id = d.party_id and lifecycle_stage in ('LEAD', 'PROSPECT');
  end if;
  return d;
end $$;

create or replace function crm.delete_deal(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare d crm.deals;
begin
  perform private.require_perm('crm.write');
  select * into d from crm.deals where id = p_id and org_id = private.org_id() for update;
  if d.id is null then raise exception 'Oportunidade não encontrada' using errcode = 'P0152'; end if;
  if d.won_order_id is not null then raise exception 'Oportunidade ligada a um pedido não se exclui' using errcode = 'P0151'; end if;
  delete from crm.deals where id = p_id;
end $$;

-- ---------------------------------------------------------------------
-- 2) Tarefas (próxima ação)
-- p = {id?, party_id?, deal_id?, assignee_member_id?, type?, title, body?, suggested_message?, due_at?}
-- ---------------------------------------------------------------------
create or replace function crm.save_task(p jsonb) returns crm.tasks
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_party uuid := nullif(p ->> 'party_id', '')::uuid; v_deal uuid := nullif(p ->> 'deal_id', '')::uuid;
  v_assignee uuid := coalesce(nullif(p ->> 'assignee_member_id', '')::uuid, private.member_id()); v_type text := upper(coalesce(nullif(trim(p ->> 'type'), ''), 'FOLLOW_UP'));
  v_title text := trim(coalesce(p ->> 'title', '')); v_due timestamptz := nullif(p ->> 'due_at', '')::timestamptz; t crm.tasks;
begin
  perform private.require_perm('crm.write');
  if length(v_title) not between 2 and 140 then raise exception 'O título da tarefa tem de 2 a 140 caracteres' using errcode = 'P0150'; end if;
  if v_type not in ('FOLLOW_UP', 'CALL', 'MESSAGE', 'VISIT', 'BIRTHDAY', 'REACTIVATION', 'OTHER') then raise exception 'Tipo de tarefa inválido' using errcode = 'P0150'; end if;
  if v_assignee is not null and not exists (select 1 from core.members where id = v_assignee and org_id = v_org) then raise exception 'Responsável inválido' using errcode = 'P0150'; end if;
  if v_deal is not null then
    select party_id into v_party from crm.deals where id = v_deal and org_id = v_org;
    if v_party is null then raise exception 'Oportunidade não encontrada' using errcode = 'P0152'; end if;
  elsif v_party is not null and not exists (select 1 from crm.parties where id = v_party and org_id = v_org) then raise exception 'Cliente inválida' using errcode = 'P0150'; end if;
  if v_id is null then
    insert into crm.tasks (org_id, party_id, deal_id, assignee_member_id, type, title, body, suggested_message, due_at)
    values (v_org, v_party, v_deal, v_assignee, v_type, v_title, nullif(trim(coalesce(p ->> 'body', '')), ''), nullif(trim(coalesce(p ->> 'suggested_message', '')), ''), v_due) returning * into t;
  else
    update crm.tasks set party_id = v_party, deal_id = v_deal, assignee_member_id = v_assignee, type = v_type, title = v_title, body = nullif(trim(coalesce(p ->> 'body', '')), ''),
           suggested_message = nullif(trim(coalesce(p ->> 'suggested_message', '')), ''), due_at = v_due
    where id = v_id and org_id = v_org and status = 'OPEN' returning * into t;
    if t.id is null then raise exception 'Tarefa não encontrada ou já encerrada' using errcode = 'P0152'; end if;
  end if;
  return t;
end $$;

create or replace function crm.set_task_status(p_id uuid, p_status text) returns crm.tasks
language plpgsql security definer set search_path = '' as $$
declare t crm.tasks;
begin
  perform private.require_perm('crm.write');
  if p_status not in ('OPEN', 'DONE', 'CANCELLED') then raise exception 'Situação inválida' using errcode = 'P0150'; end if;
  update crm.tasks set status = p_status, completed_at = case when p_status = 'DONE' then now() end where id = p_id and org_id = private.org_id() returning * into t;
  if t.id is null then raise exception 'Tarefa não encontrada' using errcode = 'P0152'; end if;
  if p_status = 'DONE' and t.party_id is not null then
    perform private.timeline(t.org_id, t.party_id, 'TASK_DONE', 'task', t.id, 'Tarefa concluída: ' || t.title);
  end if;
  return t;
end $$;

create or replace function crm.reschedule_task(p_id uuid, p_due timestamptz) returns crm.tasks
language plpgsql security definer set search_path = '' as $$
declare t crm.tasks;
begin
  perform private.require_perm('crm.write');
  update crm.tasks set due_at = p_due where id = p_id and org_id = private.org_id() and status = 'OPEN' returning * into t;
  if t.id is null then raise exception 'Tarefa não encontrada ou já encerrada' using errcode = 'P0152'; end if;
  return t;
end $$;

insert into private.internal_functions (fqname) values ('private.timeline') on conflict do nothing;
select private.lock_functions();
