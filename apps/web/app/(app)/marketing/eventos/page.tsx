import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { isoFromNow, str, type SP } from "@/lib/context";
import { Badge, Card, cn, Empty, PageHeader, Table } from "@/components/ui";
import { Flash } from "@/components/form";
import { EventForm, KIND, STATUS, when } from "./event-form";

export const metadata = { title: "Eventos & Drops" };

const VIEWS = [{ key: "proximos", label: "Próximos" }, { key: "passados", label: "Passados" }, { key: "todos", label: "Todos" }];
export default async function EventosPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const ver = VIEWS.some((v) => v.key === str(sp.ver)) ? str(sp.ver)! : "proximos";
  const supabase = await createClient();
  const now = isoFromNow(0);
  let q = supabase.schema("mkt").from("events").select("id, kind, name, starts_at, status, capacity, store_id, target_revenue").limit(100);
  q = ver === "proximos" ? q.gte("starts_at", now).neq("status", "CANCELLED").order("starts_at") : ver === "passados" ? q.lt("starts_at", now).order("starts_at", { ascending: false }) : q.order("starts_at", { ascending: false });
  const [{ data: events }, { data: guests }, { data: collections }] = await Promise.all([
    q,
    supabase.schema("mkt").from("event_guests").select("event_id, rsvp_status, plus_ones").limit(5000),
    supabase.schema("catalog").from("collections").select("id, name").order("name"),
  ]);
  const by = new Map<string, { total: number; confirmed: number; attended: number }>();
  for (const g of guests ?? []) {
    const s = by.get(g.event_id) ?? { total: 0, confirmed: 0, attended: 0 };
    s.total++;
    if (g.rsvp_status === "CONFIRMED" || g.rsvp_status === "ATTENDED") s.confirmed += 1 + g.plus_ones;
    if (g.rsvp_status === "ATTENDED") s.attended++;
    by.set(g.event_id, s);
  }
  const stores = session.stores.filter((s) => s.status === "ACTIVE" || s.status === "PLANNED").map((s) => ({ id: s.id, name: s.name }));

  return (
    <>
      <PageHeader title="Eventos & Drops" description="Lançamentos, cafés, ensaios e pop-ups: convidadas, confirmações, orçamento e quanto cada evento vendeu." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {VIEWS.map((v) => <Link key={v.key} href={`/marketing/eventos?ver=${v.key}`} className={cn("rounded-full border px-3 py-1 text-sm", ver === v.key ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2")}>{v.label}</Link>)}
      </div>
      {(events ?? []).length === 0 ? <Empty title="Nenhum evento aqui">{canWrite ? "Crie o primeiro abaixo." : undefined}</Empty> : (
        <Table head={["Evento", "Quando", "Convidadas", "Confirmadas", "Compareceram", "Situação", ""]}>
          {(events ?? []).map((e) => {
            const c = by.get(e.id) ?? { total: 0, confirmed: 0, attended: 0 };
            const st = STATUS[e.status];
            return (
              <tr key={e.id}>
                <td className="px-3 py-2 font-medium"><Link href={`/marketing/eventos/${e.id}`} className="hover:underline">{e.name}</Link> <Badge>{KIND[e.kind]}</Badge></td>
                <td className="px-3 py-2 text-xs">{when(e.starts_at)}</td>
                <td className="px-3 py-2 tabular-nums">{c.total}</td>
                <td className="px-3 py-2 tabular-nums">{c.confirmed}{e.capacity != null ? ` / ${e.capacity}` : ""}</td>
                <td className="px-3 py-2 tabular-nums">{c.attended}</td>
                <td className="px-3 py-2"><Badge tone={st.tone}>{st.label}</Badge></td>
                <td className="px-3 py-2"><Link className="rounded-lg px-2 py-1 text-xs text-brand hover:bg-surface-2" href={`/marketing/eventos/${e.id}`}>Abrir</Link></td>
              </tr>
            );
          })}
        </Table>
      )}
      {canWrite && <Card className="mt-4" title="Novo evento"><EventForm stores={stores} collections={collections ?? []} /></Card>}
    </>
  );
}
