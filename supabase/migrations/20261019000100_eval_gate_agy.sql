-- Atendimento ao cliente com os modelos do AGY (Hermes do CentralOps, `hermes/agy` e `hermes/agy/<id>`) sem passar pelo portão de
-- avaliação: decisão dos sócios em 19/10/2026. Os outros modelos continuam exigindo avaliação recente.
-- Configurável sem deploy em core.settings 'ai_eval_gate' -> 'exempt_prefixes' (padrão ["hermes/agy"]; [] volta a exigir de todos).
-- O resultado diz 'exempt': true para a tela de Avaliações mostrar que o modelo está liberado por exceção, não por nota.

create or replace function private.eval_gate(p_org uuid, p_task text, p_model text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s jsonb; b ai.eval_batches; v_min_cases int; v_min_rate numeric; v_max_fact int; v_days int; v_prefix text;
begin
  select value into s from core.settings where org_id = p_org and key = 'ai_eval_gate';
  s := coalesce(s, '{}');
  for v_prefix in select jsonb_array_elements_text(coalesce(s -> 'exempt_prefixes', '["hermes/agy"]'::jsonb)) loop
    if v_prefix <> '' and left(p_model, length(v_prefix)) = v_prefix then
      return jsonb_build_object('ok', true, 'exempt', true, 'reason', format('liberado sem avaliação (modelos %s*)', v_prefix));
    end if;
  end loop;
  v_min_cases := coalesce((s ->> 'min_cases')::int, 8); v_min_rate := coalesce((s ->> 'min_pass_rate')::numeric, 0.9);
  v_max_fact := coalesce((s ->> 'max_factual_failures')::int, 0); v_days := coalesce((s ->> 'max_age_days')::int, 30);
  select * into b from ai.eval_batches where org_id = p_org and route_task = p_task and model = p_model and created_at > now() - make_interval(days => v_days) order by created_at desc limit 1;
  if b.id is null then return jsonb_build_object('ok', false, 'reason', format('rode a avaliação com este modelo (vale por %s dias)', v_days)); end if;
  if b.cases < v_min_cases then return jsonb_build_object('ok', false, 'reason', format('a última avaliação teve só %s casos (mínimo %s)', b.cases, v_min_cases), 'batch_id', b.id); end if;
  if b.factual_failures > v_max_fact then return jsonb_build_object('ok', false, 'reason', format('%s resposta(s) com número ou promessa sem fundamento (o limite é %s)', b.factual_failures, v_max_fact), 'batch_id', b.id); end if;
  if b.passed::numeric / b.cases < v_min_rate then return jsonb_build_object('ok', false, 'reason', format('passou em %s de %s casos (mínimo %s%%)', b.passed, b.cases, round(v_min_rate * 100)), 'batch_id', b.id); end if;
  return jsonb_build_object('ok', true, 'batch_id', b.id);
end $$;

select private.lock_functions();
