-- =====================================================================
-- Etapas dos demais funis do CRM (o de varejo vem em 01_config.sql). Idempotente.
-- =====================================================================
insert into crm.pipeline_stages (org_id, pipeline_id, name, position, probability, sla_hours, is_won, is_lost)
select p.org_id, p.id, s.name, s.pos, s.prob, s.sla, s.won, s.lost
from crm.pipelines p
join (values
  ('AFFILIATE_RECRUIT', 'Indicada', 1, 10, 72, false, false), ('AFFILIATE_RECRUIT', 'Contatada', 2, 25, 72, false, false), ('AFFILIATE_RECRUIT', 'Conversa / reunião', 3, 50, 96, false, false),
  ('AFFILIATE_RECRUIT', 'Aprovada como afiliada', 4, 100, null, true, false), ('AFFILIATE_RECRUIT', 'Não seguiu', 5, 0, null, false, true),
  ('B2B_CORPORATE', 'Lead', 1, 10, 48, false, false), ('B2B_CORPORATE', 'Briefing', 2, 25, 72, false, false), ('B2B_CORPORATE', 'Proposta enviada', 3, 50, 96, false, false),
  ('B2B_CORPORATE', 'Negociação', 4, 75, 96, false, false), ('B2B_CORPORATE', 'Fechado', 5, 100, null, true, false), ('B2B_CORPORATE', 'Perdido', 6, 0, null, false, true),
  ('EVENT', 'Convidada', 1, 10, 48, false, false), ('EVENT', 'Confirmou presença', 2, 40, 24, false, false), ('EVENT', 'Compareceu', 3, 70, 48, false, false),
  ('EVENT', 'Comprou', 4, 100, null, true, false), ('EVENT', 'Não veio', 5, 0, null, false, true)
) as s(kind, name, pos, prob, sla, won, lost) on s.kind = p.kind
where p.org_id = '00000000-0000-4000-8000-000000000001'
on conflict (pipeline_id, position) do nothing;
