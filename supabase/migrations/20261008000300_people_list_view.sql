-- =====================================================================
-- Lista de Clientes & Leads sem listas de ids na URL.
-- A tela filtrava passando ids (quem esconder, quem faz aniversário) na consulta; com muitos cadastros a URL passava do limite
-- e o proxy devolvia 502. Esta visão traz os papéis, o aniversário (MM-DD) e o segmento de cada pessoa: os filtros e a ordenação
-- viram colunas. RLS do cadastro vale (security_invoker).
-- =====================================================================
create or replace view crm.v_people_list with (security_invoker = true) as
select p.id, p.org_id, p.display_name, p.city, p.birth_date, to_char(p.birth_date, 'MM-DD') as birth_md,
       p.lifecycle_stage, p.tier, p.lead_score, p.last_purchase_at, p.tags,
       coalesce(r.roles, '{}') as roles,
       coalesce(r.roles && array['EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK']::text[], false) as is_internal,
       m.rfm_segment, coalesce(m.at_risk, false) as at_risk
from crm.parties p
left join lateral (select array_agg(pr.role::text order by pr.role::text) as roles from crm.party_roles pr where pr.party_id = p.id) r on true
left join crm.customer_metrics m on m.party_id = p.id
where p.merged_into_id is null and p.anonymized_at is null;
grant select on crm.v_people_list to authenticated;
