import { notFound } from "next/navigation";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { resolveItems } from "../../../(app)/produtos/compras/options";
import { PrintButtonBar } from "../../print-button-bar";

export const metadata = { title: "Comprovante" };

const METHOD: Record<string, string> = { CASH: "Dinheiro", CREDIT: "Crédito", DEBIT: "Débito", PIX: "Pix", PAYMENT_LINK: "Link de pagamento", BOLETO: "Boleto", STORE_CREDIT: "Vale-troca", PERMUTA: "Permuta" };

/** Comprovante de venda (não fiscal) para impressora térmica de 80 mm. Com NFC-e autorizada, traz a chave e o link do DANFE. */
export default async function Comprovante({ params }: { params: Promise<{ id: string }> }) {
  await requirePerm("sales.read");
  const { id } = await params;
  const supabase = await createClient();
  const { data: o } = await supabase.schema("sales").from("orders").select("id, number, store_id, party_id, created_at, subtotal, discount_total, shipping_total, total, status").eq("id", id).maybeSingle();
  if (!o) notFound();
  const [{ data: items }, { data: pays }, { data: store }, { data: party }, { data: doc }] = await Promise.all([
    supabase.schema("sales").from("order_items").select("variant_id, description, qty, list_price, discount_amount, total").eq("order_id", id).order("line_no"),
    supabase.schema("sales").from("payments").select("method, amount, installments, status").eq("order_id", id).in("status", ["AUTHORIZED", "CAPTURED"]),
    supabase.schema("core").from("stores").select("name, legal_entity_id").eq("id", o.store_id).maybeSingle(),
    o.party_id ? supabase.schema("crm").from("parties").select("display_name").eq("id", o.party_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.schema("sales").rpc("get_order_fiscal_doc", { p_order: id }),
  ]);
  const { data: le } = store?.legal_entity_id ? await supabase.schema("core").from("legal_entities").select("razao_social, nome_fantasia, cnpj").eq("id", store.legal_entity_id).maybeSingle() : { data: null };
  const labels = new Map((await resolveItems((items ?? []).flatMap((i) => (i.variant_id ? [{ variant_id: i.variant_id, qty: 0, unit_cost: 0 }] : [])))).map((l) => [l.variant_id, l]));
  const fiscal = doc as { status?: string; number?: number; series?: number; access_key?: string | null; danfe_path?: string | null; consult_url?: string | null } | null;
  const consult = fiscal?.consult_url ? fiscal.consult_url.split("?")[0] : /^https?:\/\//.test(fiscal?.danfe_path ?? "") ? fiscal?.danfe_path : null;
  const cnpj = (le?.cnpj ?? "").replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

  return (
    <div className="mx-auto bg-white p-2 text-black" style={{ width: "76mm", fontFamily: "Arial, sans-serif", fontSize: "9pt" }}>
      <style>{"@page { size: 80mm auto; margin: 2mm } @media print { body { margin: 0 } }"}</style>
      <PrintButtonBar />
      <div className="text-center">
        <p className="font-bold">{le?.nome_fantasia ?? store?.name}</p>
        {le && <p style={{ fontSize: "7.5pt" }}>{le.razao_social}<br />CNPJ {cnpj}</p>}
        <p className="mt-1" style={{ fontSize: "8pt" }}>COMPROVANTE DE VENDA · NÃO É DOCUMENTO FISCAL</p>
        <p style={{ fontSize: "8pt" }}>Pedido {o.number} · {new Date(o.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}</p>
        {party && <p style={{ fontSize: "8pt" }}>Cliente: {party.display_name}</p>}
      </div>
      <hr className="my-1 border-dashed border-black" />
      {(items ?? []).map((i, n) => (
        <div key={n} className="py-0.5">
          <div>{i.variant_id ? labels.get(i.variant_id)?.label : i.description ?? "Item avulso"}</div>
          <div className="flex justify-between" style={{ fontSize: "8pt" }}>
            <span>{Number(i.qty)} × {formatBRL(i.list_price)}{Number(i.discount_amount) > 0 ? ` − ${formatBRL(i.discount_amount)}` : ""}</span><span>{formatBRL(i.total)}</span>
          </div>
        </div>
      ))}
      <hr className="my-1 border-dashed border-black" />
      {Number(o.discount_total) > 0 && <div className="flex justify-between"><span>Descontos</span><span>− {formatBRL(o.discount_total)}</span></div>}
      {Number(o.shipping_total) > 0 && <div className="flex justify-between"><span>Entrega</span><span>{formatBRL(o.shipping_total)}</span></div>}
      <div className="flex justify-between font-bold" style={{ fontSize: "11pt" }}><span>TOTAL</span><span>{formatBRL(o.total)}</span></div>
      {(pays ?? []).map((p, n) => <div key={n} className="flex justify-between"><span>{METHOD[p.method] ?? p.method}{p.installments > 1 ? ` ${p.installments}x` : ""}</span><span>{formatBRL(p.amount)}</span></div>)}
      <hr className="my-1 border-dashed border-black" />
      {fiscal?.status === "AUTHORIZED" ? (
        <div className="text-center" style={{ fontSize: "7.5pt" }}>
          <p>NFC-e nº {fiscal.number} série {fiscal.series}</p>
          {fiscal.access_key && <p className="break-all">Chave: {fiscal.access_key.replace(/(\d{4})/g, "$1 ").trim()}</p>}
          {consult && <p className="break-all">Consulte: {consult}</p>}
        </div>
      ) : <p className="text-center" style={{ fontSize: "7.5pt" }}>A nota fiscal (NFC-e) é enviada à parte quando autorizada.</p>}
      <p className="mt-2 text-center" style={{ fontSize: "8pt" }}>Trocas em até 30 dias com etiqueta e este comprovante. Obrigada!</p>
    </div>
  );
}
