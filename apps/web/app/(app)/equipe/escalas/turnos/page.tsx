import Link from "next/link";
import { fmtHours, netMinutes } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { deleteCoverageAction, deleteShiftAction, saveCoverageAction, saveScheduleRulesAction, setCoverageActiveAction, toggleShiftAction } from "../../actions";
import { ShiftForm } from "./shift-form";

export const metadata = { title: "Turnos, picos e regras" };

const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const hm = (t: string) => t.slice(0, 5);

interface Rules {
  rest_11h: boolean; consecutive_days: boolean; max_consecutive_days: number; daily_max: boolean; daily_warn_minutes: number; daily_error_minutes: number;
  break_rule: boolean; min_break_minutes: number; break_over_minutes: number; short_break_minutes: number; short_break_over_minutes: number; weekly_hours: boolean; coverage: boolean;
}

export default async function TurnosPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("hr.read");
  const sp = await searchParams;
  const canEdit = can(session, "hr.write");
  const store = str(sp.loja) ?? session.storeId ?? session.stores[0]?.id;
  const supabase = await createClient();
  const [{ data: shifts }, { data: rules }, { data: rulesData }] = await Promise.all([
    supabase.schema("hr").from("shift_templates").select("id, code, name, start_time, end_time, break_minutes, color, active, store_id").order("active", { ascending: false }).order("start_time"),
    store ? supabase.schema("hr").from("coverage_rules").select("id, weekday, label, start_time, end_time, min_staff, active").eq("store_id", store).order("weekday").order("start_time")
      : Promise.resolve({ data: [] as { id: string; weekday: number; label: string; start_time: string; end_time: string; min_staff: number; active: boolean }[] }),
    supabase.schema("hr").rpc("schedule_rules"),
  ]);
  const r = rulesData as unknown as Rules;
  const editing = (shifts ?? []).find((s) => s.id === str(sp.editar));
  const editingRule = (rules ?? []).find((x) => x.id === str(sp.janela));
  const back = `/equipe/escalas/turnos${store ? `?loja=${store}` : ""}`;
  const storeName = new Map(session.stores.map((s) => [s.id, s.name]));
  const hoursVal = (min: number) => String(min / 60).replace(".", ",");

  return (
    <>
      <PageHeader title="Turnos, picos e regras" description="Regras de conferência da escala (cada uma liga e desliga), turnos prontos e os horários de pico da loja. Na grade dá para lançar qualquer horário num dia; o total de horas aparece em tudo o que você edita."
        actions={<div className="flex gap-2"><Link href={`/equipe/escalas/padrao${store ? `?loja=${store}` : ""}`} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2">Escala semanal padrão</Link><Link href={`/equipe/escalas${store ? `?loja=${store}` : ""}`} className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Escala</Link></div>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      <Card title="Regras de conferência da escala">
        <form action={saveScheduleRulesAction} className="space-y-3">
          <input type="hidden" name="back" value={back} />
          <div className="grid gap-3 lg:grid-cols-2">
            <fieldset className="space-y-1 rounded-lg border border-border p-3 text-sm" disabled={!canEdit}>
              <legend className="px-1 text-xs font-medium text-muted">Intervalo para refeição</legend>
              <label className="flex items-center gap-2"><input type="checkbox" name="break_rule" defaultChecked={r.break_rule} /> Conferir o intervalo mínimo (turnos e horários livres)</label>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Mínimo (min)"><input name="min_break_minutes" type="number" min={0} max={240} defaultValue={r.min_break_minutes} className={inputClass} /></Field>
                <Field label="Vale para jornada acima de (h)"><input name="break_over_minutes" inputMode="decimal" defaultValue={hoursVal(r.break_over_minutes)} className={inputClass} /></Field>
                <Field label="Jornada curta: mínimo (min)"><input name="short_break_minutes" type="number" min={0} max={240} defaultValue={r.short_break_minutes} className={inputClass} /></Field>
                <Field label="Curta = acima de (h)"><input name="short_break_over_minutes" inputMode="decimal" defaultValue={hoursVal(r.short_break_over_minutes)} className={inputClass} /></Field>
              </div>
              <p className="text-xs text-muted">CLT: acima de 6 h, 1 h de intervalo (30 min só com acordo ou convenção); de 4 a 6 h, 15 min. Ao criar um turno o intervalo já vem no mínimo.</p>
            </fieldset>
            <fieldset className="space-y-1 rounded-lg border border-border p-3 text-sm" disabled={!canEdit}>
              <legend className="px-1 text-xs font-medium text-muted">Descanso e jornada</legend>
              <label className="flex items-center gap-2"><input type="checkbox" name="rest_11h" defaultChecked={r.rest_11h} /> Descanso de 11 h entre jornadas</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="consecutive_days" defaultChecked={r.consecutive_days} /> Limite de dias seguidos sem folga</label>
              <Field label="Máximo de dias seguidos"><input name="max_consecutive_days" type="number" min={1} max={13} defaultValue={r.max_consecutive_days} className={`${inputClass} max-w-[8rem]`} /></Field>
              <label className="flex items-center gap-2"><input type="checkbox" name="daily_max" defaultChecked={r.daily_max} /> Jornada diária máxima</label>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Alerta acima de (h)"><input name="daily_warn_minutes" inputMode="decimal" defaultValue={hoursVal(r.daily_warn_minutes)} className={inputClass} /></Field>
                <Field label="Erro acima de (h)"><input name="daily_error_minutes" inputMode="decimal" defaultValue={hoursVal(r.daily_error_minutes)} className={inputClass} /></Field>
              </div>
              <label className="flex items-center gap-2"><input type="checkbox" name="weekly_hours" defaultChecked={r.weekly_hours} /> Alertar semana acima das horas contratadas</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="coverage" defaultChecked={r.coverage} /> Conferir a cobertura dos picos (falta de gente)</label>
            </fieldset>
          </div>
          {canEdit ? <Button>Salvar regras</Button> : <p className="text-xs text-muted">Só quem edita a escala altera as regras.</p>}
        </form>
      </Card>

      <h2 className="mb-2 mt-8 text-sm font-semibold">Turnos</h2>
      {(shifts ?? []).length === 0 ? <Empty title="Nenhum turno cadastrado">Crie o primeiro abaixo (ex.: AB Abertura 06:45–15:00).</Empty> : (
        <Table head={["Sigla", "Turno", "Horário", "Intervalo", "Total trabalhado", "Loja", "Situação", ""]}>
          {(shifts ?? []).map((s) => {
            const below = r.break_rule && netMinutes(s.start_time, s.end_time, 0) > r.break_over_minutes && s.break_minutes < r.min_break_minutes;
            return (
              <tr key={s.id} className={s.active ? "" : "opacity-60"}>
                <td className="px-3 py-2"><span className="rounded px-1.5 py-0.5 font-mono text-xs font-semibold" style={{ background: `${s.color}33`, color: s.color }}>{s.code}</span></td>
                <td className="px-3 py-2">{s.name}</td>
                <td className="px-3 py-2 tabular-nums">{hm(s.start_time)}–{hm(s.end_time)}</td>
                <td className="px-3 py-2 tabular-nums">{s.break_minutes} min{below && <span className="ml-1"><Badge tone="danger">abaixo do mínimo</Badge></span>}</td>
                <td className="px-3 py-2 tabular-nums font-medium">{fmtHours(netMinutes(s.start_time, s.end_time, s.break_minutes))}</td>
                <td className="px-3 py-2 text-xs">{s.store_id ? storeName.get(s.store_id) ?? "—" : "Todas"}</td>
                <td className="px-3 py-2"><Badge tone={s.active ? "success" : "neutral"}>{s.active ? "ativo" : "inativo"}</Badge></td>
                <td className="px-3 py-2">
                  {canEdit && (
                    <div className="flex items-center gap-1">
                      <Link className="rounded-lg px-2 py-1 text-xs hover:bg-surface-2" href={`${back}${back.includes("?") ? "&" : "?"}editar=${s.id}`}>Editar</Link>
                      <form action={toggleShiftAction}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="active" value={s.active ? "0" : "1"} /><input type="hidden" name="back" value={back} />
                        <Button variant="ghost" className="px-2 py-1 text-xs">{s.active ? "Desativar" : "Reativar"}</Button></form>
                      <form action={deleteShiftAction}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="back" value={back} />
                        <Button variant="ghost" className="px-2 py-1 text-xs text-danger" title="Só para turno que nunca entrou na escala">Excluir</Button></form>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}

      {canEdit && (
        <Card className="mt-4" title={editing ? `Editar turno ${editing.code}` : "Novo turno"}>
          <ShiftForm key={editing?.id ?? "novo"} editing={editing} stores={session.stores.map((s) => ({ id: s.id, name: s.name }))} minBreak={r.min_break_minutes} breakOverMin={r.break_over_minutes} breakRuleOn={r.break_rule} back={back} />
        </Card>
      )}

      <h2 className="mb-2 mt-8 text-sm font-semibold">Picos da loja (cobertura mínima){!r.coverage && <span className="ml-2"><Badge tone="warning">conferência de cobertura desligada</Badge></span>}</h2>
      {session.stores.length > 1 && (
        <form className="mb-2 flex items-center gap-2"><select name="loja" defaultValue={store} className={`${inputClass} max-w-xs`} aria-label="Loja">{session.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select><Button variant="secondary" className="px-2 py-1 text-xs">Ver</Button></form>
      )}
      {!store ? <Empty title="Cadastre uma loja primeiro" /> : (rules ?? []).length === 0 ? <Empty title="Nenhuma janela de pico">Sem janelas, a escala não confere quantas pessoas ficam na loja.</Empty> : (
        <Table head={["Dia", "Janela", "Horário", "Mínimo", "Situação", ""]}>
          {(rules ?? []).map((x) => (
            <tr key={x.id} className={x.active ? "" : "opacity-60"}>
              <td className="px-3 py-2">{WEEKDAYS[x.weekday]}</td>
              <td className="px-3 py-2">{x.label}</td>
              <td className="px-3 py-2 tabular-nums">{hm(x.start_time)}–{hm(x.end_time)}</td>
              <td className="px-3 py-2 tabular-nums">{x.min_staff} pessoa(s)</td>
              <td className="px-3 py-2"><Badge tone={x.active ? "success" : "neutral"}>{x.active ? "ligada" : "desligada"}</Badge></td>
              <td className="px-3 py-2">
                {canEdit && (
                  <div className="flex items-center gap-1">
                    <form action={setCoverageActiveAction}><input type="hidden" name="id" value={x.id} /><input type="hidden" name="active" value={x.active ? "0" : "1"} /><input type="hidden" name="back" value={back} /><Button variant="ghost" className="px-2 py-1 text-xs">{x.active ? "Desligar" : "Ligar"}</Button></form>
                    <Link className="rounded-lg px-2 py-1 text-xs hover:bg-surface-2" href={`${back}${back.includes("?") ? "&" : "?"}janela=${x.id}`}>Editar</Link>
                    <form action={deleteCoverageAction}><input type="hidden" name="id" value={x.id} /><input type="hidden" name="back" value={back} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Remover</Button></form>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      {canEdit && store && (
        <Card className="mt-4" title={editingRule ? `Editar janela: ${editingRule.label} (${WEEKDAYS[editingRule.weekday]})` : "Nova janela de pico"}>
          <form key={editingRule?.id ?? "nova"} action={saveCoverageAction} className="space-y-3">
            <input type="hidden" name="store_id" value={store} /><input type="hidden" name="back" value={back} />
            {editingRule && <input type="hidden" name="id" value={editingRule.id} />}
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Nome"><input name="label" required minLength={2} maxLength={60} defaultValue={editingRule?.label} className={inputClass} placeholder="Pico da manhã" /></Field>
              <Field label="Início"><input name="start_time" type="time" required defaultValue={editingRule ? hm(editingRule.start_time) : ""} className={inputClass} /></Field>
              <Field label="Fim"><input name="end_time" type="time" required defaultValue={editingRule ? hm(editingRule.end_time) : ""} className={inputClass} /></Field>
              <Field label="Mínimo de pessoas"><input name="min_staff" type="number" min={1} max={20} required defaultValue={editingRule?.min_staff ?? 1} className={inputClass} /></Field>
            </div>
            {editingRule ? (
              <Field label="Dia da semana"><select name="weekday" defaultValue={editingRule.weekday} className={`${inputClass} max-w-xs`}>{WEEKDAYS.map((w, i) => <option key={i} value={i}>{w}</option>)}</select></Field>
            ) : (
              <fieldset><legend className="mb-1 text-xs font-medium text-muted">Dias da semana</legend>
                <div className="flex flex-wrap gap-3 text-sm">{WEEKDAYS.map((w, i) => <label key={i} className="flex items-center gap-1"><input type="checkbox" name="weekdays" value={i} defaultChecked={i >= 1 && i <= 5} />{w}</label>)}</div>
              </fieldset>
            )}
            <div className="flex items-center gap-3"><Button>{editingRule ? "Salvar janela" : "Criar janela"}</Button>{editingRule && <Link href={back} className="text-xs text-brand">Cancelar</Link>}</div>
          </form>
        </Card>
      )}
    </>
  );
}
