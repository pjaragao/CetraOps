-- =====================================================================
-- Resumo do dia: o item de aniversário fala das tarefas, não só das datas.
-- "N contatos de aniversário para hoje" = tarefas de aniversário em aberto que vencem até hoje; o link abre exatamente essa lista.
-- Sem tarefa (régua desligada ou pessoa fora dela), cai no aviso antigo e leva para a lista de clientes que fazem aniversário hoje.
-- Tarefas de aniversário abertas com prazo depois do próprio aniversário voltam para o dia (20h).
-- =====================================================================
do $x$
declare v_def text; v_old text := $y$    select count(*) into n from crm.birthday_party_ids('today');
    if n > 0 then items := items || jsonb_build_object('key', 'aniversariantes', 'count', n, 'tone', 'neutral', 'href', '/clientes/tarefas?ver=todas&tipo=BIRTHDAY'); end if;$y$;
begin
  select pg_get_functiondef('ai.daily_briefing()'::regprocedure) into v_def;
  if position(v_old in v_def) = 0 then raise exception 'daily_briefing mudou: ajuste este patch'; end if;
  v_def := replace(v_def, v_old, $y$    select count(*) into n from crm.tasks t where t.org_id = v_org and t.type = 'BIRTHDAY' and t.status = 'OPEN'
      and t.due_at < ((v_today + 1)::timestamp at time zone 'America/Sao_Paulo');
    if n > 0 then
      items := items || jsonb_build_object('key', 'aniversarios_contatar', 'count', n, 'tone', 'neutral', 'href', '/clientes/tarefas?ver=todas&tipo=BIRTHDAY&quando=hoje');
    else
      select count(*) into n from crm.birthday_party_ids('today');
      if n > 0 then items := items || jsonb_build_object('key', 'aniversariantes', 'count', n, 'tone', 'neutral', 'href', '/clientes?aniversario=hoje'); end if;
    end if;$y$);
  execute v_def;
end $x$;

with b as (
  select t.id, case when t.source_rule ~ '^journey:[0-9a-f-]{36}:' then private.enrollment_birthday(split_part(t.source_rule, ':', 2)::uuid) end as bday, t.due_at
  from crm.tasks t where t.type = 'BIRTHDAY' and t.status = 'OPEN'
)
update crm.tasks t set due_at = (b.bday + time '20:00') at time zone 'America/Sao_Paulo'
from b where b.id = t.id and b.bday is not null and b.due_at > (b.bday + time '20:00') at time zone 'America/Sao_Paulo';
