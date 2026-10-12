import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { startCountAction } from "./actions";

export const metadata = { title: "Contagem de estoque" };

const STATUS: Record<string, { label: string; tone: "warning" | "success" | "neutral" }> = {
  OPEN: { label: "em contagem", tone: "warning" }, POSTED: { label: "lançada", tone: "success" }, CANCELLED: { label: "cancelada", tone: "neutral" },
};

export default async function ContagemPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("inv.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const canCount = can(session, "inv.count") || can(session, "inv.write");

  let locQuery = supabase.schema("inv").from("locations").select("id, name, kind, store_id").in("kind", ["SALES_FLOOR", "BACKROOM", "VIP_LOCKERS", "POPUP"]).order("name");
  if (session.storeId) locQuery = locQuery.eq("store_id", session.storeId);
  const [{ data: locations }, { data: counts }] = await Promise.all([
    locQuery,
    supabase.schema("inv").from("counts").select("id, location_id, kind, status, notes, created_at, posted_at, adjusted").order("created_at", { ascending: false }).limit(50),
  ]);
  const lname = new Map((locations ?? []).map((l) => [l.id, l.name]));
  const { data: tallies } = (counts ?? []).length
    ? await supabase.schema("inv").from("count_items").select("count_id, counted").in("count_id", (counts ?? []).map((c) => c.id))
    : { data: [] as { count_id: string; counted: number }[] };
  const total = new Map<string, { lines: number; pieces: number }>();
  for (const t of tallies ?? []) { const x = total.get(t.count_id) ?? { lines: 0, pieces: 0 }; total.set(t.count_id, { lines: x.lines + 1, pieces: x.pieces + Number(t.counted) }); }

  return (
    <>
      <PageHeader title="Contagem de estoque" description="Bipe as peças de um local (leitor USB ou câmera do celular). Ao lançar, o saldo de cada peça passa a ser o contado. A primeira contagem é o estoque inicial." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {canCount && (
        <Card className="mb-4" title="Nova contagem">
          <form action={startCountAction} className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <Field label="Local"><select name="location_id" required className={inputClass}>{(locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
            <Field label="Tipo" hint="Completa: o que não for bipado fica zerado. Parcial: só muda o que for bipado.">
              <select name="kind" className={inputClass}><option value="FULL">Completa (o local inteiro)</option><option value="CYCLE">Parcial (só algumas peças)</option></select>
            </Field>
            <Field label="Observação"><input name="notes" maxLength={200} className={inputClass} placeholder="Ex.: estoque inicial da inauguração" /></Field>
            <Button>Começar a contar</Button>
          </form>
        </Card>
      )}
      {(counts ?? []).length === 0 ? <Empty title="Nenhuma contagem ainda">Comece pela contagem completa do balcão: ela vira o estoque inicial.</Empty> : (
        <Table head={["Local", "Tipo", "Situação", "Peças bipadas", "Ajustes", "Data", ""]}>
          {(counts ?? []).map((c) => (
            <tr key={c.id}>
              <td className="px-3 py-2">{lname.get(c.location_id) ?? "—"}{c.notes && <span className="block text-xs text-muted">{c.notes}</span>}</td>
              <td className="px-3 py-2">{c.kind === "FULL" ? "Completa" : "Parcial"}</td>
              <td className="px-3 py-2"><Badge tone={STATUS[c.status]?.tone}>{STATUS[c.status]?.label ?? c.status}</Badge></td>
              <td className="px-3 py-2 tabular-nums">{total.get(c.id)?.pieces ?? 0} <span className="text-xs text-muted">({total.get(c.id)?.lines ?? 0} itens)</span></td>
              <td className="px-3 py-2 tabular-nums">{c.adjusted ?? "—"}</td>
              <td className="px-3 py-2 whitespace-nowrap">{new Date(c.posted_at ?? c.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}</td>
              <td className="px-3 py-2"><Link className="text-brand" href={`/produtos/contagem/${c.id}`}>{c.status === "OPEN" ? "continuar" : "ver"}</Link></td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
