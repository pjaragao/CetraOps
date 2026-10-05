import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, LinkButton, PageHeader, Stat } from "@/components/ui";
import { Field, Flash, fmtDate } from "@/components/form";
import { acceptSuggestionsAction, confirmReceiptAction, countAllAction, discardReceiptAction, postReceiptAction, reverseReceiptAction } from "../../compras/actions";
import { RECEIPT_STATUS } from "../../compras/labels";
import { resolveItems } from "../../compras/options";
import { ConferenceTable, type ConferenceItem } from "./conference";

export const metadata = { title: "Recebimento" };

export default async function RecebimentoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("purch.read");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: rc } = await supabase.schema("purch").from("receipts").select("*").eq("id", id).maybeSingle();
  if (!rc) notFound();

  const [{ data: rows }, { data: doc }, { data: supplier }, { data: loc }, { data: po }] = await Promise.all([
    supabase.schema("purch").from("receipt_items").select("*").eq("receipt_id", id).order("n_item"),
    rc.document_id ? supabase.schema("fiscal").from("documents").select("id, number, series, access_key, issue_at, protocol, totals, operation_nature, counterpart_cnpj").eq("id", rc.document_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.schema("crm").from("parties").select("display_name").eq("id", rc.supplier_party_id).maybeSingle(),
    supabase.schema("inv").from("locations").select("name").eq("id", rc.location_id).maybeSingle(),
    rc.po_id ? supabase.schema("purch").from("purchase_orders").select("id, number").eq("id", rc.po_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const { data: dups } = doc ? await supabase.schema("fiscal").from("document_installments").select("n_dup, due_date, amount").eq("document_id", doc.id).order("due_date") : { data: [] as { n_dup: string | null; due_date: string; amount: number }[] };
  const labels = await resolveItems((rows ?? []).flatMap((r) => (r.variant_id ? [{ variant_id: r.variant_id, qty: 0, unit_cost: 0 }] : [])));
  const lmap = new Map(labels.map((l) => [l.variant_id, l]));
  const items: ConferenceItem[] = (rows ?? []).map((r) => ({
    id: r.id, n_item: r.n_item, cprod: r.supplier_cprod, cean: r.cean, description: r.description, ncm: r.ncm, qty_nfe: Number(r.qty_nfe),
    qty_counted: r.qty_counted == null ? null : Number(r.qty_counted), item_total: Number(r.item_total), landed_unit_cost: r.landed_unit_cost == null ? null : Number(r.landed_unit_cost),
    match_status: r.match_status, match_confidence: r.match_confidence == null ? null : Number(r.match_confidence),
    variant: r.variant_id && lmap.get(r.variant_id) ? { id: r.variant_id, sku: lmap.get(r.variant_id)!.sku, label: lmap.get(r.variant_id)!.label } : null,
  }));

  const st = RECEIPT_STATUS[rc.status] ?? { label: rc.status, tone: "neutral" as const };
  const canWrite = can(session, "purch.write");
  const canApprove = can(session, "purch.approve");
  const editable = canWrite && rc.status !== "POSTED";
  const unmatched = items.filter((i) => !i.variant).length;
  const suggested = items.filter((i) => i.match_status === "SUGGESTED").length;
  const uncounted = items.filter((i) => i.qty_counted == null).length;
  const shortage = items.reduce((s, i) => s + (i.qty_counted != null && i.qty_counted < i.qty_nfe ? Math.round(i.item_total * (i.qty_nfe - i.qty_counted) / i.qty_nfe * 100) / 100 : 0), 0);
  const totals = (doc?.totals ?? {}) as Record<string, number>;

  return (
    <>
      <PageHeader title={`Recebimento ${rc.number}`} description={`NF-e ${doc?.number ?? ""}/${doc?.series ?? ""} · ${supplier?.display_name ?? ""} · entrada em ${loc?.name ?? ""}`}
        actions={<><Badge tone={st.tone}>{st.label}</Badge>{po && <LinkButton href={`/produtos/compras/${po.id}`}>Pedido {po.number}</LinkButton>}<LinkButton href="/produtos/recebimento">Voltar</LinkButton></>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total da nota" value={formatBRL(rc.nf_total)} hint={`emitida em ${doc?.issue_at ? fmtDate(doc.issue_at.slice(0, 10)) : "—"}`} />
        <Stat label="Produtos / frete / desconto" value={formatBRL(totals.vProd ?? 0)} hint={`frete ${formatBRL(totals.vFrete ?? 0)} · desconto ${formatBRL(totals.vDesc ?? 0)}`} />
        <Stat label="Pendências" value={unmatched + suggested + uncounted} tone={unmatched + suggested + uncounted > 0 ? "warning" : "success"} hint={`${unmatched} sem vínculo · ${suggested} sugestão(ões) · ${uncounted} sem contagem`} />
        <Stat label={rc.status === "POSTED" ? "Faltas viraram crédito" : "Faltas apuradas"} value={formatBRL(rc.status === "POSTED" ? rc.shortage_total : shortage)} tone={(rc.status === "POSTED" ? Number(rc.shortage_total) : shortage) > 0 ? "warning" : undefined} hint="abate no pagamento ao fornecedor" />
      </div>

      {editable && (
        <div className="mb-3 flex flex-wrap items-center gap-2" data-print-hide>
          {suggested > 0 && <form action={acceptSuggestionsAction}><input type="hidden" name="receipt_id" value={id} /><Button variant="secondary">Confirmar {suggested} sugestão(ões)</Button></form>}
          {uncounted > 0 && <form action={countAllAction}><input type="hidden" name="receipt_id" value={id} /><Button variant="secondary">Igualar contagem à nota ({uncounted})</Button></form>}
          {rc.status === "PENDING_CHECK" && unmatched + suggested + uncounted === 0 && <form action={confirmReceiptAction}><input type="hidden" name="receipt_id" value={id} /><Button>Confirmar conferência</Button></form>}
          <span className="text-xs text-muted">Conte cada item e digite a quantidade recebida; faltas viram crédito com o fornecedor. Sobras: peça nota complementar.</span>
        </div>
      )}

      <ConferenceTable items={items} editable={editable} />

      {rc.status === "CHECKED" && canApprove && (
        <Card className="mt-4" title="Lançar no estoque e no financeiro">
          <form action={postReceiptAction} className="space-y-3">
            <input type="hidden" name="receipt_id" value={id} />
            <p className="text-sm text-muted">O estoque entra pelo custo de aquisição (frete, seguro, IPI e ST rateados), o contas a pagar nasce das duplicatas e a contabilidade lança estoque × fornecedores. Ajuste os vencimentos se precisar.</p>
            <div className="grid gap-2 sm:grid-cols-4">
              {((dups ?? []).length ? dups! : [{ n_dup: "1", due_date: "", amount: 0 }]).map((d, i) => (
                <div key={i} className="grid grid-cols-2 gap-2 sm:col-span-2">
                  <Field label={`Vencimento ${d.n_dup ?? i + 1}`}><input type="date" name="due_date" defaultValue={d.due_date} className={inputClass} /></Field>
                  <Field label="Valor (R$)"><input name="amount" inputMode="decimal" defaultValue={d.amount ? String(d.amount).replace(".", ",") : ""} className={inputClass} /></Field>
                </div>
              ))}
            </div>
            {(dups ?? []).length === 0 && <p className="text-xs text-muted">A nota não trouxe duplicatas: deixando em branco, vale a condição do pedido ou 30 dias da emissão.</p>}
            <Button>Lançar recebimento</Button>
          </form>
        </Card>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2" data-print-hide>
        <Card title="Nota fiscal">
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-muted">Chave</dt><dd className="break-all font-mono text-xs">{doc?.access_key}</dd>
            <dt className="text-muted">Protocolo</dt><dd>{doc?.protocol ?? "—"}</dd>
            <dt className="text-muted">Natureza</dt><dd>{doc?.operation_nature ?? "—"}</dd>
            <dt className="text-muted">Fornecedor</dt><dd>{supplier?.display_name} <span className="text-xs text-muted">{doc?.counterpart_cnpj}</span></dd>
          </dl>
          {rc.title_id && <p className="mt-3 text-sm">Título a pagar gerado — <Link className="text-brand" href="/financeiro/pagar">ver em Contas a pagar</Link>.</p>}
        </Card>
        {rc.status === "POSTED" && canApprove ? (
          <Card title="Estornar recebimento">
            <form action={reverseReceiptAction} className="flex flex-wrap items-end gap-2"><input type="hidden" name="receipt_id" value={id} />
              <Field label="Motivo"><input name="reason" required className={`${inputClass} w-64`} placeholder="Ex.: contagem errada" /></Field><Button variant="danger">Estornar</Button></form>
            <p className="mt-2 text-xs text-muted">Compensa o estoque, cancela o título e a contabilidade e devolve a nota para conferência. Não é possível se já houver pagamento (estorne a baixa antes).</p>
          </Card>
        ) : canWrite && rc.status !== "POSTED" ? (
          <Card title="Descartar">
            <form action={discardReceiptAction}><input type="hidden" name="receipt_id" value={id} /><Button variant="danger">Descartar recebimento</Button></form>
            <p className="mt-2 text-xs text-muted">Remove a nota importada (nada foi lançado). Depois é possível importar o mesmo XML de novo.</p>
          </Card>
        ) : null}
      </div>
    </>
  );
}
