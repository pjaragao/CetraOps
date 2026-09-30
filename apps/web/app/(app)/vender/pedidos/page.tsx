import Link from "next/link";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { periodBounds, str, type SP } from "@/lib/context";
import { Badge, Empty, LinkButton, PageHeader, Table } from "@/components/ui";
import { can } from "@/lib/session";

export const metadata = { title: "Pedidos" };

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = {
  COMPLETED: "success", PAID: "success", CANCELLED: "danger", RETURNED: "danger", PENDING_PAYMENT: "warning", DRAFT: "neutral", PARTIALLY_RETURNED: "warning",
};

export default async function PedidosPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = await requirePerm("sales.read");
  const period = periodBounds(str(sp.periodo));
  const supabase = await createClient();

  let q = supabase.schema("sales").from("orders")
    .select("id, number, channel, status, total, created_at, party_id, order_items(count)")
    .gte("created_at", period.fromTs).lte("created_at", period.toTs)
    .order("created_at", { ascending: false }).limit(200);
  if (session.storeId) q = q.eq("store_id", session.storeId);
  const n = str(sp.n);
  const filtro = str(sp.situacao);
  if (filtro === "AGUARDANDO") q = q.eq("status", "PENDING_PAYMENT");
  else if (filtro === "ENTREGA") q = q.in("status", ["PAID", "FULFILLING", "READY_FOR_PICKUP", "SHIPPED"]).neq("fulfillment_type", "TAKEAWAY");
  else if (filtro === "DEVOLVIDOS") q = q.in("status", ["PARTIALLY_RETURNED", "RETURNED"]);
  if (n) q = q.ilike("number", `%${n.replace(/[%,]/g, "")}%`);
  const { data: orders, error } = await q;
  const ids = [...new Set((orders ?? []).map((o) => o.party_id).filter((x): x is string => !!x))];
  const { data: partyRows } = ids.length
    ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", ids)
    : { data: [] as { id: string; display_name: string }[] };
  const partyName = new Map((partyRows ?? []).map((p) => [p.id, p.display_name]));

  return (
    <>
      <PageHeader title="Pedidos" description="Todos os canais: balcão, WhatsApp, Instagram, links e B2B." actions={<>{can(session, "sales.write") && <LinkButton href="/vender/pedidos/novo">Pedido remoto</LinkButton>}<LinkButton href="/vender/pdv" variant="primary">Nova venda</LinkButton></>} />
      <nav className="mb-3 flex flex-wrap gap-1 text-sm" aria-label="Situação">
        {[["", "Todos"], ["AGUARDANDO", "Aguardando pagamento"], ["ENTREGA", "Em entrega/retirada"], ["DEVOLVIDOS", "Devolvidos"]].map(([v, l]) => (
          <Link key={v} href={`/vender/pedidos${v ? `?situacao=${v}` : ""}`} className={`rounded-full px-3 py-1 ${(filtro ?? "") === v ? "bg-brand text-brand-contrast" : "border border-border hover:bg-surface-2"}`}>{l}</Link>
        ))}
      </nav>
      {error && <p className="mb-3 text-sm text-danger">{error.message}</p>}
      {(orders ?? []).length === 0 ? <Empty title="Nenhum pedido no período" /> : (
        <Table head={["Número", "Data", "Cliente", "Canal", "Itens", "Total", "Status"]}>
          {(orders ?? []).map((o) => (
            <tr key={o.id} className="hover:bg-surface-2">
              <td className="px-3 py-2 font-medium whitespace-nowrap"><Link className="text-brand" href={`/vender/pedidos/${o.id}`}>{o.number}</Link></td>
              <td className="px-3 py-2 whitespace-nowrap">{new Date(o.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}</td>
              <td className="px-3 py-2">{o.party_id ? <Link className="text-brand" href={`/clientes/${o.party_id}`}>{partyName.get(o.party_id) ?? "cliente"}</Link> : <span className="text-muted">—</span>}</td>
              <td className="px-3 py-2">{o.channel}</td>
              <td className="px-3 py-2">{o.order_items?.[0]?.count ?? 0}</td>
              <td className="px-3 py-2 font-medium whitespace-nowrap">{formatBRL(o.total)}</td>
              <td className="px-3 py-2"><Badge tone={STATUS_TONE[o.status] ?? "info"}>{o.status}</Badge></td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
