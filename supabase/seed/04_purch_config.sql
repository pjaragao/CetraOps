-- =====================================================================
-- Seed de CONFIGURAÇÃO de compras (idempotente): permissões e condições de pagamento padrão.
-- =====================================================================

insert into core.role_permissions (role_id, permission_key)
select r.id, p from core.roles r, unnest(case r.key
  when 'finance' then array['purch.read', 'purch.write', 'purch.approve']
  when 'accountant' then array['purch.read']
  else array[]::text[] end) as p
where r.org_id = '00000000-0000-4000-8000-000000000001' and r.key in ('finance', 'accountant')
on conflict do nothing;

insert into purch.payment_terms (org_id, name, installments) values
  ('00000000-0000-4000-8000-000000000001', 'À vista', '[{"days":0,"pct":100}]'),
  ('00000000-0000-4000-8000-000000000001', '30 dias', '[{"days":30,"pct":100}]'),
  ('00000000-0000-4000-8000-000000000001', '30/60 dias', '[{"days":30,"pct":50},{"days":60,"pct":50}]'),
  ('00000000-0000-4000-8000-000000000001', '30/60/90 dias', '[{"days":30,"pct":33.33},{"days":60,"pct":33.33},{"days":90,"pct":33.34}]')
on conflict (org_id, name) do nothing;
