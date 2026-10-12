import { notFound } from "next/navigation";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { resolveItems } from "../../../(app)/produtos/compras/options";
import { PrintButtonBar } from "../../print-button-bar";

export const metadata = { title: "Termo da malinha" };

/** Termo de retirada (malinha ou empréstimo para campanha): peças, valores, prazo e assinaturas. */
export default async function TermoMalinha({ params }: { params: Promise<{ id: string }> }) {
  await requirePerm("sales.read");
  const { id } = await params;
  const supabase = await createClient();
  const { data: loan } = await supabase.schema("inv").from("loans").select("id, number, kind, party_id, store_id, purpose, due_at, created_at, notes").eq("id", id).maybeSingle();
  if (!loan) notFound();
  const [{ data: items }, { data: party }, { data: store }] = await Promise.all([
    supabase.schema("inv").from("loan_items").select("variant_id, qty, unit_price").eq("loan_id", id),
    loan.party_id ? supabase.schema("crm").from("parties").select("display_name").eq("id", loan.party_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.schema("core").from("stores").select("name").eq("id", loan.store_id).maybeSingle(),
  ]);
  const labels = new Map((await resolveItems((items ?? []).map((i) => ({ variant_id: i.variant_id, qty: 0, unit_cost: 0 })))).map((l) => [l.variant_id, l]));
  const total = (items ?? []).reduce((a, i) => a + Number(i.qty) * Number(i.unit_price ?? 0), 0);
  const d = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const tryOn = loan.kind === "TRY_ON";

  return (
    <div className="mx-auto max-w-2xl bg-white p-8 text-sm text-black print:p-0">
      <style>{"@page { size: A4; margin: 15mm }"}</style>
      <PrintButtonBar />
      <h1 className="text-lg font-bold">{tryOn ? "Termo de retirada de peças para prova (malinha)" : "Termo de empréstimo de peças para campanha"}</h1>
      <p className="mt-1">{store?.name} · Nº {loan.number} · emitido em {d(loan.created_at)}</p>
      <p className="mt-4">{tryOn ? "Cliente" : "Responsável"}: <b>{party?.display_name ?? "—"}</b>{loan.purpose ? ` · Finalidade: ${loan.purpose}` : ""}</p>
      <table className="mt-4 w-full border-collapse text-sm">
        <thead><tr className="border-b border-black"><th className="py-1 text-left">Peça</th><th className="py-1 text-left">SKU</th><th className="py-1 text-right">Qtd</th><th className="py-1 text-right">Valor unit.</th><th className="py-1 text-right">Total</th></tr></thead>
        <tbody>
          {(items ?? []).map((i) => (
            <tr key={i.variant_id} className="border-b border-neutral-300">
              <td className="py-1">{labels.get(i.variant_id)?.label}</td><td className="py-1 font-mono text-xs">{labels.get(i.variant_id)?.sku}</td>
              <td className="py-1 text-right">{Number(i.qty)}</td><td className="py-1 text-right">{formatBRL(Number(i.unit_price ?? 0))}</td><td className="py-1 text-right">{formatBRL(Number(i.qty) * Number(i.unit_price ?? 0))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={4} className="py-2 text-right font-bold">Valor total das peças</td><td className="py-2 text-right font-bold">{formatBRL(total)}</td></tr></tfoot>
      </table>
      <p className="mt-4">Devolução até <b>{d(loan.due_at)}</b>. {tryOn
        ? "As peças devem voltar nas mesmas condições, com etiquetas. As que ficarem com a cliente serão cobradas pelo valor acima; peças danificadas ou não devolvidas também."
        : "As peças são emprestadas para a finalidade descrita e devem voltar nas mesmas condições; as que não voltarem ou voltarem danificadas poderão ser cobradas pelo valor acima, salvo acordo de permuta registrado."}</p>
      {loan.notes && <p className="mt-2">Observações: {loan.notes}</p>}
      <div className="mt-16 grid grid-cols-2 gap-10 text-center">
        <div className="border-t border-black pt-1">{party?.display_name ?? (tryOn ? "Cliente" : "Responsável")}</div>
        <div className="border-t border-black pt-1">{store?.name}</div>
      </div>
    </div>
  );
}
