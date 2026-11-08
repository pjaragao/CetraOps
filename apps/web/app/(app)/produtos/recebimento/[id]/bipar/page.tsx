import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { fmtDate } from "@/components/form";
import { loadScanItems } from "./data";
import { ReceiveScanner } from "./receive-scanner";
import type { NoteSummary } from "./types";

export const metadata = { title: "Bipar entrada" };

const fmtCnpj = (c: string | null) => (c && /^\d{14}$/.test(c) ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : c);

/** Entrada de mercadoria pelo leitor: câmera do celular (ou leitor USB/Bluetooth) somando cada peça no item da NF-e. */
export default async function BiparRecebimentoPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePerm("purch.read");
  const { id } = await params;
  const supabase = await createClient();
  const { data: rc } = await supabase.schema("purch").from("receipts").select("id, number, status, nf_total, document_id, supplier_party_id, location_id").eq("id", id).maybeSingle();
  if (!rc) notFound();
  const [{ data: doc }, { data: supplier }, { data: loc }, items] = await Promise.all([
    rc.document_id ? supabase.schema("fiscal").from("documents").select("number, series, issue_at, totals, counterpart_cnpj").eq("id", rc.document_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.schema("crm").from("parties").select("display_name").eq("id", rc.supplier_party_id).maybeSingle(),
    supabase.schema("inv").from("locations").select("name").eq("id", rc.location_id).maybeSingle(),
    loadScanItems(id),
  ]);
  const totals = (doc?.totals ?? {}) as Record<string, number>;
  const summary: NoteSummary = {
    receiptNumber: rc.number, status: rc.status,
    nfNumber: doc ? `${doc.number ?? ""}${doc.series != null ? `/${doc.series}` : ""}` : "—",
    issueAt: doc?.issue_at ? fmtDate(doc.issue_at.slice(0, 10)) : null,
    supplier: supplier?.display_name ?? "Fornecedor", supplierCnpj: fmtCnpj(doc?.counterpart_cnpj ?? null), location: loc?.name ?? "—",
    nfTotal: Number(rc.nf_total), vProd: Number(totals.vProd ?? 0), vFrete: Number(totals.vFrete ?? 0), vDesc: Number(totals.vDesc ?? 0),
  };
  return <ReceiveScanner receiptId={id} summary={summary} initialItems={items} editable={can(session, "purch.write")} />;
}
