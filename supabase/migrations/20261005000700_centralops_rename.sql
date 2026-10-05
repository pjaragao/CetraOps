-- =====================================================================
-- O produto se chama CentralOps. Esta migration converge um banco JÁ INSTALADO com as migrations anteriores reescritas
-- (numa instalação nova ela não encontra nada para trocar):
--   • crm.parties.joy_member_status → host_member_status: "aluna da academia parceira" no modelo shop-in-shop (a loja dentro de uma academia);
--   • funções que ainda tragam nomes ou textos antigos são recriadas a partir da própria definição (pg_get_functiondef) com as mesmas trocas
--     aplicadas aos arquivos — permissões, dono e SECURITY DEFINER se mantêm (CREATE OR REPLACE);
--   • jobs do pg_cron 'sie-*' → 'centralops-*' (mesmo horário e comando);
--   • textos e nomes gravados pelo próprio sistema (avisos, réguas, links de indicação, persona padrão, plano de contas, organização)
--     só mudam se ainda forem exatamente o padrão: o que a empresa personalizou fica como está.
-- =====================================================================

-- 1) Coluna e restrição
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'crm' and table_name = 'parties' and column_name = 'joy_member_status') then
    alter table crm.parties rename column joy_member_status to host_member_status;
  end if;
  if exists (select 1 from pg_constraint where conname = 'parties_joy_member_status_check' and conrelid = 'crm.parties'::regclass) then
    alter table crm.parties rename constraint parties_joy_member_status_check to parties_host_member_status_check;
  end if;
end $$;

-- 2) Funções com os nomes/textos antigos (as mesmas trocas feitas nos arquivos das migrations)
do $$
declare
  f record; def text; r record;
begin
  for f in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('core', 'crm', 'catalog', 'inv', 'sales', 'fin', 'fiscal', 'omni', 'ai', 'hr', 'comm', 'purch', 'aff', 'mkt', 'private', 'agent', 'audit')
      and p.prokind in ('f', 'p')
      and p.prosrc ~ '(joy_member|sie\.mode_trigger|SIÉ|JOY|siejoybot)'
  loop
    def := pg_get_functiondef(f.oid);
    for r in select * from (values
        (1,  'joy_member_status', 'host_member_status'),
        (2,  '''joy_member''', '''host_member'''),
        (3,  'Situação JOY inválida', 'Situação de aluna da academia parceira inválida'),
        (4,  'Aluna JOY (confirmada)', 'Aluna da academia parceira (confirmada)'),
        (5,  'Aluna JOY (autodeclarada)', 'Aluna da academia parceira (autodeclarada)'),
        (6,  '-- aluna JOY (autodeclarada ou confirmada na loja)', '-- aluna da academia parceira (autodeclarada ou confirmada na loja)'),
        (7,  'sie.mode_trigger', 'centralops.mode_trigger'),
        (8,  'pronto para retirar na SIÉ, dentro da JOY.', 'pronto para retirar na loja.'),
        (9,  'para você usar na SIÉ.', 'para você usar na loja.'),
        (10, 'indicaria a SIÉ para uma amiga', 'indicaria a nossa loja para uma amiga'),
        (11, 'coalesce(v_store, ''SIÉ'')', 'coalesce(v_store, ''nossa loja'')'),
        (12, 'não passa na SIÉ.', 'não passa na {loja}.'),
        (13, 'algo especial da SIÉ para presentear', 'algo especial da {loja} para presentear'),
        (14, '''Oi, SIÉ! Fui indicada por ''', '''Oi! Fui indicada por '''),
        (15, 'ex.: siejoybot', 'ex.: minhalojabot')
      ) as t(ord, a, b) order by ord
    loop
      def := replace(def, r.a, r.b);
    end loop;
    execute def;
  end loop;
end $$;

-- 3) Jobs agendados
do $$
declare j record;
begin
  for j in select jobname, schedule, command from cron.job where jobname like 'sie-%' loop
    perform cron.schedule('centralops-' || substr(j.jobname, 5), j.schedule, j.command);
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

-- 4) Textos e nomes que ainda são o padrão gravado pelo sistema
update omni.notice_rules set free_text = 'Oi, {nome}! Seu pedido {pedido} está pronto para retirar na loja.'
 where free_text = 'Oi, {nome}! Seu pedido {pedido} está pronto para retirar na SIÉ, dentro da JOY.';
update omni.notice_rules set free_text = 'Oi, {nome}! Geramos um vale-troca de {valor} para você usar na loja. Ele já está no seu cadastro.'
 where free_text = 'Oi, {nome}! Geramos um vale-troca de {valor} para você usar na SIÉ. Ele já está no seu cadastro.';
update omni.notice_rules set free_text = 'Oi, {nome}! De 0 a 10, quanto você indicaria a nossa loja para uma amiga? Responda só com o número. Sua resposta ajuda muito a gente. 💛'
 where free_text = 'Oi, {nome}! De 0 a 10, quanto você indicaria a SIÉ para uma amiga? Responda só com o número. Sua resposta ajuda muito a gente. 💛';

update mkt.journey_steps set message = replace(message, 'não passa na SIÉ.', 'não passa na {loja}.')
 where message like 'Oi, {nome}! Faz um tempinho que você não passa na SIÉ.%';
update mkt.journey_steps set message = replace(message, 'algo especial da SIÉ para presentear', 'algo especial da {loja} para presentear')
 where message like '%Quer que eu separe algo especial da SIÉ para presentear?%';

update mkt.tracking_links set prefill_text = 'Oi! Fui indicada por ' || substr(prefill_text, length('Oi, SIÉ! Fui indicada por ') + 1)
 where prefill_text like 'Oi, SIÉ! Fui indicada por %';

update ai.personas p set name = 'Concierge'
 where p.name = 'Concierge SIÉ' and not exists (select 1 from ai.personas x where x.org_id = p.org_id and x.name = 'Concierge');

update fin.chart_accounts set name = 'Patrocínio a pagar — parceiro anfitrião' where name = 'Patrocínio a pagar — JOY';
update fin.chart_accounts set name = 'Patrocínio & licença de espaço — parceiro anfitrião' where name = 'Patrocínio & licença de espaço — JOY';
update fin.chart_accounts set name = 'Crédito de afiliados (trainers parceiros)' where name = 'Crédito de afiliados (JOY Trainers)';
update fin.chart_accounts set name = 'Comissões de afiliados (trainers parceiros)' where name = 'Comissões de afiliados (JOY Trainers)';

update core.orgs o set name = 'Minha empresa', slug = 'principal'
 where o.name = 'SIÉ JOY' and o.slug = 'sie-joy' and not exists (select 1 from core.orgs x where x.slug = 'principal');

-- Pesos do score e explicações já calculadas: a chave do critério passa a ser host_member
update core.settings set value = replace(value::text, '"joy_member"', '"host_member"')::jsonb where value::text like '%"joy_member"%';
update crm.parties set score_breakdown = replace(replace(score_breakdown::text, '"joy_member"', '"host_member"'), 'Aluna JOY (', 'Aluna da academia parceira (')::jsonb
 where score_breakdown::text like '%joy_member%';
