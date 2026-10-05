import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Empty, PageHeader, Table } from "@/components/ui";
import { Flash } from "@/components/form";
import { saveShipmentAction, setOrderStatusAction } from "../actions";

export const metadata = { title: "Entregas" };

const CARRIER: Record<string, string> = { MOTOBOY_OWN: "Motoboy", MELHOR_ENVIO: "Melhor Envio", PICKUP_LOCKER: "Armário VIP", PICKUP_STORE: "Retirada na loja", OTHER: "Outro" };
const FULFILL: Record<string, string> = { MOTOBOY: "Motoboy", CARRIER: "Transportadora", STORE_PICKUP: "Retirada na loja", LOCKER_PICKUP: "Armário VIP", TAKEAWAY: "Na hora" };
const STATUS: Record<string, string> = { PAID: "a separar", FULFILLING: "em separação", READY_FOR_PICKUP: "pronto p/ retirar", SHIPPED: "a caminho" };

/** Pedidos pagos que ainda precisam sair da loja: separação, retirada, motoboy e transportadora. */
export default async function EntregasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("sales.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const canWrite = can(session, "sales.write");
  let q = supabase.schema("sales").from("orders").select("id, number, party_id, status, fulfillment_type, total, shipping_total, created_at")
    .in("status", ["PAID", "FULFILLING", "READY_FOR_PICKUP", "SHIPPED"]).neq("fulfillment_type", "TAKEAWAY").order("created_at").limit(200);
  if (session.storeId) q = q.eq("store_id", session.storeId);
  const { data: orders } = await q;
  const ids = (orders ?? []).map((o) => o.id), partyIds = [...new Set((orders ?? []).map((o) => o.party_id).filter(Boolean) as string[])];
  const [{ data: ships }, { data: parties }] = await Promise.all([
    ids.length ? supabase.schema("sales").from("shipments").select("order_id, carrier, tracking, status").in("order_id", ids) : Promise.resolve({ data: [] as { order_id: string; carrier: string; tracking: string | null; status: string }[] }),
    partyIds.length ? supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
  ]);
  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const shipBy = new Map((ships ?? []).map((s) => [s.order_id, s]));

  return (
    <>
      <PageHeader title="Entregas e retiradas" description="Do pedido pago até a mão da cliente. Ao marcar entregue, o pedido conclui." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(orders ?? []).length === 0 ? <Empty title="Nada pendente de entrega">Pedidos remotos pagos aparecem aqui.</Empty> : (
        <Table head={["Pedido", "Cliente", "Entrega", "Situação", "Rastreio", "Frete", "Ação"]}>
          {(orders ?? []).map((o) => {
            const s = shipBy.get(o.id);
            return (
              <tr key={o.id}>
                <td className="px-3 py-2"><Link className="font-medium text-brand" href={`/vender/pedidos/${o.id}`}>{o.number}</Link></td>
                <td className="px-3 py-2">{o.party_id ? pname.get(o.party_id) : "—"}</td>
                <td className="px-3 py-2">{FULFILL[o.fulfillment_type]}</td>
                <td className="px-3 py-2"><Badge tone={o.status === "SHIPPED" ? "info" : "warning"}>{STATUS[o.status]}</Badge></td>
                <td className="px-3 py-2 text-xs">{s ? `${CARRIER[s.carrier]}${s.tracking ? ` · ${s.tracking}` : ""}` : "—"}</td>
                <td className="px-3 py-2">{formatBRL(o.shipping_total)}</td>
                <td className="px-3 py-2">
                  {canWrite && (
                    <div className="flex flex-wrap gap-1">
                      {["MOTOBOY", "CARRIER"].includes(o.fulfillment_type) && o.status !== "SHIPPED" && (
                        <form action={saveShipmentAction}>
                          <input type="hidden" name="order_id" value={o.id} /><input type="hidden" name="return_to" value="/vender/entregas" />
                          <input type="hidden" name="carrier" value={o.fulfillment_type === "MOTOBOY" ? "MOTOBOY_OWN" : "MELHOR_ENVIO"} /><input type="hidden" name="status" value="IN_TRANSIT" />
                          <input type="hidden" name="charged" value={String(o.shipping_total)} />
                          <Button variant="secondary" className="px-2 py-1 text-xs">Despachar</Button>
                        </form>
                      )}
                      {o.status === "SHIPPED" && s && (
                        <form action={saveShipmentAction}>
                          <input type="hidden" name="order_id" value={o.id} /><input type="hidden" name="return_to" value="/vender/entregas" />
                          <input type="hidden" name="carrier" value={s.carrier} /><input type="hidden" name="status" value="DELIVERED" />
                          <Button variant="secondary" className="px-2 py-1 text-xs">Entregue</Button>
                        </form>
                      )}
                      {["STORE_PICKUP", "LOCKER_PICKUP"].includes(o.fulfillment_type) && (
                        <form action={setOrderStatusAction} className="flex gap-1">
                          <input type="hidden" name="order_id" value={o.id} /><input type="hidden" name="status" value={o.status === "READY_FOR_PICKUP" ? "COMPLETED" : "READY_FOR_PICKUP"} />
                          <Button variant="secondary" className="px-2 py-1 text-xs">{o.status === "READY_FOR_PICKUP" ? "Retirado" : "Pronto p/ retirar"}</Button>
                        </form>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
