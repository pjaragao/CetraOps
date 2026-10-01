import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { isoFromNow, str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { closeLockerAction, ensureLockersAction, releaseReservationAction } from "../actions";
import { resolveItems } from "../../produtos/compras/options";
import { LockerForm } from "./locker-form";

export const metadata = { title: "Reservas e Armário VIP" };

const REASON: Record<string, string> = { ORDER: "Pedido", VIP_LOCKER: "Armário VIP", AI_HOLD: "Retida pela IA", TRY_ON: "Provador", B2B: "B2B", DROP_WAITLIST: "Lista de espera" };

const remaining = (iso: string | null, now: number) => {
  if (!iso) return "sem prazo";
  const min = Math.round((new Date(iso).getTime() - now) / 60000);
  if (min <= 0) return "vencida";
  return min >= 1440 ? `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h` : min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}min` : `${min}min`;
};

export default async function ReservasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("sales.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const canWrite = can(session, "sales.write");
  const store = session.stores.find((s) => s.id === session.storeId) ?? session.stores[0];
  const now = new Date(isoFromNow(0)).getTime();

  const [{ data: reservations }, { data: lockers }, { data: drops }, { data: loc }] = await Promise.all([
    supabase.schema("inv").from("reservations").select("id, variant_id, qty, reason, party_id, expires_at, created_by_kind, order_id, drop_id, created_at").eq("status", "ACTIVE").order("expires_at", { nullsFirst: false }).limit(200),
    store ? supabase.schema("inv").from("lockers").select("id, code, status").eq("store_id", store.id).order("code") : Promise.resolve({ data: [] as { id: string; code: string; status: string }[] }),
    supabase.schema("sales").from("locker_drops").select("id, locker_id, party_id, expires_at, notes, dropped_at").eq("outcome", "PENDING").order("expires_at"),
    store ? supabase.schema("inv").from("locations").select("id").eq("store_id", store.id).eq("kind", "SALES_FLOOR").order("created_at").limit(1).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const partyIds = [...new Set([...(reservations ?? []).map((r) => r.party_id), ...(drops ?? []).map((d) => d.party_id)].filter(Boolean) as string[])];
  const { data: parties } = partyIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : { data: [] as { id: string; display_name: string }[] };
  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const labels = await resolveItems((reservations ?? []).map((r) => ({ variant_id: r.variant_id, qty: 0, unit_cost: 0 })));
  const lmap = new Map(labels.map((l) => [l.variant_id, l]));
  const lockerCode = new Map((lockers ?? []).map((l) => [l.id, l.code]));
  const free = (lockers ?? []).filter((l) => l.status === "FREE");

  return (
    <>
      <PageHeader title="Reservas e Armário VIP" description="Peças separadas para a cliente (Armário VIP, provador, pedido aguardando pagamento ou retenção pela IA). Vencidas voltam para o estoque disponível." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title={`Armários abertos · ${(drops ?? []).length}`}>
            {(drops ?? []).length === 0 ? <p className="text-sm text-muted">Nenhum armário com peças agora.</p> : (
              <ul className="divide-y divide-border">{(drops ?? []).map((d) => {
                const its = (reservations ?? []).filter((r) => r.drop_id === d.id);
                return (
                  <li key={d.id} className="py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm"><b>{lockerCode.get(d.locker_id)}</b> · {d.party_id ? pname.get(d.party_id) : "—"} <Badge tone={new Date(d.expires_at).getTime() - now < 3 * 3600_000 ? "danger" : "warning"}>{remaining(d.expires_at, now)}</Badge></p>
                      {canWrite && (
                        <form action={closeLockerAction} className="flex items-center gap-2"><input type="hidden" name="drop_id" value={d.id} />
                          <select name="outcome" className={`${inputClass} w-44`} aria-label="Resultado"><option value="PURCHASED_ALL">Levou tudo</option><option value="PARTIAL">Levou parte</option><option value="RETURNED">Não levou nada</option></select>
                          <Button variant="secondary" className="px-2 py-1 text-xs">Encerrar</Button></form>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted">{its.map((r) => `${r.qty}× ${lmap.get(r.variant_id)?.sku}`).join(" · ")}{d.notes ? ` — ${d.notes}` : ""}</p>
                  </li>
                );
              })}</ul>
            )}
          </Card>
        </div>
        <Card title="Armários da loja">
          {(lockers ?? []).length === 0 ? (
            canWrite && store ? <form action={ensureLockersAction} className="space-y-2"><input type="hidden" name="store_id" value={store.id} />
              <Field label="Quantos armários a loja tem?"><input name="count" type="number" min={1} max={60} defaultValue={6} className={inputClass} /></Field><Button variant="secondary">Cadastrar armários</Button></form>
              : <p className="text-sm text-muted">Nenhum armário cadastrado.</p>
          ) : (
            <div className="flex flex-wrap gap-2">{(lockers ?? []).map((l) => <span key={l.id} className={`rounded-lg border px-3 py-1.5 text-sm ${l.status === "FREE" ? "border-success/40 text-success" : "border-warning/50 text-warning"}`}>{l.code}<span className="ml-1 text-xs">{l.status === "FREE" ? "livre" : "ocupado"}</span></span>)}</div>
          )}
        </Card>
      </div>

      {canWrite && store && free.length > 0 && (
        <Card className="mb-4" title="Preparar Armário VIP"><LockerForm storeId={store.id} lockers={free} locationId={loc?.id} /></Card>
      )}

      <h2 className="mb-2 text-sm font-semibold text-muted">Todas as reservas ativas</h2>
      {(reservations ?? []).length === 0 ? <Empty title="Nenhuma reserva ativa" /> : (
        <Table head={["Peça", "Qtd", "Motivo", "Cliente", "Vence em", ""]}>
          {(reservations ?? []).map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2"><span className="font-mono text-xs text-muted">{lmap.get(r.variant_id)?.sku}</span> {lmap.get(r.variant_id)?.label}</td>
              <td className="px-3 py-2">{Number(r.qty)}</td>
              <td className="px-3 py-2">{REASON[r.reason]}{r.created_by_kind === "AI" && <Badge tone="info">IA</Badge>}</td>
              <td className="px-3 py-2">{r.party_id ? pname.get(r.party_id) ?? "—" : "—"}</td>
              <td className={`px-3 py-2 whitespace-nowrap ${r.expires_at && new Date(r.expires_at).getTime() - now < 3600_000 ? "font-medium text-danger" : ""}`}>{remaining(r.expires_at, now)}</td>
              <td className="px-3 py-2">{canWrite && r.reason !== "ORDER" && <form action={releaseReservationAction}><input type="hidden" name="id" value={r.id} /><Button variant="ghost" className="px-2 py-1 text-xs">liberar</Button></form>}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
