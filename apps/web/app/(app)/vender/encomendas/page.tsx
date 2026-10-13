import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { inChunks } from "@/lib/fetch-all";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { setSupplierAction } from "./actions";
import { BackorderForm } from "./backorder-form";

export const metadata = { title: "Encomendas" };

const PO: Record<string, string> = { DRAFT: "em rascunho", APPROVED: "enviado", PARTIAL: "chegou em parte", RECEIVED: "recebido", CANCELLED: "cancelado" };

/** Encomendas: peças da coleção pedidas pela cliente que a loja ainda não tem; viram pedido de compra ao fornecedor. */
export default async function EncomendasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("sales.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const store = session.stores.find((s) => s.id === session.storeId) ?? session.stores[0];
  const [{ data: items }, { data: cfg }, { data: roles }] = await Promise.all([
    supabase.schema("sales").from("backorder_items").select("order_id, variant_id, qty, status, po_id, created_at, arrived_at").order("created_at", { ascending: false }).limit(500),
    supabase.schema("core").from("settings").select("value").eq("key", "backorders").maybeSingle(),
    can(session, "purch.write") ? supabase.schema("crm").from("party_roles").select("party_id").eq("role", "SUPPLIER") : Promise.resolve({ data: [] as { party_id: string }[] }),
  ]);
  const orderIds = [...new Set((items ?? []).map((i) => i.order_id))];
  const poIds = [...new Set((items ?? []).map((i) => i.po_id).filter(Boolean) as string[])];
  const [orders, pos, suppliers] = await Promise.all([
    inChunks(orderIds, (part) => supabase.schema("sales").from("orders").select("id, number, party_id, status, total, paid_total, created_at").in("id", part)),
    inChunks(poIds, (part) => supabase.schema("purch").from("purchase_orders").select("id, number, status").in("id", part)),
    inChunks((roles ?? []).map((r) => r.party_id), (part) => supabase.schema("crm").from("parties").select("id, display_name").in("id", part)),
  ]);
  const parties = await inChunks([...new Set(orders.map((o) => o.party_id).filter(Boolean) as string[])], (part) => supabase.schema("crm").from("parties").select("id, display_name").in("id", part));
  const pname = new Map(parties.map((p) => [p.id, p.display_name]));
  const poMap = new Map(pos.map((p) => [p.id, p]));
  const supplierId = (cfg?.value as { supplier_party_id?: string } | null)?.supplier_party_id;
  const supplierName = suppliers.find((s) => s.id === supplierId)?.display_name;
  const byOrder = new Map<string, { pieces: number; open: number; arrived: number; po: string | null }>();
  for (const i of items ?? []) {
    const x = byOrder.get(i.order_id) ?? { pieces: 0, open: 0, arrived: 0, po: i.po_id };
    x.pieces += Number(i.qty); if (i.status === "OPEN") x.open += Number(i.qty); if (i.status === "ARRIVED") x.arrived += Number(i.qty);
    byOrder.set(i.order_id, x);
  }
  const rows = orders.sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <>
      <PageHeader title="Encomendas" description="Peças da coleção que a cliente quer e a loja não tem. Cada encomenda entra no pedido de compra ao fornecedor; quando a peça chega, fica separada no nome dela e você recebe um aviso." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Nova encomenda">
          {!supplierId ? <p className="text-sm text-warning">Defina primeiro o fornecedor das encomendas (ao lado).</p>
            : store && can(session, "sales.write") ? <BackorderForm storeId={store.id} /> : <p className="text-sm text-muted">Sem permissão para vender.</p>}
        </Card>
        <Card title="Fornecedor das encomendas">
          <p className="mb-2 text-sm">{supplierName ?? <span className="text-warning">não definido</span>}</p>
          {can(session, "purch.write") && (
            <form action={setSupplierAction} className="space-y-2">
              <Field label="Trocar fornecedor"><select name="party_id" defaultValue={supplierId ?? ""} className={inputClass}>
                <option value="" disabled>Escolha</option>{suppliers.sort((a, b) => a.display_name.localeCompare(b.display_name)).map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
              </select></Field>
              <Button variant="secondary">Salvar</Button>
            </form>
          )}
          <p className="mt-3 text-xs text-muted">Quais produtos aceitam encomenda: na ficha do produto ou em lote no Catálogo.</p>
        </Card>
      </div>

      {rows.length === 0 ? <Empty title="Nenhuma encomenda ainda" /> : (
        <Table head={["Venda", "Cliente", "Data", "Peças", "Situação", "Pedido de compra", "Total", "Pago"]}>
          {rows.map((o) => {
            const b = byOrder.get(o.id)!;
            const po = b.po ? poMap.get(b.po) : undefined;
            const st = o.status === "CANCELLED" ? ["cancelada", "neutral"] : o.status !== "PENDING_PAYMENT" ? ["entregue", "success"] : b.open === 0 ? ["chegou: avisar a cliente", "success"] : b.arrived > 0 ? ["chegou em parte", "warning"] : ["aguardando o fornecedor", "warning"];
            return (
              <tr key={o.id}>
                <td className="px-3 py-2"><Link className="font-medium text-brand" href={`/vender/pedidos/${o.id}`}>{o.number}</Link></td>
                <td className="px-3 py-2">{o.party_id ? pname.get(o.party_id) ?? "—" : "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">{new Date(o.created_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td>
                <td className="px-3 py-2 tabular-nums">{b.pieces}</td>
                <td className="px-3 py-2"><Badge tone={st[1] as "neutral" | "success" | "warning"}>{st[0]}</Badge></td>
                <td className="px-3 py-2">{po ? <Link className="text-brand" href={`/produtos/compras/${po.id}`}>{po.number}</Link> : "—"}{po && <span className="block text-xs text-muted">{PO[po.status] ?? po.status}</span>}</td>
                <td className="px-3 py-2">{formatBRL(o.total)}</td>
                <td className="px-3 py-2">{formatBRL(o.paid_total)}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
