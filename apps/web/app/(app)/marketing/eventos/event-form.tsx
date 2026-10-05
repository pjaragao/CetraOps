import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { saveEventAction } from "./actions";

export const KIND: Record<string, string> = { DROP: "Drop", BREAKFAST_ACTIVATION: "Café da manhã", PHOTOSHOOT: "Ensaio", POPUP: "Pop-up", TRUNK_SHOW: "Trunk show" };
export const STATUS: Record<string, { label: string; tone: "neutral" | "info" | "success" | "danger" }> = {
  PLANNED: { label: "planejado", tone: "neutral" }, CONFIRMED: { label: "confirmado", tone: "info" }, DONE: { label: "realizado", tone: "success" }, CANCELLED: { label: "cancelado", tone: "danger" },
};
export const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const toLocalInput = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace(" ", "T").slice(0, 16) : "");

export interface EventInitial { id: string; kind: string; name: string; store_id: string | null; starts_at: string; ends_at: string | null; venue: string | null; capacity: number | null; target_revenue: number | null; collection_id: string | null; notes: string | null }

/** Criar ou editar um evento (mesmos campos). Na criação, pode abrir o centro de custo do projeto para o DRE por evento. */
export function EventForm({ stores, collections, initial }: { stores: { id: string; name: string }[]; collections: { id: string; name: string }[]; initial?: EventInitial }) {
  return (
    <form action={saveEventAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {initial && <input type="hidden" name="id" value={initial.id} />}
      <Field label="Tipo"><select name="kind" defaultValue={initial?.kind ?? "DROP"} className={inputClass}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="Nome" className="lg:col-span-2"><input name="name" required minLength={3} maxLength={120} defaultValue={initial?.name} className={inputClass} placeholder="Drop 02 — Coleção Inverno" /></Field>
      <Field label="Loja"><select name="store_id" defaultValue={initial?.store_id ?? stores[0]?.id ?? ""} className={inputClass}><option value="">—</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="Começa em"><input name="starts_at" type="datetime-local" required defaultValue={toLocalInput(initial?.starts_at)} className={inputClass} /></Field>
      <Field label="Termina em (opcional)"><input name="ends_at" type="datetime-local" defaultValue={toLocalInput(initial?.ends_at)} className={inputClass} /></Field>
      <Field label="Local"><input name="venue" maxLength={120} defaultValue={initial?.venue ?? ""} className={inputClass} placeholder="Loja Centro" /></Field>
      <Field label="Capacidade (pessoas)" hint="Passou disso, entra em lista de espera"><input name="capacity" type="number" min={0} defaultValue={initial?.capacity ?? ""} className={inputClass} /></Field>
      <Field label="Meta de vendas (R$)"><input name="target_revenue" inputMode="decimal" defaultValue={initial?.target_revenue ?? ""} className={inputClass} placeholder="8.000,00" /></Field>
      <Field label="Coleção (opcional)"><select name="collection_id" defaultValue={initial?.collection_id ?? ""} className={inputClass}><option value="">—</option>{collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <Field label="Observações" className="lg:col-span-2"><input name="notes" maxLength={300} defaultValue={initial?.notes ?? ""} className={inputClass} /></Field>
      {!initial && <label className="flex items-center gap-2 self-end pb-2 text-xs"><input type="checkbox" name="create_cost_center" defaultChecked /> Abrir centro de custo do projeto (custos e ROI do evento)</label>}
      <div className="sm:col-span-2 lg:col-span-4"><Button>{initial ? "Salvar evento" : "Criar evento"}</Button></div>
    </form>
  );
}
