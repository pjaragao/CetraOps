-- =====================================================================
-- RLS: negado por padrão. Regra geral por tabela:
--   leitura  = mesma org  E permissão '<schema>.read'  E (se tiver store_id) acesso à loja
--   escrita  = mesma org  E permissão '<schema>.write' E (se tiver store_id) acesso à loja
-- Exceções: dados sensíveis, tabelas de RBAC, livros-razão (escrita só por RPC) e webhooks (só service_role).
-- =====================================================================

do $$
declare
  r record;
  has_org boolean;
  has_store boolean;
  s text;
  cond_read text;
  cond_write text;
begin
  for r in
    select n.nspname as sch, c.relname as tbl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname in ('core', 'crm', 'catalog', 'inv', 'sales', 'fin', 'fiscal', 'omni', 'ai')
  loop
    execute format('alter table %I.%I enable row level security', r.sch, r.tbl);

    select exists (select 1 from information_schema.columns where table_schema = r.sch and table_name = r.tbl and column_name = 'org_id') into has_org;
    select exists (select 1 from information_schema.columns where table_schema = r.sch and table_name = r.tbl and column_name = 'store_id') into has_store;
    if not has_org then continue; end if;  -- tratadas individualmente abaixo

    s := r.sch;
    cond_read := format('org_id = (select private.org_id()) and (select private.has_perm(%L))', s || '.read');
    cond_write := format('org_id = (select private.org_id()) and (select private.has_perm(%L))', s || '.write');
    if has_store then
      cond_read := cond_read || ' and private.can_store(store_id)';
      cond_write := cond_write || ' and private.can_store(store_id)';
    end if;

    execute format('create policy p_read on %I.%I for select to authenticated using (%s)', r.sch, r.tbl, cond_read);
    execute format('create policy p_insert on %I.%I for insert to authenticated with check (%s)', r.sch, r.tbl, cond_write);
    execute format('create policy p_update on %I.%I for update to authenticated using (%s) with check (%s)', r.sch, r.tbl, cond_write, cond_write);
    execute format('create policy p_delete on %I.%I for delete to authenticated using (%s)', r.sch, r.tbl, cond_write);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Organização e RBAC: todos da org leem; só 'core.admin' altera
-- ---------------------------------------------------------------------
create policy p_read on core.orgs for select to authenticated using (id = (select private.org_id()));

drop policy p_read on core.members;
create policy p_read on core.members for select to authenticated using (org_id = (select private.org_id()));
drop policy p_read on core.roles;
create policy p_read on core.roles for select to authenticated using (org_id = (select private.org_id()));

do $$
declare t text;
begin
  foreach t in array array['members', 'roles', 'legal_entities', 'stores', 'cost_centers', 'integration_connections', 'feature_flags', 'settings'] loop
    execute format('drop policy if exists p_insert on core.%I', t);
    execute format('drop policy if exists p_update on core.%I', t);
    execute format('drop policy if exists p_delete on core.%I', t);
    execute format($p$create policy p_admin on core.%I for all to authenticated
      using (org_id = (select private.org_id()) and (select private.has_perm('core.admin')))
      with check (org_id = (select private.org_id()) and (select private.has_perm('core.admin')))$p$, t);
  end loop;
end $$;

-- Lojas, empresas e configurações são lidas por qualquer membro (seletor de contexto, menus)
drop policy p_read on core.stores;
create policy p_read on core.stores for select to authenticated
  using (org_id = (select private.org_id()) and private.can_store(id));
drop policy p_read on core.legal_entities;
create policy p_read on core.legal_entities for select to authenticated using (org_id = (select private.org_id()));
drop policy p_read on core.feature_flags;
create policy p_read on core.feature_flags for select to authenticated using (org_id = (select private.org_id()));
drop policy p_read on core.settings;
create policy p_read on core.settings for select to authenticated using (org_id = (select private.org_id()));

-- Notificações: cada membro só vê as suas
drop policy p_read on core.notifications;
drop policy p_update on core.notifications;
create policy p_read on core.notifications for select to authenticated using (member_id = (select private.member_id()));
create policy p_update on core.notifications for update to authenticated
  using (member_id = (select private.member_id())) with check (member_id = (select private.member_id()));

create policy p_read on core.role_permissions for select to authenticated
  using (exists (select 1 from core.roles r where r.id = role_id and r.org_id = (select private.org_id())));
create policy p_admin on core.role_permissions for all to authenticated
  using ((select private.has_perm('core.admin')) and exists (select 1 from core.roles r where r.id = role_id and r.org_id = (select private.org_id())))
  with check ((select private.has_perm('core.admin')) and exists (select 1 from core.roles r where r.id = role_id and r.org_id = (select private.org_id())));
create policy p_read on core.member_roles for select to authenticated
  using (exists (select 1 from core.members m where m.id = member_id and m.org_id = (select private.org_id())));
create policy p_admin on core.member_roles for all to authenticated
  using ((select private.has_perm('core.admin')) and exists (select 1 from core.members m where m.id = member_id and m.org_id = (select private.org_id())))
  with check ((select private.has_perm('core.admin')) and exists (select 1 from core.members m where m.id = member_id and m.org_id = (select private.org_id())));
create policy p_read on core.member_store_access for select to authenticated
  using (exists (select 1 from core.members m where m.id = member_id and m.org_id = (select private.org_id())));
create policy p_admin on core.member_store_access for all to authenticated
  using ((select private.has_perm('core.admin')) and exists (select 1 from core.members m where m.id = member_id and m.org_id = (select private.org_id())))
  with check ((select private.has_perm('core.admin')) and exists (select 1 from core.members m where m.id = member_id and m.org_id = (select private.org_id())));

-- O hook de claims roda como supabase_auth_admin
grant usage on schema core to supabase_auth_admin;
grant select on core.members to supabase_auth_admin;
create policy p_auth_hook on core.members for select to supabase_auth_admin using (true);

-- ---------------------------------------------------------------------
-- Dados sensíveis (CPF): permissão específica
-- ---------------------------------------------------------------------
drop policy p_read on crm.party_sensitive;
drop policy p_insert on crm.party_sensitive;
drop policy p_update on crm.party_sensitive;
drop policy p_delete on crm.party_sensitive;
create policy p_sensitive on crm.party_sensitive for all to authenticated
  using (org_id = (select private.org_id()) and (select private.has_perm('crm.sensitive')))
  with check (org_id = (select private.org_id()) and (select private.has_perm('crm.sensitive')));

-- ---------------------------------------------------------------------
-- Livros-razão e documentos transacionais: leitura por RLS, escrita só via RPC (security definer)
-- ---------------------------------------------------------------------
revoke insert, update, delete on
  inv.movements, inv.stock_levels, inv.item_costs,
  sales.orders, sales.order_items, sales.payments, sales.order_credits, sales.cash_session_movements,
  sales.store_credit_ledger, sales.coupon_redemptions,
  crm.consents, crm.timeline_events, crm.deal_stage_history,
  omni.messages, omni.mode_events, ai.model_route_changes, ai.runs
from authenticated;
grant insert on crm.consents to authenticated;  -- registrar consentimento na ficha do cliente é permitido

-- Tabelas sem org_id
create policy p_read on ai.tool_calls for select to authenticated
  using (exists (select 1 from ai.runs r where r.id = run_id and r.org_id = (select private.org_id())) and (select private.has_perm('ai.read')));
create policy p_read on fiscal.simples_brackets for select to authenticated using (true);
-- omni.webhook_events: RLS ligado e nenhuma policy → só service_role

-- Realtime: inbox e notificações ao vivo
alter publication supabase_realtime add table omni.conversations, omni.messages, omni.message_drafts, core.notifications;
