-- =====================================================================
-- Atendimento › Templates (WhatsApp) e respostas rápidas.
-- Fora da janela de 24 h o WhatsApp só aceita template aprovado pela Meta. Aqui: rascunho → envio para aprovação (worker) → status por webhook,
-- e o envio de um template a uma conversa (com o consentimento exigido para marketing).
-- Códigos de erro: P0130 dado inválido · P0131 situação não permite · P0132 não encontrado · P0133 regra de envio (consentimento, aprovação, canal).
-- =====================================================================

do $$
begin
  perform pgmq.create('template_tasks');
  perform pgmq.create('template_tasks_dlq');
end $$;

alter table omni.templates add column if not exists external_id text;
alter table omni.templates add column if not exists rejection_reason text;
alter table omni.templates add column if not exists created_by uuid references core.members(id);
alter table omni.templates add column if not exists created_at timestamptz not null default now();
alter table omni.templates add column if not exists submitted_at timestamptz;
alter table omni.templates alter column status set default 'DRAFT';
alter table omni.templates drop constraint if exists templates_status_check;
alter table omni.templates add constraint templates_status_check check (status in ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'));
create index if not exists templates_external_idx on omni.templates (external_id) where external_id is not null;
drop trigger if exists trg_updated_at on omni.templates;
create trigger trg_updated_at before update on omni.templates for each row execute function private.set_updated_at();
drop trigger if exists trg_audit on omni.templates;
create trigger trg_audit after insert or update or delete on omni.templates for each row execute function private.audit_capture();

-- {{1}}, {{2}}… usados num texto (ordenados, sem repetir)
create or replace function private.template_placeholders(p_text text) returns int[]
language sql immutable as $$
  select coalesce(array_agg(n order by n), '{}')
  from (select distinct (m[1])::int as n from regexp_matches(coalesce(p_text, ''), '\{\{(\d+)\}\}', 'g') as m) x
$$;

-- ---------------------------------------------------------------------
-- 1) Criar/editar template (rascunho). Só WhatsApp; MARKETING ou UTILITY; nome em minúsculas com _ (regra da Meta).
-- p = {id?, channel_account_id, name, language?, category, body, header?, footer?, buttons?: [texto], examples?: [texto]}
-- ---------------------------------------------------------------------
create or replace function omni.save_template(p jsonb) returns omni.templates
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_id uuid := nullif(p ->> 'id', '')::uuid; v_acc uuid := nullif(p ->> 'channel_account_id', '')::uuid; t omni.templates;
  v_name text := lower(trim(coalesce(p ->> 'name', ''))); v_lang text := coalesce(nullif(trim(p ->> 'language'), ''), 'pt_BR'); v_cat text := upper(trim(coalesce(p ->> 'category', '')));
  v_body text := trim(coalesce(p ->> 'body', '')); v_header text := nullif(trim(coalesce(p ->> 'header', '')), ''); v_footer text := nullif(trim(coalesce(p ->> 'footer', '')), '');
  v_buttons jsonb := coalesce(p -> 'buttons', '[]'); v_examples jsonb := coalesce(p -> 'examples', '[]'); v_ph int[]; v_components jsonb; b jsonb; e jsonb;
begin
  perform private.require_perm('omni.write');
  if not exists (select 1 from omni.channel_accounts where id = v_acc and org_id = v_org and channel = 'WHATSAPP') then raise exception 'Escolha um canal de WhatsApp' using errcode = 'P0130'; end if;
  if v_name !~ '^[a-z][a-z0-9_]{0,99}$' then raise exception 'O nome do template usa só letras minúsculas, números e _ (ex.: pedido_pronto)' using errcode = 'P0130'; end if;
  if v_lang !~ '^[a-z]{2}(_[A-Z]{2})?$' then raise exception 'Idioma inválido' using errcode = 'P0130'; end if;
  if v_cat not in ('MARKETING', 'UTILITY') then raise exception 'Categoria deve ser MARKETING ou UTILITY' using errcode = 'P0130'; end if;
  if length(v_body) not between 1 and 1024 then raise exception 'O texto do template precisa ter de 1 a 1024 caracteres' using errcode = 'P0130'; end if;
  if length(coalesce(v_header, '')) > 60 or length(coalesce(v_footer, '')) > 60 then raise exception 'Cabeçalho e rodapé têm no máximo 60 caracteres' using errcode = 'P0130'; end if;
  if jsonb_typeof(v_buttons) <> 'array' or jsonb_array_length(v_buttons) > 3 then raise exception 'No máximo 3 botões de resposta rápida' using errcode = 'P0130'; end if;
  for b in select * from jsonb_array_elements(v_buttons) loop
    if jsonb_typeof(b) <> 'string' or length(trim(b #>> '{}')) not between 1 and 25 then raise exception 'Cada botão tem de 1 a 25 caracteres' using errcode = 'P0130'; end if;
  end loop;

  v_ph := private.template_placeholders(v_body);
  if coalesce(array_length(v_ph, 1), 0) > 0 and (v_ph[1] <> 1 or v_ph[array_length(v_ph, 1)] <> array_length(v_ph, 1)) then
    raise exception 'As variáveis precisam ser {{1}}, {{2}}… em sequência, sem pular número' using errcode = 'P0130';
  end if;
  if jsonb_typeof(v_examples) <> 'array' or jsonb_array_length(v_examples) <> coalesce(array_length(v_ph, 1), 0) then
    raise exception 'Informe um exemplo para cada variável (a Meta exige para aprovar)' using errcode = 'P0130';
  end if;
  for e in select * from jsonb_array_elements(v_examples) loop
    if jsonb_typeof(e) <> 'string' or length(trim(e #>> '{}')) = 0 then raise exception 'Exemplo de variável em branco' using errcode = 'P0130'; end if;
  end loop;
  if left(v_body, 2) = '{{' or right(v_body, 2) = '}}' then raise exception 'O texto não pode começar nem terminar com uma variável' using errcode = 'P0130'; end if;

  v_components := (case when v_header is not null then jsonb_build_array(jsonb_build_object('type', 'HEADER', 'format', 'TEXT', 'text', v_header)) else '[]'::jsonb end)
    || jsonb_build_array(case when array_length(v_ph, 1) is null then jsonb_build_object('type', 'BODY', 'text', v_body)
                              else jsonb_build_object('type', 'BODY', 'text', v_body, 'example', jsonb_build_object('body_text', jsonb_build_array(v_examples))) end)
    || (case when v_footer is not null then jsonb_build_array(jsonb_build_object('type', 'FOOTER', 'text', v_footer)) else '[]'::jsonb end)
    || (case when jsonb_array_length(v_buttons) > 0 then jsonb_build_array(jsonb_build_object('type', 'BUTTONS',
          'buttons', (select jsonb_agg(jsonb_build_object('type', 'QUICK_REPLY', 'text', trim(x #>> '{}'))) from jsonb_array_elements(v_buttons) x))) else '[]'::jsonb end);

  if v_id is null then
    insert into omni.templates (org_id, channel_account_id, name, language, category, components, status, created_by)
    values (v_org, v_acc, v_name, v_lang, v_cat, v_components, 'DRAFT', private.member_id()) returning * into t;
  else
    select * into t from omni.templates where id = v_id and org_id = v_org;
    if t.id is null then raise exception 'Template não encontrado' using errcode = 'P0132'; end if;
    if t.status not in ('DRAFT', 'REJECTED') then raise exception 'Só rascunho ou template rejeitado pode ser editado (para mudar um aprovado, crie outro nome)' using errcode = 'P0131'; end if;
    update omni.templates set channel_account_id = v_acc, name = v_name, language = v_lang, category = v_cat, components = v_components, status = 'DRAFT', rejection_reason = null
    where id = v_id returning * into t;
  end if;
  return t;
exception when unique_violation then
  raise exception 'Já existe um template com esse nome e idioma neste canal' using errcode = 'P0130';
end $$;

-- ---------------------------------------------------------------------
-- 2) Enviar para aprovação / sincronizar com a Meta (quem fala com a Meta é o worker)
-- ---------------------------------------------------------------------
create or replace function omni.submit_template(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t omni.templates;
begin
  perform private.require_perm('omni.write');
  select * into t from omni.templates where id = p_id and org_id = private.org_id();
  if t.id is null then raise exception 'Template não encontrado' using errcode = 'P0132'; end if;
  if t.status not in ('DRAFT', 'REJECTED') then raise exception 'Este template já foi enviado (situação: %)', t.status using errcode = 'P0131'; end if;
  update omni.templates set status = 'PENDING', submitted_at = now(), rejection_reason = null where id = t.id;
  perform private.enqueue('template_tasks', jsonb_build_object('action', 'SUBMIT', 'template_id', t.id, 'org_id', t.org_id));
end $$;

create or replace function omni.request_template_sync(p_account uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('omni.write');
  if not exists (select 1 from omni.channel_accounts where id = p_account and org_id = private.org_id() and channel = 'WHATSAPP') then raise exception 'Canal de WhatsApp não encontrado' using errcode = 'P0132'; end if;
  perform private.enqueue('template_tasks', jsonb_build_object('action', 'SYNC', 'channel_account_id', p_account, 'org_id', private.org_id()));
end $$;

create or replace function omni.delete_template(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t omni.templates;
begin
  perform private.require_perm('omni.write');
  select * into t from omni.templates where id = p_id and org_id = private.org_id();
  if t.id is null then raise exception 'Template não encontrado' using errcode = 'P0132'; end if;
  if t.status not in ('DRAFT', 'REJECTED') then raise exception 'Só rascunho ou template rejeitado pode ser excluído' using errcode = 'P0131'; end if;
  delete from omni.templates where id = t.id;
end $$;

-- ---------------------------------------------------------------------
-- 3) Situação vinda da Meta (resposta do envio, webhook ou sincronização) — interna
-- p = {template_id? | external_id? | (waba_id?, name, language)}, status, reason?, quality?, external_id?
-- ---------------------------------------------------------------------
create or replace function omni.record_template_status(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t omni.templates; v_status text := upper(coalesce(p ->> 'status', '')); v_map text;
begin
  v_map := case v_status when 'APPROVED' then 'APPROVED' when 'REJECTED' then 'REJECTED' when 'PENDING' then 'PENDING' when 'IN_APPEAL' then 'PENDING' when 'PAUSED' then 'PAUSED'
                         when 'DISABLED' then 'DISABLED' when 'PENDING_DELETION' then 'DISABLED' when 'DELETED' then 'DISABLED' when 'FLAGGED' then 'PAUSED' else null end;
  if v_map is null and nullif(p ->> 'quality', '') is null then return null; end if;          -- sem situação válida nem qualidade: nada a registrar
  if nullif(p ->> 'template_id', '') is not null then
    select * into t from omni.templates where id = (p ->> 'template_id')::uuid;
  elsif nullif(p ->> 'external_id', '') is not null then
    select * into t from omni.templates where external_id = p ->> 'external_id' limit 1;
  end if;
  if t.id is null and nullif(p ->> 'name', '') is not null then
    select x.* into t from omni.templates x join omni.channel_accounts ca on ca.id = x.channel_account_id left join core.integration_connections ic on ic.id = ca.connection_id
    where x.name = p ->> 'name' and x.language = coalesce(nullif(p ->> 'language', ''), x.language)
      and (nullif(p ->> 'waba_id', '') is null or ic.config ->> 'waba_id' = p ->> 'waba_id') order by x.created_at desc limit 1;
  end if;
  if t.id is null then return null; end if;
  update omni.templates set status = coalesce(v_map, status), external_id = coalesce(nullif(p ->> 'external_id', ''), external_id),
         rejection_reason = case when v_map is null then rejection_reason when v_map in ('REJECTED', 'PAUSED', 'DISABLED') then coalesce(nullif(p ->> 'reason', ''), rejection_reason) else null end,
         quality = coalesce(nullif(p ->> 'quality', ''), quality)
  where id = t.id;
  if v_map in ('REJECTED', 'PAUSED', 'DISABLED') and t.status is distinct from v_map then
    perform core.notify(t.org_id, 'TEMPLATE_STATUS', 'Template ' || t.name || ': ' || case v_map when 'REJECTED' then 'rejeitado pela Meta' when 'PAUSED' then 'pausado pela Meta' else 'desativado' end
                        || coalesce(' — ' || nullif(p ->> 'reason', ''), ''), jsonb_build_object('template_id', t.id), 'omni.write');
  end if;
  return t.id;
end $$;

-- Não foi possível enviar à Meta (credencial ou WABA ausentes…): volta a rascunho, com o motivo à vista
create or replace function omni.fail_template_submission(p_id uuid, p_reason text) returns void
language sql security definer set search_path = '' as $$
  update omni.templates set status = 'DRAFT', rejection_reason = left(p_reason, 500) where id = p_id and status = 'PENDING' and external_id is null;
$$;

-- Template que já existe na Meta e ainda não temos (sincronização)
create or replace function omni.upsert_remote_template(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare ca omni.channel_accounts; t omni.templates;
begin
  select * into ca from omni.channel_accounts where id = (p ->> 'channel_account_id')::uuid;
  if ca.id is null then return null; end if;
  insert into omni.templates (org_id, channel_account_id, name, language, category, components, status, external_id, quality)
  values (ca.org_id, ca.id, p ->> 'name', coalesce(p ->> 'language', 'pt_BR'), coalesce(nullif(upper(p ->> 'category'), ''), 'UTILITY'), coalesce(p -> 'components', '[]'), 'PENDING', p ->> 'external_id', p ->> 'quality')
  on conflict (channel_account_id, name, language) do update set category = excluded.category, components = excluded.components, external_id = excluded.external_id, quality = coalesce(excluded.quality, omni.templates.quality)
  returning * into t;
  perform omni.record_template_status(jsonb_build_object('template_id', t.id, 'status', p ->> 'status', 'reason', p ->> 'rejected_reason', 'quality', p ->> 'quality'));
  return t.id;
end $$;

-- ---------------------------------------------------------------------
-- 4) Enviar um template a uma conversa. p_params = valores de {{1}}, {{2}}… (texto).
-- Marketing exige consentimento de marketing no WhatsApp; utilidade vale sempre. O texto renderizado aparece na conversa.
-- ---------------------------------------------------------------------
create or replace function omni.send_template(p_conversation uuid, p_template uuid, p_params jsonb default '[]') returns omni.messages
language plpgsql security definer set search_path = '' as $$
declare
  c omni.conversations; t omni.templates; ca omni.channel_accounts; m omni.messages; v_body text; v_ph int[]; v_params jsonb := coalesce(p_params, '[]'); i int; v_val text; v_granted boolean;
begin
  perform private.require_perm('omni.write');
  select * into c from omni.conversations where id = p_conversation and org_id = private.org_id();
  if c.id is null then raise exception 'Conversa não encontrada' using errcode = 'P0132'; end if;
  select * into ca from omni.channel_accounts where id = c.channel_account_id;
  select * into t from omni.templates where id = p_template and org_id = c.org_id;
  if t.id is null then raise exception 'Template não encontrado' using errcode = 'P0132'; end if;
  if ca.channel <> 'WHATSAPP' then raise exception 'Templates são só do WhatsApp' using errcode = 'P0133'; end if;
  if t.channel_account_id <> ca.id then raise exception 'Este template pertence a outro número de WhatsApp' using errcode = 'P0133'; end if;
  if t.status <> 'APPROVED' then raise exception 'O template ainda não foi aprovado pela Meta (situação: %)', t.status using errcode = 'P0133'; end if;
  if t.category = 'MARKETING' then
    select granted into v_granted from crm.v_current_consents where party_id = c.party_id and purpose = 'MARKETING_WHATSAPP';
    if not coalesce(v_granted, false) then raise exception 'A cliente não deu consentimento para receber marketing no WhatsApp' using errcode = 'P0133'; end if;
  end if;
  select c2 ->> 'text' into v_body from jsonb_array_elements(t.components) c2 where c2 ->> 'type' = 'BODY' limit 1;
  v_ph := private.template_placeholders(v_body);
  if jsonb_typeof(v_params) <> 'array' or jsonb_array_length(v_params) <> coalesce(array_length(v_ph, 1), 0) then raise exception 'Preencha as % variável(is) do template', coalesce(array_length(v_ph, 1), 0) using errcode = 'P0130'; end if;
  for i in 1..coalesce(array_length(v_ph, 1), 0) loop
    v_val := trim(v_params ->> (i - 1));
    if v_val is null or v_val = '' or v_val ~ '[\r\n\t]' or length(v_val) > 200 then raise exception 'Valor inválido na variável {{%}} (sem quebra de linha, até 200 caracteres)', i using errcode = 'P0130'; end if;
    v_body := replace(v_body, '{{' || i || '}}', v_val);
  end loop;

  insert into omni.messages (org_id, conversation_id, channel_account_id, direction, author_type, author_member_id, type, body, template_name, status, client_dedupe_key, payload)
  values (c.org_id, c.id, c.channel_account_id, 'OUT', 'HUMAN', private.member_id(), 'TEMPLATE', v_body, t.name, 'QUEUED', gen_random_uuid()::text,
          jsonb_build_object('language', t.language, 'template_id', t.id,
            'components', case when coalesce(array_length(v_ph, 1), 0) = 0 then '[]'::jsonb
                               else jsonb_build_array(jsonb_build_object('type', 'body', 'parameters', (select jsonb_agg(jsonb_build_object('type', 'text', 'text', x #>> '{}')) from jsonb_array_elements(v_params) x))) end))
  returning * into m;
  perform private.enqueue('outbound_messages', jsonb_build_object('message_id', m.id, 'org_id', c.org_id));
  return m;
end $$;

-- ---------------------------------------------------------------------
-- 5) Respostas rápidas (atalho "/obrigada" → texto pronto)
-- ---------------------------------------------------------------------
create or replace function omni.save_quick_reply(p_shortcut text, p_body text, p_id uuid default null) returns omni.quick_replies
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.org_id(); v_short text := lower(trim(coalesce(p_shortcut, ''))); q omni.quick_replies;
begin
  perform private.require_perm('omni.write');
  v_short := regexp_replace(v_short, '^/+', '');
  if v_short !~ '^[a-z0-9_-]{2,30}$' then raise exception 'O atalho usa 2 a 30 letras minúsculas, números, - ou _' using errcode = 'P0130'; end if;
  if length(trim(coalesce(p_body, ''))) not between 1 and 1000 then raise exception 'O texto da resposta precisa ter de 1 a 1000 caracteres' using errcode = 'P0130'; end if;
  if p_id is null then
    insert into omni.quick_replies (org_id, shortcut, body) values (v_org, v_short, trim(p_body)) returning * into q;
  else
    update omni.quick_replies set shortcut = v_short, body = trim(p_body) where id = p_id and org_id = v_org returning * into q;
    if q.id is null then raise exception 'Resposta não encontrada' using errcode = 'P0132'; end if;
  end if;
  return q;
exception when unique_violation then
  raise exception 'Já existe uma resposta rápida com o atalho /%', v_short using errcode = 'P0130';
end $$;

create or replace function omni.delete_quick_reply(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_perm('omni.write');
  delete from omni.quick_replies where id = p_id and org_id = private.org_id();
end $$;

insert into private.internal_functions (fqname) values ('omni.record_template_status'), ('omni.upsert_remote_template'), ('omni.fail_template_submission'), ('private.template_placeholders') on conflict do nothing;
select private.lock_functions();
