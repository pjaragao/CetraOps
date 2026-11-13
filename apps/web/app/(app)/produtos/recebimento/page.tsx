import Link from "next/link";
import { ScanBarcode } from "lucide-react";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, LinkButton, PageHeader, Table } from "@/components/ui";
import { Field, Flash, fmtDate } from "@/components/form";
import { importNfeAction } from "../compras/actions";
import { rpcAny } from "@/lib/rpc";
import { finishBatchFormAction } from "./[id]/bipar/actions";
import { RECEIPT_STATUS } from "../compras/labels";
import { loadPurchaseOptions } from "../compras/options";

export const metadata = { title: "Recebimento de NF-e" };

export default async function RecebimentoListPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("purch.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const filtro = str(sp.situacao) ?? "PENDENTES";
  const po = str(sp.pedido);

  let q = supabase.schema("purch").from("receipts").select("id, number, supplier_party_id, document_id, status, nf_total, shortage_total, po_id, created_at").order("created_at", { ascending: false }).limit(200);
  if (filtro === "PENDENTES") q = q.neq("status", "POSTED");
  else if (filtro !== "TODOS") q = q.eq("status", filtro);
  const { data: receipts } = await q;
  const supplierIds = [...new Set((receipts ?? []).map((r) => r.supplier_party_id))];
  const docIds = (receipts ?? []).map((r) => r.document_id).filter(Boolean) as string[];
  const openIds = (receipts ?? []).filter((r) => r.status !== "POSTED").map((r) => r.id);
  const [{ data: suppliers }, { data: docs }, opts, { data: pos }, { data: counts }] = await Promise.all([
    supplierIds.length ? supabase.schema("crm").from("parties").select("id, display_name").in("id", supplierIds) : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
    docIds.length ? supabase.schema("fiscal").from("documents").select("id, number, series, issue_at").in("id", docIds) : Promise.resolve({ data: [] as { id: string; number: number | null; series: number | null; issue_at: string | null }[] }),
    can(session, "purch.write") ? loadPurchaseOptions() : Promise.resolve(null),
    supabase.schema("purch").from("purchase_orders").select("id, number, supplier_party_id").in("status", ["APPROVED", "PARTIAL"]).order("created_at", { ascending: false }),
    openIds.length ? supabase.schema("purch").from("receipt_items").select("receipt_id, qty_nfe, qty_counted").in("receipt_id", openIds)
      : Promise.resolve({ data: [] as { receipt_id: string; qty_nfe: number; qty_counted: number | null }[] }),
  ]);
  // quanto já foi bipado/contado de cada nota em aberto (para continuar de onde parou)
  const progress = new Map<string, { nfe: number; counted: number }>();
  for (const c of counts ?? []) {
    const p = progress.get(c.receipt_id) ?? { nfe: 0, counted: 0 };
    p.nfe += Number(c.qty_nfe); p.counted += Math.min(Number(c.qty_counted ?? 0), Number(c.qty_nfe));
    progress.set(c.receipt_id, p);
  }
  const fmtN = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString("pt-BR", { maximumFractionDigits: 3 }));
  // lotes de várias NF-e em andamento: ficam aqui até serem finalizados
  type BatchNote = { id: string; number: string; status: string; total: number; nf: string; pieces: number; counted: number };
  type Batch = { id: string; created_at: string; notes: BatchNote[]; extras: number };
  const { data: batchData } = can(session, "purch.write") || can(session, "purch.read") ? await rpcAny(supabase, "purch", "receipt_batches_overview", {}) : { data: [] };
  const batches = Array.isArray(batchData) ? (batchData as Batch[]) : [];
  const sname = new Map((suppliers ?? []).map((s) => [s.id, s.display_name]));
  const dmap = new Map((docs ?? []).map((d) => [d.id, d]));
  const psup = new Map((pos ?? []).map((p) => [p.id, p]));

  return (
    <>
      <PageHeader title="Recebimento de NF-e" description="Importe o XML da nota do fornecedor, confira a grade (quantidade por tamanho) e lance no estoque. O contas a pagar sai das duplicatas." actions={<LinkButton href="/produtos/recebimento/sobras">Sobras e fora da NF</LinkButton>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {batches.length > 0 && (
        <Card className="mb-4 border-brand/50" title={`Entradas em andamento (${batches.length})`}>
          <p className="mb-2 text-xs text-muted">Várias NF-e bipadas juntas. O lote fica aqui até você finalizar (ou até todas as notas serem lançadas no estoque).</p>
          <ul className="space-y-2">
            {batches.map((b) => {
              const pieces = b.notes.reduce((a, n) => a + Number(n.pieces), 0), counted = b.notes.reduce((a, n) => a + Number(n.counted), 0);
              const pct = pieces ? Math.round((counted / pieces) * 100) : 0;
              return (
                <li key={b.id} className="rounded-xl border border-border bg-surface p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <ScanBarcode size={16} className="text-brand" />
                    <span className="font-medium">{b.notes.length} notas: {b.notes.map((n) => `NF ${n.nf.split("/")[0]}`).join(" + ")}</span>
                    <span className="text-xs text-muted">desde {fmtDate(b.created_at.slice(0, 10))}</span>
                    {Number(b.extras) > 0 && <Badge tone="warning">{fmtN(Number(b.extras))} sobrando / fora da NF</Badge>}
                    <span className="ml-auto flex items-center gap-2">
                      {can(session, "purch.write") && <form action={finishBatchFormAction}><input type="hidden" name="batch_id" value={b.id} /><Button variant="ghost" className="text-xs">Finalizar lote</Button></form>}
                      <Link className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-contrast" href={`/produtos/recebimento/bipar?lote=${b.id}`}><ScanBarcode size={14} /> Continuar bipando</Link>
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2"><div className={`h-full rounded-full ${pct === 100 ? "bg-success" : "bg-brand"}`} style={{ width: `${pct}%` }} /></div>
                  <p className="mt-1 text-xs tabular-nums text-muted">{fmtN(counted)}/{fmtN(pieces)} peças · {b.notes.map((n) => `NF ${n.nf.split("/")[0]}: ${fmtN(Number(n.counted))}/${fmtN(Number(n.pieces))}`).join(" · ")}</p>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {opts && (
        <Card className="mb-4" title="Importar XML">
          <form action={importNfeAction} encType="multipart/form-data" className="grid gap-3 sm:grid-cols-4">
            <Field label="Arquivo(s) XML" className="sm:col-span-2"><input type="file" name="file" accept=".xml,text/xml,application/xml" multiple required className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-surface-2 file:px-2 file:py-1`} /></Field>
            <Field label="Receber em"><select name="location_id" required className={inputClass}>{opts.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
            <Field label="Pedido de compra (opcional)"><select name="po_id" defaultValue={po ?? ""} className={inputClass}><option value="">Sem pedido</option>
              {(pos ?? []).map((p) => <option key={p.id} value={p.id}>{p.number} — {sname.get(p.supplier_party_id) ?? opts.suppliers.find((s) => s.id === p.supplier_party_id)?.name ?? ""}</option>)}</select></Field>
            <div className="sm:col-span-4"><Button>Importar</Button>
              <span className="ml-3 text-xs text-muted">Aceita NF-e modelo 55 autorizadas (arquivo nfeProc). O mesmo XML não entra duas vezes.</span></div>
          </form>
        </Card>
      )}
      <nav className="mb-3 flex flex-wrap gap-1 text-sm" aria-label="Situação">
        {[["PENDENTES", "A conferir/lançar"], ["POSTED", "Lançados"], ["TODOS", "Todos"]].map(([v, l]) => (
          <Link key={v} href={`/produtos/recebimento?situacao=${v}`} className={`rounded-full px-3 py-1 ${filtro === v ? "bg-brand text-brand-contrast" : "border border-border hover:bg-surface-2"}`}>{l}</Link>
        ))}
      </nav>
      {(receipts ?? []).length === 0 ? <Empty title="Nenhum recebimento">Importe o XML da NF-e do fornecedor para começar a conferência.</Empty> : (
        <>
        {can(session, "purch.write") && (receipts ?? []).filter((r) => r.status !== "POSTED").length > 1 && (
          <p className="mb-2 text-xs text-muted">Recebeu várias caixas do mesmo pedido, cada uma com a sua NF-e? Marque as notas e toque em <b>Bipar juntas</b>: cada peça entra na nota que ainda precisa dela.</p>
        )}
        <Table head={["Recebimento", "Nota", "Fornecedor", "Emissão", "Total", "Faltas", "Pedido", "Situação"]}
          bulk={can(session, "purch.write") ? [{ label: "Bipar juntas", tone: "primary", href: "/produtos/recebimento/bipar?n={ids}", tag: "bipar" }] : undefined}>
          {(receipts ?? []).map((r) => {
            const d = r.document_id ? dmap.get(r.document_id) : undefined;
            const st = RECEIPT_STATUS[r.status] ?? { label: r.status, tone: "neutral" as const };
            const pg = progress.get(r.id);
            return (
              <tr key={r.id} data-select={r.status !== "POSTED" ? r.id : undefined} data-tags={r.status !== "POSTED" ? "bipar" : undefined}>
                <td className="px-3 py-2"><Link className="font-medium text-brand" href={`/produtos/recebimento/${r.id}`}>{r.number}</Link></td>
                <td className="px-3 py-2">{d ? `${d.number}/${d.series}` : "—"}</td>
                <td className="px-3 py-2">{sname.get(r.supplier_party_id) ?? "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">{d?.issue_at ? fmtDate(d.issue_at.slice(0, 10)) : "—"}</td>
                <td className="px-3 py-2 font-medium">{formatBRL(r.nf_total)}</td>
                <td className="px-3 py-2">{Number(r.shortage_total) > 0 ? <span className="text-warning">{formatBRL(r.shortage_total)}</span> : "—"}</td>
                <td className="px-3 py-2">{r.po_id ? <Link className="text-brand" href={`/produtos/compras/${r.po_id}`}>{psup.get(r.po_id)?.number ?? "ver"}</Link> : "—"}</td>
                <td className="px-3 py-2"><span className="flex items-center gap-2"><Badge tone={st.tone}>{st.label}</Badge>
                  {r.status !== "POSTED" && can(session, "purch.write") && <Link className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-surface-2" href={`/produtos/recebimento/${r.id}/bipar`}><ScanBarcode size={13} /> {pg && pg.counted > 0 && pg.counted < pg.nfe ? "Continuar" : "Bipar"}</Link>}
                  {pg && pg.nfe > 0 && <span className={`text-xs tabular-nums ${pg.counted >= pg.nfe ? "text-success" : "text-muted"}`}>{fmtN(pg.counted)}/{fmtN(pg.nfe)} peças</span>}</span></td>
              </tr>
            );
          })}
        </Table>
        </>
      )}
    </>
  );
}
