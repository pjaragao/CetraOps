import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { deleteCoverageAction, deleteShiftAction, saveCoverageAction, saveShiftAction, toggleShiftAction } from "../../actions";

export const metadata = { title: "Turnos e picos" };

const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const hm = (t: string) => t.slice(0, 5);
const span = (s: string, e: string, brk: number) => {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let m = toMin(e) - toMin(s);
  if (m <= 0) m += 1440;
  m -= brk;
  return `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, "0") : ""}`;
};

export default async function TurnosPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("hr.read");
  const sp = await searchParams;
  const canEdit = can(session, "hr.write");
  const store = str(sp.loja) ?? session.storeId ?? session.stores[0]?.id;
  const supabase = await createClient();
  const [{ data: shifts }, { data: rules }] = await Promise.all([
    supabase.schema("hr").from("shift_templates").select("id, code, name, start_time, end_time, break_minutes, color, active, store_id").order("active", { ascending: false }).order("start_time"),
    store ? supabase.schema("hr").from("coverage_rules").select("id, weekday, label, start_time, end_time, min_staff").eq("store_id", store).order("weekday").order("start_time")
      : Promise.resolve({ data: [] as { id: string; weekday: number; label: string; start_time: string; end_time: string; min_staff: number }[] }),
  ]);
  const editing = (shifts ?? []).find((s) => s.id === str(sp.editar));
  const editingRule = (rules ?? []).find((r) => r.id === str(sp.janela));
  const back = `/equipe/escalas/turnos${store ? `?loja=${store}` : ""}`;
  const storeName = new Map(session.stores.map((s) => [s.id, s.name]));

  return (
    <>
      <PageHeader title="Turnos e picos" description="Turnos prontos aceleram a montagem da escala, mas não são obrigatórios: na grade dá para lançar qualquer horário num dia. Os picos dizem quantas pessoas precisam estar na loja em cada janela."
        actions={<Link href={`/equipe/escalas${store ? `?loja=${store}` : ""}`} className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Escala</Link>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      <h2 className="mb-2 text-sm font-semibold">Turnos</h2>
      {(shifts ?? []).length === 0 ? <Empty title="Nenhum turno cadastrado">Crie o primeiro abaixo (ex.: AB Abertura 06:45–15:00).</Empty> : (
        <Table head={["Sigla", "Turno", "Horário", "Intervalo", "Jornada", "Loja", "Situação", ""]}>
          {(shifts ?? []).map((s) => (
            <tr key={s.id} className={s.active ? "" : "opacity-60"}>
              <td className="px-3 py-2"><span className="rounded px-1.5 py-0.5 font-mono text-xs font-semibold" style={{ background: `${s.color}33`, color: s.color }}>{s.code}</span></td>
              <td className="px-3 py-2">{s.name}</td>
              <td className="px-3 py-2 tabular-nums">{hm(s.start_time)}–{hm(s.end_time)}</td>
              <td className="px-3 py-2 tabular-nums">{s.break_minutes} min</td>
              <td className="px-3 py-2 tabular-nums">{span(s.start_time, s.end_time, s.break_minutes)}</td>
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
          ))}
        </Table>
      )}

      {canEdit && (
        <Card className="mt-4" title={editing ? `Editar turno ${editing.code}` : "Novo turno"}>
          <form key={editing?.id ?? "novo"} action={saveShiftAction} className="grid gap-3 sm:grid-cols-4 lg:grid-cols-8 lg:items-end">
            {editing && <input type="hidden" name="id" value={editing.id} />}<input type="hidden" name="back" value={back} />
            <Field label="Sigla"><input name="code" required maxLength={4} defaultValue={editing?.code} className={`${inputClass} uppercase`} placeholder="AB" /></Field>
            <div className="sm:col-span-2"><Field label="Nome"><input name="name" maxLength={60} defaultValue={editing?.name} className={inputClass} placeholder="Abertura" /></Field></div>
            <Field label="Início"><input name="start_time" type="time" required defaultValue={editing ? hm(editing.start_time) : ""} className={inputClass} /></Field>
            <Field label="Fim"><input name="end_time" type="time" required defaultValue={editing ? hm(editing.end_time) : ""} className={inputClass} /></Field>
            <Field label="Intervalo (min)"><input name="break_minutes" type="number" min={0} max={240} required defaultValue={editing?.break_minutes ?? 60} className={inputClass} /></Field>
            <Field label="Cor"><input name="color" type="color" defaultValue={editing?.color ?? "#8a7fb0"} className="h-9 w-full rounded-lg border border-border bg-surface" /></Field>
            <Field label="Loja"><select name="store_id" defaultValue={editing?.store_id ?? ""} className={inputClass}><option value="">Todas</option>{session.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <div className="flex items-center gap-3 sm:col-span-4 lg:col-span-8">
              <Button>{editing ? "Salvar turno" : "Criar turno"}</Button>
              {editing && <Link href={back} className="text-xs text-brand">Cancelar</Link>}
              <span className="text-xs text-muted">Turno que passa da meia-noite: informe o fim menor que o início (ex.: 22:00–02:00).</span>
            </div>
          </form>
        </Card>
      )}

      <h2 className="mb-2 mt-8 text-sm font-semibold">Picos da loja (cobertura mínima)</h2>
      {session.stores.length > 1 && (
        <form className="mb-2 flex items-center gap-2"><select name="loja" defaultValue={store} className={`${inputClass} max-w-xs`} aria-label="Loja">{session.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select><Button variant="secondary" className="px-2 py-1 text-xs">Ver</Button></form>
      )}
      {!store ? <Empty title="Cadastre uma loja primeiro" /> : (rules ?? []).length === 0 ? <Empty title="Nenhuma janela de pico">Sem janelas, a escala não confere quantas pessoas ficam na loja.</Empty> : (
        <Table head={["Dia", "Janela", "Horário", "Mínimo", ""]}>
          {(rules ?? []).map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2">{WEEKDAYS[r.weekday]}</td>
              <td className="px-3 py-2">{r.label}</td>
              <td className="px-3 py-2 tabular-nums">{hm(r.start_time)}–{hm(r.end_time)}</td>
              <td className="px-3 py-2 tabular-nums">{r.min_staff} pessoa(s)</td>
              <td className="px-3 py-2">
                {canEdit && (
                  <div className="flex items-center gap-1">
                    <Link className="rounded-lg px-2 py-1 text-xs hover:bg-surface-2" href={`${back}${back.includes("?") ? "&" : "?"}janela=${r.id}`}>Editar</Link>
                    <form action={deleteCoverageAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="back" value={back} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Remover</Button></form>
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
