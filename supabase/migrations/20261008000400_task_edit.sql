-- =====================================================================
-- Editar e atribuir tarefas (inclusive as geradas por régua, IA, retomada e automações).
-- crm.update_task muda só o que vier no p: título, responsável (vazio = sem responsável), prazo, tipo, mensagem pronta e observações.
-- O tipo de tarefa gerada pelo sistema (JOURNEY, RECOVERY…) se mantém se não vier outro.
-- =====================================================================
create or replace function crm.update_task(p jsonb) returns crm.tasks
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); t crm.tasks; v_assignee uuid; v_title text; v_type text;
begin
  perform private.require_perm('crm.write');
  select * into t from crm.tasks where id = nullif(p ->> 'id', '')::uuid and org_id = v_org for update;
  if t.id is null then raise exception 'Tarefa não encontrada' using errcode = 'P0152'; end if;
  if t.status <> 'OPEN' then raise exception 'Reabra a tarefa para editar' using errcode = 'P0152'; end if;
  if p ? 'title' then
    v_title := trim(coalesce(p ->> 'title', ''));
    if length(v_title) not between 2 and 140 then raise exception 'O título da tarefa tem de 2 a 140 caracteres' using errcode = 'P0150'; end if;
  end if;
  if p ? 'assignee_member_id' then
    v_assignee := nullif(p ->> 'assignee_member_id', '')::uuid;
    if v_assignee is not null and not exists (select 1 from core.members where id = v_assignee and org_id = v_org and status = 'ACTIVE') then raise exception 'Responsável inválido' using errcode = 'P0150'; end if;
  end if;
  if p ? 'type' then
    v_type := upper(trim(coalesce(p ->> 'type', '')));
    if v_type = '' then v_type := t.type;
    elsif v_type not in ('FOLLOW_UP', 'CALL', 'MESSAGE', 'VISIT', 'BIRTHDAY', 'REACTIVATION', 'OTHER') and v_type <> t.type then raise exception 'Tipo de tarefa inválido' using errcode = 'P0150'; end if;
  end if;
  update crm.tasks set
    title = case when p ? 'title' then v_title else title end,
    assignee_member_id = case when p ? 'assignee_member_id' then v_assignee else assignee_member_id end,
    type = coalesce(v_type, type),
    due_at = case when p ? 'due_at' then nullif(p ->> 'due_at', '')::timestamptz else due_at end,
    suggested_message = case when p ? 'suggested_message' then nullif(trim(coalesce(p ->> 'suggested_message', '')), '') else suggested_message end,
    body = case when p ? 'body' then nullif(trim(coalesce(p ->> 'body', '')), '') else body end
  where id = t.id returning * into t;
  return t;
end $$;
select private.lock_functions();
