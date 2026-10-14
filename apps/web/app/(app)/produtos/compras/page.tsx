import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Empty, LinkButton, PageHeader, Stat, Table } from "@/components/ui";
import { Flash, fmtDate } from "@/components/form";
import { PO_STATUS } from "./labels";

export const metadata = { title: "Pedidos de compra" };

export default async function ComprasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("purch.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const filtro = str(sp.situacao) ?? "ABERTOS";

  let q = supabase.schema("purch").from("purchase_orders").select("id, number, supplier_party_id, status, expected_date, total, created_at").order("created_at", { ascending: false }).limit(200);
  if (filtro === "ABERTOS") q = q.in("status", ["DRAFT", "APPROVED", "PARTIAL"]);
  else if (filtro !== "TODOS") q = q.eq("status", filtro);
  const { data: orders } = await q;
  const supplierIds = [...new Set((orders ?? []).map((o) => o.supplier_party_id))];
  const { data: suppliers } = supplierIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", supplierIds) : { data: [] as { id: string; display_name: string }[] };
  const sname = new Map((suppliers ?? []).map((s) => [s.id, s.display_name]));
  const ids = (orders ?? []).map((o) => o.id);
  const { data: items } = ids.length ? await supabase.schema("purch").from("po_items").select("po_id, qty_ordered, qty_received").in("po_id", ids) : { data: [] as { po_id: string; qty_ordered: number; qty_received: number }[] };
  const prog = new Map<string, { o: number; r: number }>();
  for (const i of items ?? []) { const p = prog.get(i.po_id) ?? { o: 0, r: 0 }; p.o += Number(i.qty_ordered); p.r += Number(i.qty_received); prog.set(i.po_id, p); }

  const open = (orders ?? []).filter((o) => ["APPROVED", "PARTIAL"].includes(o.status));
  const openValue = open.reduce((s, o) => s + Number(o.total), 0);
  const { count: pendingReceipts } = await supabase.schema("purch").from("receipts").select("id", { count: "exact", head: true }).neq("status", "POSTED");

  return (
    <>
      <PageHeader title="Compras" description="Pedidos ao fornecedor, recebimento por NF-e com conferência de grade e reposição por tamanho."
        actions={<>
          <LinkButton href="/produtos/recebimento">Receber NF-e (XML)</LinkButton>
          <LinkButton href="/produtos/reposicao">Sugestão de reposição</LinkButton>
          {can(session, "purch.write") && <LinkButton href="/produtos/compras/pdf">Pedido pelo PDF</LinkButton>}
          {can(session, "purch.write") && <LinkButton href="/produtos/compras/novo" variant="primary">Novo pedido</LinkButton>}
        </>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Pedidos aguardando entrega" value={open.length} hint={formatBRL(openValue)} />
        <Stat label="Notas em conferência" value={pendingReceipts ?? 0} tone={(pendingReceipts ?? 0) > 0 ? "warning" : undefined} hint="ainda não lançadas no estoque" />
        <Stat label="Pedidos listados" value={(orders ?? []).length} />
      </div>
      <nav className="mb-3 flex flex-wrap gap-1 text-sm" aria-label="Situação">
        {[["ABERTOS", "Em aberto"], ["DRAFT", "Rascunhos"], ["RECEIVED", "Recebidos"], ["CANCELLED", "Cancelados"], ["TODOS", "Todos"]].map(([v, l]) => (
          <Link key={v} href={`/produtos/compras?situacao=${v}`} className={`rounded-full px-3 py-1 ${filtro === v ? "bg-brand text-brand-contrast" : "border border-border hover:bg-surface-2"}`}>{l}</Link>
        ))}
      </nav>
      {(orders ?? []).length === 0 ? <Empty title="Nenhum pedido">Crie um pedido ao fornecedor ou parta da sugestão de reposição.</Empty> : (
        <Table head={["Pedido", "Fornecedor", "Previsão", "Recebido", "Total", "Situação"]}>
          {(orders ?? []).map((o) => {
            const p = prog.get(o.id);
            const st = PO_STATUS[o.status] ?? { label: o.status, tone: "neutral" as const };
            return (
              <tr key={o.id}>
                <td className="px-3 py-2"><Link className="font-medium text-brand" href={`/produtos/compras/${o.id}`}>{o.number}</Link></td>
                <td className="px-3 py-2">{sname.get(o.supplier_party_id) ?? "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">{fmtDate(o.expected_date)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{p ? `${p.r} de ${p.o} pç` : "—"}</td>
                <td className="px-3 py-2 font-medium">{formatBRL(o.total)}</td>
                <td className="px-3 py-2"><Badge tone={st.tone}>{st.label}</Badge></td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
