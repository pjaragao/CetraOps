import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { PageHeader, Table } from "@/components/ui";

export const metadata = { title: "Formas de pagamento & taxas" };

export default async function TaxasPage() {
  await requirePerm("fin.read");
  const supabase = await createClient();
  const { data: plans } = await supabase.schema("fin").from("acquirer_fee_plans")
    .select("id, acquirer, method, inst_from, inst_to, anticipation_mode, rate, settlement_days, valid_from")
    .order("acquirer").order("method").order("anticipation_mode").order("inst_from");

  return (
    <>
      <PageHeader title="Formas de pagamento & taxas" description="Tabela real por adquirente × forma × parcelas × antecipação. O PDV usa esta tabela para prever a taxa de cada recebível (auditoria de taxa na conciliação)." />
      <Table head={["Adquirente", "Forma", "Parcelas", "Recebimento", "Taxa", "Prazo", "Vigência"]}>
        {(plans ?? []).map((p) => (
          <tr key={p.id}>
            <td className="px-3 py-1.5">{p.acquirer}</td>
            <td className="px-3 py-1.5">{p.method}</td>
            <td className="px-3 py-1.5">{p.inst_from === p.inst_to ? `${p.inst_from}x` : `${p.inst_from}–${p.inst_to}x`}</td>
            <td className="px-3 py-1.5">{p.anticipation_mode === "D1" ? "Antecipado D+1" : "Fluxo natural"}</td>
            <td className="px-3 py-1.5 font-medium">{String(Number(p.rate).toFixed(2)).replace(".", ",")}%</td>
            <td className="px-3 py-1.5">D+{p.settlement_days}</td>
            <td className="px-3 py-1.5">{p.valid_from.split("-").reverse().join("/")}</td>
          </tr>
        ))}
      </Table>
      <p className="mt-3 text-xs text-muted">Tabela inicial = proposta Stone do plano de negócios. Quando a adquirente for definida (Stone, SIPAG ou Mercado Pago), cadastre a tabela contratada com nova vigência.</p>
    </>
  );
}
