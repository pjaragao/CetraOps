-- Busca de notas recebidas (07/11/2026): falha passageira da SEFAZ não vira aviso nem aparece na tela.
--   Em 07/11 o Ambiente Nacional respondeu "999 Falha nao tratada" por algumas horas e voltou; a tela e o sino mostraram erro
--   sem haver nada a fazer (a busca continua do último NSU, nenhuma nota se perde). Agora:
--   - falha passageira (999, serviço paralisado, pausa pedida pela SEFAZ, rede fora) só entra no registro fiscal.dfe_sync_log;
--   - se a busca ficar 24 h sem voltar ao normal, vira erro (last_error, que a tela mostra) e o worker avisa;
--   - quando volta, o registro anota "VOLTOU" e os avisos abertos da busca são fechados sozinhos.

alter table fiscal.dfe_sync_state
  add column if not exists last_ok_at timestamptz,
  add column if not exists failing_since timestamptz;
update fiscal.dfe_sync_state set last_ok_at = last_run_at where last_error is null and last_run_at is not null and last_ok_at is null;

create table if not exists fiscal.dfe_sync_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references core.orgs(id),
  legal_entity_id uuid not null references core.legal_entities(id),
  at timestamptz not null default now(),
  kind text not null check (kind in ('PASSAGEIRA', 'ERRO', 'VOLTOU')),
  message text
);
create index if not exists dfe_sync_log_entity_at_idx on fiscal.dfe_sync_log (legal_entity_id, at desc);
select private.apply_rls('fiscal', array['dfe_sync_log'], 'fiscal.read', 'fiscal.write');
select private.rpc_only('fiscal', array['dfe_sync_log']);

-- Fim de rodada (worker): p_error nulo = deu certo; preenchido = erro que não passa sozinho (credencial, certificado, rejeição)
create or replace function fiscal.dfe_set_state(p_org uuid, p_entity uuid, p_version bigint, p_found integer, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_since timestamptz;
begin
  select failing_since into v_since from fiscal.dfe_sync_state where legal_entity_id = p_entity;
  insert into fiscal.dfe_sync_state (legal_entity_id, org_id, last_version, last_run_at, last_found, last_error, last_ok_at, failing_since)
  values (p_entity, p_org, coalesce(p_version, 0), now(), coalesce(p_found, 0), p_error,
          case when p_error is null then now() end, case when p_error is not null then now() end)
  on conflict (legal_entity_id) do update set last_version = greatest(fiscal.dfe_sync_state.last_version, coalesce(excluded.last_version, 0)),
    last_run_at = now(), last_found = coalesce(p_found, 0), last_error = p_error,
    last_ok_at = case when p_error is null then now() else fiscal.dfe_sync_state.last_ok_at end,
    failing_since = case when p_error is null then null else coalesce(fiscal.dfe_sync_state.failing_since, now()) end;

  if p_error is not null then
    insert into fiscal.dfe_sync_log (org_id, legal_entity_id, kind, message) values (p_org, p_entity, 'ERRO', left(p_error, 500));
  elsif v_since is not null then
    insert into fiscal.dfe_sync_log (org_id, legal_entity_id, kind, message)
    values (p_org, p_entity, 'VOLTOU', 'busca normal de novo; falhava desde ' || to_char(v_since at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'));
    -- os avisos da busca que ficaram abertos já não valem
    update core.notifications nt set read_at = now(), payload = nt.payload || '{"resolvido_sozinho": true}'
    where nt.org_id = p_org and nt.read_at is null and nt.kind = 'INTEGRATION_ERROR' and nt.title like 'Busca de notas recebidas%';
  end if;
  delete from fiscal.dfe_sync_log where legal_entity_id = p_entity and at < now() - interval '90 days';
end $$;

-- Falha passageira da SEFAZ: guarda o progresso e o registro; devolve true quando já passou do prazo (aí vira erro e o worker avisa)
create or replace function fiscal.dfe_set_transient(p_org uuid, p_entity uuid, p_version bigint, p_found integer, p_error text,
                                                    p_grace interval default interval '24 hours')
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_since timestamptz; v_late boolean;
begin
  insert into fiscal.dfe_sync_state (legal_entity_id, org_id, last_version, last_run_at, last_found, failing_since)
  values (p_entity, p_org, coalesce(p_version, 0), now(), coalesce(p_found, 0), now())
  on conflict (legal_entity_id) do update set last_version = greatest(fiscal.dfe_sync_state.last_version, coalesce(excluded.last_version, 0)),
    last_run_at = now(), last_found = coalesce(p_found, 0), failing_since = coalesce(fiscal.dfe_sync_state.failing_since, now())
  returning failing_since into v_since;
  v_late := v_since < now() - p_grace;
  if v_late then
    update fiscal.dfe_sync_state set last_error = left(p_error, 300) || ' (sem resposta normal da SEFAZ desde '
      || to_char(v_since at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') || ')'
    where legal_entity_id = p_entity;
  end if;
  insert into fiscal.dfe_sync_log (org_id, legal_entity_id, kind, message)
  values (p_org, p_entity, case when v_late then 'ERRO' else 'PASSAGEIRA' end, left(p_error, 500));
  return v_late;
end $$;

-- O 999 de hoje (07/11) passa a contar como falha passageira: sai da tela e entra no registro
insert into fiscal.dfe_sync_log (org_id, legal_entity_id, at, kind, message)
select org_id, legal_entity_id, coalesce(last_run_at, now()), 'PASSAGEIRA', last_error from fiscal.dfe_sync_state where last_error ~ '^(999|108|109|656)\M';
update fiscal.dfe_sync_state set failing_since = coalesce(failing_since, last_run_at), last_error = null where last_error ~ '^(999|108|109|656)\M';
