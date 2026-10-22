import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, LinkButton, PageHeader, Stat, Table } from "@/components/ui";
import { Field, Flash, fmtDate } from "@/components/form";
import { approvePoAction, cancelPoAction, closePoAction } from "../actions";
import { loadPurchaseOptions, resolveItems } from "../options";
import { PoEditor } from "../po-editor";
import { PO_STATUS, RECEIPT_STATUS } from "../labels";

export const metadata = { title: "Pedido de compra" };

export default async function PedidoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("purch.read");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: po } = await supabase.schema("purch").from("purchase_orders").select("*").eq("id", id).maybeSingle();
  if (!po) notFound();
  const [{ data: rows }, { data: receipts }, { data: supplier }] = await Promise.all([
    supabase.schema("purch").from("po_items").select("variant_id, qty_ordered, unit_cost, qty_received").eq("po_id", id),
    supabase.schema("purch").from("receipts").select("id, number, status, nf_total, created_at").eq("po_id", id).order("created_at"),
    supabase.schema("crm").from("parties").select("display_name").eq("id", po.supplier_party_id).maybeSingle(),
  ]);
  const items = await resolveItems((rows ?? []).map((r) => ({ variant_id: r.variant_id, qty: Number(r.qty_ordered), unit_cost: Number(r.unit_cost) })));
  const recv = new Map((rows ?? []).map((r) => [r.variant_id, Number(r.qty_received)]));
  const st = PO_STATUS[po.status] ?? { label: po.status, tone: "neutral" as const };
  const canWrite = can(session, "purch.write");
  const canApprove = can(session, "purch.approve");

  if (po.status === "DRAFT" && canWrite) {
    const opts = await loadPurchaseOptions();
    return (
      <>
        <PageHeader title={`Pedido ${po.number}`} description={`${supplier?.display_name ?? ""} · rascunho`} actions={<LinkButton href="/produtos/compras">Voltar</LinkButton>} />
        <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
        <PoEditor {...opts} initial={{ id: po.id, legal_entity_id: po.legal_entity_id, location_id: po.location_id, supplier_party_id: po.supplier_party_id, expected_date: po.expected_date ?? undefined,
          payment_terms_id: po.payment_terms_id ?? undefined, collection_id: po.collection_id ?? undefined, notes: po.notes ?? undefined, items }} />
        <div className="mt-4 flex flex-wrap items-end gap-3">
          {canApprove && <form action={approvePoAction}><input type="hidden" name="po_id" value={po.id} /><Button variant="secondary">Aprovar pedido</Button></form>}
          {canApprove && (
            <form action={cancelPoAction} className="flex items-end gap-2"><input type="hidden" name="po_id" value={po.id} />
              <Field label="Descartar pedido"><input name="reason" placeholder="Motivo" className={`${inputClass} w-56`} /></Field><Button variant="danger">Descartar</Button></form>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title={`Pedido ${po.number}`} description={`${supplier?.display_name ?? ""} · previsão ${fmtDate(po.expected_date)}`}
        actions={<><Badge tone={st.tone}>{st.label}</Badge><LinkButton href="/produtos/compras">Voltar</LinkButton>
          {["APPROVED", "PARTIAL"].includes(po.status) && canWrite && <LinkButton href={`/produtos/recebimento?pedido=${po.id}`} variant="primary">Receber NF-e deste pedido</LinkButton>}</>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total do pedido" value={formatBRL(po.total)} />
        <Stat label="Peças pedidas" value={items.reduce((s, i) => s + i.qty, 0)} />
        <Stat label="Peças recebidas" value={[...recv.values()].reduce((s, v) => s + v, 0)} />
        <Stat label="Criado em" value={fmtDate(po.created_at.slice(0, 10))} hint={po.approved_at ? `aprovado em ${fmtDate(po.approved_at.slice(0, 10))}` : undefined} />
      </div>
      <Table head={["Produto", "Pedido", "Recebido", "Saldo", "Custo unit.", "Total"]} totals={[1, 2, 3]}>
        {items.map((i) => {
          const r = recv.get(i.variant_id) ?? 0;
          return (
            <tr key={i.variant_id}>
              <td className="px-3 py-2"><span className="font-mono text-xs text-muted">{i.sku}</span> {i.label}</td>
              <td className="px-3 py-2">{i.qty}</td><td className="px-3 py-2">{r}</td>
              <td className={`px-3 py-2 ${i.qty - r > 0 ? "font-medium text-warning" : ""}`}>{Math.max(i.qty - r, 0)}</td>
              <td className="px-3 py-2">{formatBRL(i.unit_cost)}</td><td className="px-3 py-2">{formatBRL(Math.round(i.qty * i.unit_cost * 100) / 100)}</td>
            </tr>
          );
        })}
      </Table>
      {(receipts ?? []).length > 0 && (
        <Card className="mt-4" title="Notas recebidas deste pedido">
          <ul className="divide-y divide-border text-sm">
            {(receipts ?? []).map((r) => (
              <li key={r.id} className="flex items-center justify-between py-1.5">
                <Link className="text-brand" href={`/produtos/recebimento/${r.id}`}>{r.number}</Link>
                <span className="flex items-center gap-3">{formatBRL(r.nf_total)}<Badge tone={RECEIPT_STATUS[r.status]?.tone}>{RECEIPT_STATUS[r.status]?.label ?? r.status}</Badge></span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {canApprove && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          {["APPROVED", "PARTIAL"].includes(po.status) && <form action={closePoAction}><input type="hidden" name="po_id" value={po.id} /><Button variant="secondary">Encerrar com saldo (cancela o que faltou)</Button></form>}
          {["APPROVED", "PARTIAL"].includes(po.status) && (
            <form action={cancelPoAction} className="flex items-end gap-2"><input type="hidden" name="po_id" value={po.id} />
              <Field label="Cancelar pedido"><input name="reason" placeholder="Motivo" className={`${inputClass} w-56`} /></Field><Button variant="danger">Cancelar</Button></form>
          )}
        </div>
      )}
      {po.notes && <p className="mt-4 text-sm text-muted">Observações: {po.notes}</p>}
    </>
  );
}
