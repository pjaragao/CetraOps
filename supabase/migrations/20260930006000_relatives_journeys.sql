-- =====================================================================
-- Réguas por vínculo: aniversário de parente e datas comemorativas (Dia das Mães, Dia dos Pais, Dia dos Namorados, Natal, Dia da Mulher).
-- A cliente com parente cadastrado recebe, ANTES da data, uma tarefa (ou mensagem, dentro das regras de contato) para oferecer presente.
--   RELATED_BIRTHDAY: N dias antes do aniversário de um parente cadastrado (config: days_before, roles[]).
--   OCCASION: N dias antes da data (config: occasion, days_before, roles[]), uma vez por ano por cliente.
-- Variáveis novas no texto: {parente} (mãe, filha, esposa…), {nome_parente} (primeiro nome) e {data_parente} (aniversário, dd/mm).
-- Tudo respeita aceite, recusa, limites e horário de silêncio das réguas. Nasce desligado.
-- =====================================================================

alter table mkt.journeys drop constraint if exists journeys_trigger_check;
alter table mkt.journeys add constraint journeys_trigger_check check (trigger in
  ('FIRST_PURCHASE', 'ANY_PURCHASE', 'NO_SECOND_PURCHASE', 'BIRTHDAY', 'AT_RISK', 'INACTIVE', 'LONG_INACTIVE', 'DEAL_LOST', 'RELATED_BIRTHDAY', 'OCCASION'));

-- Data da ocasião no ano
create or replace function private.occasion_date(p_code text, p_year int) returns date
language plpgsql immutable as $$
declare d date;
begin
  case p_code
    when 'WOMENS_DAY' then return make_date(p_year, 3, 8);
    when 'VALENTINES' then return make_date(p_year, 6, 12);
    when 'CHRISTMAS' then return make_date(p_year, 12, 25);
    when 'MOTHERS_DAY' then d := make_date(p_year, 5, 1);                       -- 2º domingo de maio
    when 'FATHERS_DAY' then d := make_date(p_year, 8, 1);                       -- 2º domingo de agosto
    else return null;
  end case;
  d := d + ((7 - extract(dow from d)::int) % 7);                                -- 1º domingo
  return d + 7;
end $$;

-- Rótulo do parente (o que ELE é para a cliente), pelo gênero
create or replace function private.relative_label(p_role text, p_gender text) returns text
language sql immutable as $$
  select case p_role
    when 'PARENT' then case p_gender when 'F' then 'mãe' when 'M' then 'pai' else 'mãe ou pai' end
    when 'CHILD' then case p_gender when 'F' then 'filha' when 'M' then 'filho' else 'filho(a)' end
    when 'SPOUSE' then case p_gender when 'F' then 'esposa' when 'M' then 'marido' else 'cônjuge' end
    when 'PARTNER' then case p_gender when 'F' then 'companheira' when 'M' then 'companheiro' else 'parceiro(a)' end
    when 'SIBLING' then case p_gender when 'F' then 'irmã' when 'M' then 'irmão' else 'irmão(ã)' end
    when 'GRANDPARENT' then case p_gender when 'F' then 'avó' when 'M' then 'avô' else 'avô(ó)' end
    when 'GRANDCHILD' then case p_gender when 'F' then 'neta' when 'M' then 'neto' else 'neto(a)' end
    when 'AUNT_UNCLE' then case p_gender when 'F' then 'tia' when 'M' then 'tio' else 'tio(a)' end
    when 'NIECE_NEPHEW' then case p_gender when 'F' then 'sobrinha' when 'M' then 'sobrinho' else 'sobrinho(a)' end
    when 'FRIEND' then case p_gender when 'F' then 'amiga' when 'M' then 'amigo' else 'amigo(a)' end
    else 'pessoa próxima' end
$$;

create or replace function private.related_of(p_source_key text) returns uuid
language sql immutable as $$
  select case when p_source_key ~ '^rel:[0-9a-f-]{36}:' then split_part(p_source_key, ':', 2)::uuid end
$$;

-- Texto com os dados da pessoa e, se houver, do parente da régua
create or replace function private.render_party_text(p_party uuid, p_text text, p_related uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_txt text := private.render_party_text(p_party, p_text); rel record;
begin
  if p_related is null then return v_txt; end if;
  select p.display_name, p.birth_date, p.gender, (select v.role from crm.v_relatives v where v.party_id = p_party and v.relative_id = p_related limit 1) as role
  into rel from crm.parties p where p.id = p_related;
  return replace(replace(replace(v_txt, '{parente}', private.relative_label(rel.role, rel.gender)), '{nome_parente}', split_part(coalesce(rel.display_name, ''), ' ', 1)),
                 '{data_parente}', coalesce(to_char(rel.birth_date, 'DD/MM'), 'em breve'));
end $$;

-- Quem entra nas réguas de vínculo hoje
create or replace function private.journey_enroll_relations(j mkt.journeys) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record; n int := 0; v_days int := coalesce((j.trigger_config ->> 'days_before')::int, case j.trigger when 'OCCASION' then 14 else 7 end); v_grp text; v_wait numeric;
  v_today date := private.today_sp(); v_occ date; v_code text := coalesce(j.trigger_config ->> 'occasion', ''); v_roles text[]; v_gender text; v_year int := extract(year from private.today_sp())::int;
begin
  if j.trigger not in ('RELATED_BIRTHDAY', 'OCCASION') then return 0; end if;
  select coalesce(wait_days, 0) into v_wait from mkt.journey_steps where journey_id = j.id order by position limit 1;
  v_roles := coalesce(array(select jsonb_array_elements_text(j.trigger_config -> 'roles')), '{}');

  if j.trigger = 'OCCASION' then
    v_occ := private.occasion_date(v_code, v_year);
    if v_occ is null or v_today > v_occ - 1 or v_today < v_occ - v_days then return 0; end if;
    if cardinality(v_roles) = 0 then
      v_roles := case v_code when 'MOTHERS_DAY' then array['PARENT'] when 'FATHERS_DAY' then array['PARENT'] when 'VALENTINES' then array['SPOUSE', 'PARTNER']
                             when 'WOMENS_DAY' then array['PARENT', 'SPOUSE', 'PARTNER', 'SIBLING', 'CHILD']
                             else array['SPOUSE', 'PARTNER', 'PARENT', 'CHILD', 'SIBLING', 'GRANDPARENT', 'GRANDCHILD'] end;
    end if;
    v_gender := case v_code when 'MOTHERS_DAY' then 'F' when 'FATHERS_DAY' then 'M' when 'WOMENS_DAY' then 'F' end;
  end if;

  for r in
    select distinct on (v.party_id) v.party_id, v.relative_id
    from crm.v_relatives v join crm.parties p on p.id = v.party_id join crm.parties rel on rel.id = v.relative_id
    where v.org_id = j.org_id and p.merged_into_id is null and p.anonymized_at is null and rel.merged_into_id is null and rel.anonymized_at is null
      and not exists (select 1 from crm.party_roles rl where rl.party_id = p.id and rl.role in ('EMPLOYEE', 'SUPPLIER', 'SERVICE_PROVIDER', 'CARRIER', 'ACQUIRER', 'BANK'))
      and (cardinality(v_roles) = 0 or v.role = any (v_roles))
      and ((j.trigger = 'OCCASION' and (v_gender is null or rel.gender = v_gender)
            and not exists (select 1 from mkt.journey_enrollments e where e.journey_id = j.id and e.party_id = v.party_id and e.source_key like 'rel:%:' || v_year))
        or (j.trigger = 'RELATED_BIRTHDAY' and rel.birth_date is not null
            and to_char(rel.birth_date, 'MM-DD') = to_char(v_today + v_days, 'MM-DD')
            and not exists (select 1 from mkt.journey_enrollments e where e.journey_id = j.id and e.party_id = v.party_id and e.source_key = 'rel:' || v.relative_id || ':' || v_year)))
    order by v.party_id, array_position(array['SPOUSE', 'PARTNER', 'PARENT', 'CHILD', 'SIBLING', 'GRANDPARENT', 'GRANDCHILD', 'AUNT_UNCLE', 'NIECE_NEPHEW', 'FRIEND'], v.role)
    limit 500
  loop
    v_grp := case when random() * 100 < j.holdout_pct then 'HOLDOUT' else 'TREATMENT' end;
    insert into mkt.journey_enrollments (org_id, journey_id, party_id, source_key, grp, next_run_at)
    values (j.org_id, j.id, r.party_id, 'rel:' || r.relative_id || ':' || v_year, v_grp, now() + make_interval(secs => (coalesce(v_wait, 0) * 86400)::int))
    on conflict do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- run_journeys e save_journey passam a conhecer os gatilhos novos e as variáveis do parente
do $$
declare v_def text;
begin
  select pg_get_functiondef('private.run_journeys()'::regprocedure) into v_def;
  if position('v_enrolled := v_enrolled + private.journey_enroll(j);' in v_def) = 0 or position('private.render_party_text(e.party_id, s.message)' in v_def) = 0 or position('private.render_party_text(e.party_id, s.title)' in v_def) = 0 then
    raise exception 'run_journeys mudou: ajuste este patch';
  end if;
  v_def := replace(v_def, 'v_enrolled := v_enrolled + private.journey_enroll(j);', 'v_enrolled := v_enrolled + private.journey_enroll(j) + private.journey_enroll_relations(j);');
  v_def := replace(v_def, 'private.render_party_text(e.party_id, s.message)', 'private.render_party_text(e.party_id, s.message, private.related_of(e.source_key))');
  v_def := replace(v_def, 'private.render_party_text(e.party_id, s.title)', 'private.render_party_text(e.party_id, s.title, private.related_of(e.source_key))');
  execute v_def;

  select pg_get_functiondef('mkt.save_journey(jsonb)'::regprocedure) into v_def;
  if position('''DEAL_LOST'') then raise exception ''Gatilho inválido''' in v_def) = 0 or position('if v_trig = ''NO_SECOND_PURCHASE'' and' in v_def) = 0 then raise exception 'save_journey mudou: ajuste este patch'; end if;
  v_def := replace(v_def, '''DEAL_LOST'') then raise exception ''Gatilho inválido''', '''DEAL_LOST'', ''RELATED_BIRTHDAY'', ''OCCASION'') then raise exception ''Gatilho inválido''');
  v_def := replace(v_def, 'if v_trig = ''NO_SECOND_PURCHASE'' and',
    'if v_trig = ''OCCASION'' and private.occasion_date(coalesce(v_cfg ->> ''occasion'', ''''), 2030) is null then raise exception ''Escolha a data: Dia das Mães, Dia dos Pais, Dia dos Namorados, Natal ou Dia da Mulher'' using errcode = ''P0350''; end if;' || chr(10) ||
    '  if v_trig in (''OCCASION'', ''RELATED_BIRTHDAY'') and coalesce((v_cfg ->> ''days_before'')::int, 7) not between 1 and 60 then raise exception ''Avisar de 1 a 60 dias antes'' using errcode = ''P0350''; end if;' || chr(10) ||
    '  if v_trig = ''NO_SECOND_PURCHASE'' and');
  execute v_def;
end $$;

-- Réguas padrão por vínculo (desligadas)
create or replace function private.seed_occasion_journeys(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  insert into mkt.journeys (org_id, key, name, description, trigger, trigger_config, exit_on_purchase) values
    (p_org, 'aniversario-parente', 'Aniversário de parente', 'Sete dias antes do aniversário de alguém da família cadastrada: sugerir presente.', 'RELATED_BIRTHDAY', '{"days_before": 7}', true)
  on conflict (org_id, key) do nothing returning id into v;
  if v is not null then
    insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message, due_hours) values
      (p_org, v, 1, 0, 'TASK', 'Aniversário de {nome_parente} ({parente} de {nome}): presente?', 'Oi, {nome}! O aniversário da sua {parente}, {nome_parente}, é dia {data_parente}. Quer que eu separe algo especial da SIÉ para presentear? Posso embalar com carinho. 💛', 72);
  end if;
  v := null;
  insert into mkt.journeys (org_id, key, name, description, trigger, trigger_config, exit_on_purchase) values
    (p_org, 'dia-das-maes', 'Dia das Mães', 'Duas semanas antes: presente para a mãe de quem tem a mãe cadastrada.', 'OCCASION', '{"occasion": "MOTHERS_DAY", "days_before": 14}', true)
  on conflict (org_id, key) do nothing returning id into v;
  if v is not null then
    insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message, due_hours) values
      (p_org, v, 1, 0, 'TASK', 'Dia das Mães: presente para a mãe de {nome}', 'Oi, {nome}! O Dia das Mães está chegando. Posso te mostrar opções para presentear sua mãe? Separo no tamanho dela e embalo para presente. 💛', 72);
  end if;
  v := null;
  insert into mkt.journeys (org_id, key, name, description, trigger, trigger_config, exit_on_purchase) values
    (p_org, 'dia-dos-pais', 'Dia dos Pais', 'Duas semanas antes: presente para o pai.', 'OCCASION', '{"occasion": "FATHERS_DAY", "days_before": 14}', true)
  on conflict (org_id, key) do nothing returning id into v;
  if v is not null then
    insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message, due_hours) values
      (p_org, v, 1, 0, 'TASK', 'Dia dos Pais: presente para o pai de {nome}', 'Oi, {nome}! O Dia dos Pais está chegando. Quer ver opções para presentear seu pai? Tenho linha masculina e embalo para presente.', 72);
  end if;
  v := null;
  insert into mkt.journeys (org_id, key, name, description, trigger, trigger_config, exit_on_purchase) values
    (p_org, 'dia-dos-namorados', 'Dia dos Namorados', 'Dez dias antes: presente para quem tem cônjuge ou companheira(o) cadastrado.', 'OCCASION', '{"occasion": "VALENTINES", "days_before": 10}', true)
  on conflict (org_id, key) do nothing returning id into v;
  if v is not null then
    insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message, due_hours) values
      (p_org, v, 1, 0, 'TASK', 'Dia dos Namorados: presente para {nome}', 'Oi, {nome}! O Dia dos Namorados está chegando. Quer ideias de presente para sua {parente}? Posso separar e embalar.', 72);
  end if;
  v := null;
  insert into mkt.journeys (org_id, key, name, description, trigger, trigger_config, exit_on_purchase) values
    (p_org, 'natal-presentes', 'Natal: presentes para a família', 'Três semanas antes: presentes para quem tem família cadastrada.', 'OCCASION', '{"occasion": "CHRISTMAS", "days_before": 21}', true)
  on conflict (org_id, key) do nothing returning id into v;
  if v is not null then
    insert into mkt.journey_steps (org_id, journey_id, position, wait_days, action, title, message, due_hours) values
      (p_org, v, 1, 0, 'TASK', 'Natal: presentes para a família de {nome}', 'Oi, {nome}! O Natal está chegando. Quer que eu monte uma seleção de presentes para a família? Posso separar no armário e deixar pronto para você buscar.', 72);
  end if;
end $$;

create or replace function private.seed_journeys_on_org() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.seed_default_journeys(new.id);
  perform private.seed_occasion_journeys(new.id);
  return null;
end $$;
select private.seed_occasion_journeys(id) from core.orgs;

insert into private.internal_functions (fqname) values
  ('private.journey_enroll_relations'), ('private.seed_occasion_journeys')
on conflict do nothing;
select private.lock_functions();
