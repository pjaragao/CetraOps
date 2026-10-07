-- =====================================================================
-- Aniversariantes: o resumo do dia e a lista de clientes passam a contar as mesmas pessoas.
-- A lista de clientes esconde quem é só colaborador, fornecedor, prestador, transportadora, adquirente ou banco; o resumo contava essas
-- pessoas (bastava ter o papel de cliente) e o clique levava a uma lista vazia. Agora a regra é uma só: crm.birthday_party_ids.
-- =====================================================================

create or replace function crm.birthday_party_ids(p_scope text default 'today') returns setof uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_today date := private.today_sp();
begin
  perform private.require_perm('crm.read');
  if p_scope not in ('today', 'month') then raise exception 'Escolha hoje ou mês' using errcode = 'P0150'; end if;
  return query
    select p.id from crm.parties p
    where p.org_id = v_org and p.merged_into_id is null and p.anonymized_at is null and p.archived_at is null and p.birth_date is not null
      and extract(month from p.birth_date) = extract(month from v_today)
      and (p_scope = 'month' or extract(day from p.birth_date) = extract(day from v_today))
      and exists (select 1 from crm.party_roles r where r.party_id = p.id and r.role = 'CUSTOMER')
      and not exists (select 1 from crm.party_roles r where r.party_id = p.id and r.role in ('EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK'));
end $$;

do $x$
declare v_def text; v_old text := $y$    select count(*) into n from crm.parties p
    where p.org_id = v_org and p.merged_into_id is null and p.archived_at is null and p.birth_date is not null
      and extract(month from p.birth_date) = extract(month from v_today) and extract(day from p.birth_date) = extract(day from v_today)
      and exists (select 1 from crm.party_roles r where r.party_id = p.id and r.role = 'CUSTOMER');$y$;
begin
  select pg_get_functiondef('ai.daily_briefing()'::regprocedure) into v_def;
  if position(v_old in v_def) = 0 then raise exception 'daily_briefing mudou: ajuste este patch'; end if;
  v_def := replace(v_def, v_old, $y$    select count(*) into n from crm.birthday_party_ids('today');$y$);
  execute v_def;
end $x$;
