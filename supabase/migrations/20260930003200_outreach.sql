-- =====================================================================
-- Clientes › Prospecção assistida (substitui o scraping/"anti-ban" do legado — a API oficial não permite DM fria).
-- O sistema monta a lista do dia (leads com @ do Instagram, na cadência story → curtir → seguir → DM, com limite diário e intervalo entre passos),
-- a IA redige a abordagem e a vendedora executa PELO APP OFICIAL. Quando a DM sai pelo app, o eco do Instagram vincula o envio ao item sozinho.
-- Respeita a recusa (opt-out) e nunca volta a abordar antes do intervalo. Códigos de erro: P0170 dado inválido · P0171 situação · P0172 não encontrado.
-- =====================================================================

create index if not exists outreach_party_idx on crm.outreach_items (party_id, created_at desc);
create index if not exists outreach_assignee_idx on crm.outreach_items (assigned_member_id, due_on) where status in ('SUGGESTED', 'APPROVED');
alter table crm.outreach_items add column if not exists skip_reason text;
alter table crm.outreach_items add column if not exists done_at timestamptz;
alter table crm.outreach_items drop constraint if exists outreach_items_playbook_step_check;
alter table crm.outreach_items add constraint outreach_items_playbook_step_check check (playbook_step in ('STORY', 'LIKE', 'FOLLOW', 'DM'));
drop trigger if exists trg_updated_at on crm.outreach_items;
create trigger trg_updated_at before update on crm.outreach_items for each row execute function private.set_updated_at();

-- Passo seguinte da cadência
create or replace function private.outreach_next_step(p_step text) returns text
language sql immutable as $$ select case p_step when 'STORY' then 'LIKE' when 'LIKE' then 'FOLLOW' when 'FOLLOW' then 'DM' end $$;

-- ---------------------------------------------------------------------
-- 1) Lista do dia para quem chamou. Devolve quantos itens novos entraram.
-- Regras: lead/prospect com @ do Instagram, sem recusa de contato por Instagram, sem item pendente e sem abordagem concluída dentro do intervalo;
-- um passo por pessoa por dia; o primeiro passo é o story, os seguintes dependem do último passo feito há pelo menos 1 dia.
-- Configuração em core.settings 'outreach': {daily_limit (15), cooldown_days (30)}.
-- ---------------------------------------------------------------------
create or replace function crm.generate_outreach(p_limit integer default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := private.org_id(); v_me uuid := private.member_id(); v_today date := private.today_sp();
  v_cfg jsonb := coalesce((select value from core.settings where org_id = private.org_id() and key = 'outreach'), '{}');
  v_daily int := coalesce((v_cfg ->> 'daily_limit')::int, 15); v_cool int := coalesce((v_cfg ->> 'cooldown_days')::int, 30);
  v_have int; v_room int; v_n int := 0; r record; v_step text; v_ids uuid[] := '{}'; v_id uuid;
begin
  perform private.require_perm('crm.write');
  if v_me is null then raise exception 'Só membros da equipe geram a lista' using errcode = 'P0171'; end if;
  select count(*) into v_have from crm.outreach_items where assigned_member_id = v_me and due_on = v_today and status <> 'SKIPPED';
  v_room := least(coalesce(p_limit, v_daily), v_daily) - v_have;
  if v_room <= 0 then raise exception 'A meta do dia (%) já está na sua lista', v_daily using errcode = 'P0171'; end if;

  for r in
    select p.id as party_id, p.instagram_handle, last.playbook_step as last_step, last.status as last_status, last.done_at as last_done, last.created_at as last_created
    from crm.parties p
    left join lateral (select o.playbook_step, o.status, o.done_at, o.created_at from crm.outreach_items o where o.party_id = p.id and o.channel = 'INSTAGRAM' order by o.created_at desc limit 1) last on true
    where p.org_id = v_org and p.instagram_handle is not null and trim(p.instagram_handle) <> '' and p.merged_into_id is null and p.anonymized_at is null
      and p.lifecycle_stage in ('LEAD', 'PROSPECT')
      and not exists (select 1 from crm.v_current_consents c where c.party_id = p.id and c.purpose = 'MARKETING_IG' and c.granted = false)
      and (last.status is null or last.status in ('SENT_MANUALLY', 'SKIPPED'))
    order by p.lead_score desc, p.created_at
    limit 400
  loop
    if r.last_status is null then
      v_step := 'STORY';
    elsif r.last_status = 'SKIPPED' then
      continue when r.last_created > now() - make_interval(days => v_cool);   -- recusou/pulou: só volta depois do intervalo
      v_step := 'STORY';
    elsif r.last_step = 'DM' then
      continue when coalesce(r.last_done, r.last_created) > now() - make_interval(days => v_cool);
      v_step := 'STORY';
    else
      continue when coalesce(r.last_done, r.last_created)::date >= v_today;       -- um passo por dia
      v_step := private.outreach_next_step(r.last_step);
    end if;
    insert into crm.outreach_items (org_id, party_id, channel, playbook_step, assigned_member_id, due_on)
    values (v_org, r.party_id, 'INSTAGRAM', v_step, v_me, v_today) returning id into v_id;
    v_n := v_n + 1;
    if v_step = 'DM' then v_ids := v_ids || v_id; end if;
    exit when v_n >= v_room;
  end loop;
  if cardinality(v_ids) > 0 then
    perform private.enqueue('ai_tasks', jsonb_build_object('action', 'OUTREACH_DRAFT', 'org_id', v_org, 'item_ids', to_jsonb(v_ids)));
  end if;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- 2) Andamento: aprovar a mensagem, marcar como feito ou pular (com motivo). Pedido de parar vira recusa registrada.
-- ---------------------------------------------------------------------
create or replace function crm.set_outreach_status(p_id uuid, p_status text, p_note text default null) returns crm.outreach_items
language plpgsql security definer set search_path = '' as $$
declare o crm.outreach_items; v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  perform private.require_perm('crm.write');
  if p_status not in ('SUGGESTED', 'APPROVED', 'SENT_MANUALLY', 'SKIPPED') then raise exception 'Situação inválida' using errcode = 'P0170'; end if;
  select * into o from crm.outreach_items where id = p_id and org_id = private.org_id() for update;
  if o.id is null then raise exception 'Item não encontrado' using errcode = 'P0172'; end if;
  if o.status in ('SENT_MANUALLY', 'SKIPPED') and p_status <> o.status then raise exception 'Item já encerrado' using errcode = 'P0171'; end if;
  if p_status = 'SKIPPED' and v_note is null then raise exception 'Diga por que pulou (ex.: perfil privado, pediu para parar)' using errcode = 'P0170'; end if;
  update crm.outreach_items set status = p_status, skip_reason = case when p_status = 'SKIPPED' then v_note end,
         done_at = case when p_status in ('SENT_MANUALLY', 'SKIPPED') then now() end where id = o.id returning * into o;
  if p_status = 'SENT_MANUALLY' then
    perform private.timeline(o.org_id, o.party_id, 'OUTREACH_DONE', 'outreach', o.id, 'Prospecção: ' || case o.playbook_step when 'STORY' then 'viu e reagiu ao story' when 'LIKE' then 'curtiu fotos' when 'FOLLOW' then 'passou a seguir' else 'enviou a primeira DM' end);
  elsif p_status = 'SKIPPED' and v_note ~* '(parar|n[aã]o quer|sair|bloque)' then
    insert into crm.consents (org_id, party_id, purpose, granted, legal_basis, evidence, recorded_by)
    values (o.org_id, o.party_id, 'MARKETING_IG', false, 'CONSENT', jsonb_build_object('source', 'outreach', 'note', v_note), private.member_id());
  end if;
  return o;
end $$;

create or replace function crm.save_outreach_message(p_id uuid, p_message text) returns crm.outreach_items
language plpgsql security definer set search_path = '' as $$
declare o crm.outreach_items; v_msg text := trim(coalesce(p_message, ''));
begin
  perform private.require_perm('crm.write');
  if length(v_msg) not between 5 and 500 then raise exception 'A mensagem tem de 5 a 500 caracteres' using errcode = 'P0170'; end if;
  update crm.outreach_items set suggested_message = v_msg where id = p_id and org_id = private.org_id() and status in ('SUGGESTED', 'APPROVED') returning * into o;
  if o.id is null then raise exception 'Item não encontrado ou já encerrado' using errcode = 'P0172'; end if;
  return o;
end $$;

-- Worker: grava a mensagem redigida (só onde ainda não há texto)
create or replace function crm.outreach_set_draft(p_id uuid, p_message text) returns void
language sql security definer set search_path = '' as $$
  update crm.outreach_items set suggested_message = p_message where id = p_id and suggested_message is null and status = 'SUGGESTED'
$$;

-- ---------------------------------------------------------------------
-- 3) Vínculo automático: a DM enviada pelo app oficial chega como eco e fecha o item pendente da pessoa
-- ---------------------------------------------------------------------
create or replace function crm.link_outreach_echo() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_party uuid; v_item uuid;
begin
  if new.direction <> 'OUT' or new.author_type <> 'ECHO_FROM_APP' then return new; end if;
  select c.party_id into v_party from omni.conversations c join omni.channel_accounts ca on ca.id = c.channel_account_id where c.id = new.conversation_id and ca.channel = 'INSTAGRAM';
  if v_party is null then return new; end if;
  select id into v_item from crm.outreach_items where party_id = v_party and channel = 'INSTAGRAM' and playbook_step = 'DM' and status in ('SUGGESTED', 'APPROVED') order by due_on, created_at limit 1;
  if v_item is not null then
    update crm.outreach_items set status = 'SENT_MANUALLY', evidence_message_id = new.id, done_at = now() where id = v_item;
    perform private.timeline(new.org_id, v_party, 'OUTREACH_DONE', 'outreach', v_item, 'Prospecção: primeira DM enviada pelo app (vinculada pelo eco)');
  end if;
  return new;
end $$;
drop trigger if exists trg_outreach_echo on omni.messages;
create trigger trg_outreach_echo after insert on omni.messages for each row execute function crm.link_outreach_echo();

insert into private.internal_functions (fqname) values ('crm.outreach_set_draft'), ('crm.link_outreach_echo'), ('private.outreach_next_step') on conflict do nothing;
select private.lock_functions();
