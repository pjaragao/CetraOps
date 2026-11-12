import "server-only";
import { createClient } from "@/lib/supabase/server";
import { photoUrl } from "@/lib/photos";
import type { Sibling } from "./join-panel";
import type { GroupNote, NoteSummary, ScanItem } from "./types";

/** Itens da nota (ou das notas bipadas juntas, na ordem em que foram passadas) com a peça ligada (SKU, nome · cor · tamanho) e a foto da cor. */
export async function loadScanItems(receiptIds: string | string[]): Promise<ScanItem[]> {
  const ids = Array.isArray(receiptIds) ? receiptIds : [receiptIds];
  const supabase = await createClient();
  const { data: raw } = await supabase.schema("purch").from("receipt_items")
    .select("id, receipt_id, n_item, description, supplier_cprod, cean, qty_nfe, qty_counted, item_total, variant_id").in("receipt_id", ids).order("n_item");
  const rows = (raw ?? []).slice().sort((a, b) => ids.indexOf(a.receipt_id) - ids.indexOf(b.receipt_id) || a.n_item - b.n_item);
  const varIds = [...new Set(rows.map((r) => r.variant_id).filter(Boolean) as string[])];
  const { data: variants } = varIds.length
    ? await supabase.schema("catalog").from("variants").select("id, sku, size, product_id, color_id").in("id", varIds)
    : { data: [] as { id: string; sku: string; size: string; product_id: string; color_id: string | null }[] };
  const prodIds = [...new Set((variants ?? []).map((v) => v.product_id))];
  const [{ data: products }, { data: colors }, { data: media }] = await Promise.all([
    prodIds.length ? supabase.schema("catalog").from("products").select("id, name").in("id", prodIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    supabase.schema("catalog").from("colors").select("id, name"),
    prodIds.length
      ? supabase.schema("catalog").from("product_media").select("product_id, color_id, storage_path, position").in("product_id", prodIds).order("position")
      : Promise.resolve({ data: [] as { product_id: string; color_id: string | null; storage_path: string; position: number }[] }),
  ]);
  const vmap = new Map((variants ?? []).map((v) => [v.id, v]));
  const pname = new Map((products ?? []).map((p) => [p.id, p.name]));
  const cname = new Map((colors ?? []).map((c) => [c.id, c.name]));
  const photoOf = (productId: string, colorId: string | null) => {
    const m = (media ?? []).find((x) => x.product_id === productId && x.color_id === colorId) ?? (media ?? []).find((x) => x.product_id === productId);
    return m ? photoUrl(m.storage_path, 160) : null;
  };
  return rows.map((r) => {
    const v = r.variant_id ? vmap.get(r.variant_id) : undefined;
    return {
      id: r.id, receipt_id: r.receipt_id, n_item: r.n_item, description: r.description ?? "", cprod: r.supplier_cprod, cean: r.cean,
      qty_nfe: Number(r.qty_nfe), qty_counted: Number(r.qty_counted ?? 0), item_total: Number(r.item_total), variant_id: r.variant_id,
      sku: v?.sku ?? null,
      label: v ? [pname.get(v.product_id), v.color_id ? cname.get(v.color_id) : null, v.size].filter(Boolean).join(" · ") : null,
      photo: v ? photoOf(v.product_id, v.color_id) : null,
    };
  });
}

const fmtCnpj = (c: string | null) => (c && /^\d{14}$/.test(c) ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : c);
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Resumo de cada recebimento (cabeçalho da tela), na ordem do número da NF-e. Notas que não existem ficam de fora. */
export async function loadNotes(receiptIds: string[]): Promise<GroupNote[]> {
  const supabase = await createClient();
  const { data: rcs } = await supabase.schema("purch").from("receipts").select("id, number, status, nf_total, document_id, supplier_party_id, location_id").in("id", receiptIds);
  if (!rcs?.length) return [];
  const docIds = rcs.map((r) => r.document_id).filter(Boolean) as string[];
  const [{ data: docs }, { data: sups }, { data: locs }] = await Promise.all([
    docIds.length ? supabase.schema("fiscal").from("documents").select("id, number, series, issue_at, totals, counterpart_cnpj").in("id", docIds) : Promise.resolve({ data: [] as never[] }),
    supabase.schema("crm").from("parties").select("id, display_name").in("id", [...new Set(rcs.map((r) => r.supplier_party_id))]),
    supabase.schema("inv").from("locations").select("id, name").in("id", [...new Set(rcs.map((r) => r.location_id))]),
  ]);
  const dmap = new Map((docs ?? []).map((d) => [d.id, d]));
  const notes = rcs.map((rc) => {
    const doc = rc.document_id ? dmap.get(rc.document_id) : undefined;
    const totals = (doc?.totals ?? {}) as Record<string, number>;
    const note: GroupNote = {
      id: rc.id, receiptNumber: rc.number, status: rc.status,
      nfNumber: doc ? `${doc.number ?? ""}${doc.series != null ? `/${doc.series}` : ""}` : "—",
      issueAt: doc?.issue_at ? dmy(doc.issue_at) : null,
      supplier: (sups ?? []).find((x) => x.id === rc.supplier_party_id)?.display_name ?? "Fornecedor", supplierCnpj: fmtCnpj(doc?.counterpart_cnpj ?? null),
      location: (locs ?? []).find((x) => x.id === rc.location_id)?.name ?? "—",
      nfTotal: Number(rc.nf_total), vProd: Number(totals.vProd ?? 0), vFrete: Number(totals.vFrete ?? 0), vDesc: Number(totals.vDesc ?? 0),
    };
    return { n: Number(doc?.number ?? 0), note };
  });
  return notes.sort((a, b) => a.n - b.n).map((x) => x.note);
}

/** Cabeçalho único das notas juntas: soma os valores e junta os números (a lista por nota vem à parte). */
export function mergeSummary(notes: NoteSummary[]): NoteSummary {
  if (notes.length === 1) return notes[0];
  const uniq = (xs: string[]) => [...new Set(xs)];
  const sups = uniq(notes.map((n) => n.supplier));
  return {
    receiptNumber: notes.map((n) => n.receiptNumber).join(" + "),
    status: notes.every((n) => n.status === "POSTED") ? "POSTED" : "PENDING_CHECK",
    nfNumber: notes.map((n) => n.nfNumber.split("/")[0]).join(" + "),
    issueAt: null,
    supplier: sups.length === 1 ? sups[0] : `${sups[0]} e outros`,
    supplierCnpj: uniq(notes.map((n) => n.supplierCnpj ?? "")).length === 1 ? notes[0].supplierCnpj : null,
    location: uniq(notes.map((n) => n.location)).length === 1 ? notes[0].location : "locais diferentes",
    nfTotal: notes.reduce((s, n) => s + n.nfTotal, 0), vProd: notes.reduce((s, n) => s + n.vProd, 0),
    vFrete: notes.reduce((s, n) => s + n.vFrete, 0), vDesc: notes.reduce((s, n) => s + n.vDesc, 0),
  };
}

/** Outras notas em aberto do mesmo fornecedor: dá para bipar junto (três caixas do mesmo pedido, cada uma com a sua NF-e). */
export async function loadSiblings(id: string): Promise<Sibling[]> {
  const supabase = await createClient();
  const { data: rc } = await supabase.schema("purch").from("receipts").select("supplier_party_id").eq("id", id).maybeSingle();
  if (!rc) return [];
  const { data: others } = await supabase.schema("purch").from("receipts").select("id, number, nf_total, document_id")
    .eq("supplier_party_id", rc.supplier_party_id).neq("status", "POSTED").neq("id", id).order("created_at", { ascending: false }).limit(30);
  if (!others?.length) return [];
  const docIds = others.map((o) => o.document_id).filter(Boolean) as string[];
  const [{ data: docs }, { data: its }] = await Promise.all([
    docIds.length ? supabase.schema("fiscal").from("documents").select("id, number, series, issue_at").in("id", docIds) : Promise.resolve({ data: [] as never[] }),
    supabase.schema("purch").from("receipt_items").select("receipt_id, qty_nfe, qty_counted").in("receipt_id", others.map((o) => o.id)),
  ]);
  return others.map((o) => {
    const d = (docs ?? []).find((x) => x.id === o.document_id);
    const mine = (its ?? []).filter((i) => i.receipt_id === o.id);
    return {
      id: o.id, nf: d ? `${d.number ?? ""}${d.series != null ? `/${d.series}` : ""}` : "—", receiptNumber: o.number, total: Number(o.nf_total),
      issueAt: d?.issue_at ? `${d.issue_at.slice(8, 10)}/${d.issue_at.slice(5, 7)}/${d.issue_at.slice(0, 4)}` : null,
      pieces: mine.reduce((s, i) => s + Number(i.qty_nfe), 0), counted: mine.reduce((s, i) => s + Math.min(Number(i.qty_counted ?? 0), Number(i.qty_nfe)), 0),
    };
  });
}
