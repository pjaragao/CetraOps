import Link from "next/link";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { Badge, Empty, PageHeader, Table } from "@/components/ui";
import { fmtDate } from "@/components/form";

export const metadata = { title: "Notas recebidas" };

/** NF-e de entrada importadas (compras). O download automático pela SEFAZ (MDe) entra com o integrador fiscal. */
export default async function NotasRecebidasPage() {
  await requirePerm("fiscal.read");
  const supabase = await createClient();
  const { data: docs } = await supabase.schema("fiscal").from("documents")
    .select("id, number, series, access_key, issue_at, status, totals, counterpart_name, counterpart_cnpj, operation_nature, receipt_id")
    .eq("direction", "IN").order("issue_at", { ascending: false }).limit(200);
  const rids = (docs ?? []).map((d) => d.receipt_id).filter(Boolean) as string[];
  const { data: receipts } = rids.length ? await supabase.schema("purch").from("receipts").select("id, number, status").in("id", rids) : { data: [] as { id: string; number: string; status: string }[] };
  const rmap = new Map((receipts ?? []).map((r) => [r.id, r]));
  const total = (docs ?? []).reduce((s, d) => s + Number((d.totals as Record<string, number> | null)?.vNF ?? 0), 0);

  return (
    <>
      <PageHeader title="Notas recebidas" description={`NF-e de fornecedores importadas no recebimento — ${(docs ?? []).length} nota(s), ${formatBRL(total)}. Cada nota alimenta estoque, contas a pagar e o pacote do contador.`} />
      {(docs ?? []).length === 0 ? <Empty title="Nenhuma nota recebida">Importe o XML em Produtos › Recebimento de NF-e.</Empty> : (
        <Table head={["Nota", "Emissão", "Fornecedor", "Natureza", "Valor", "Situação", "Recebimento", "Chave"]}>
          {(docs ?? []).map((d) => {
            const r = d.receipt_id ? rmap.get(d.receipt_id) : undefined;
            return (
              <tr key={d.id}>
                <td className="px-3 py-2 font-medium">{d.number}/{d.series}</td>
                <td className="px-3 py-2 whitespace-nowrap">{d.issue_at ? fmtDate(d.issue_at.slice(0, 10)) : "—"}</td>
                <td className="px-3 py-2">{d.counterpart_name}<span className="block text-[11px] text-muted">{d.counterpart_cnpj}</span></td>
                <td className="px-3 py-2">{d.operation_nature ?? "—"}</td>
                <td className="px-3 py-2 font-medium">{formatBRL(Number((d.totals as Record<string, number> | null)?.vNF ?? 0))}</td>
                <td className="px-3 py-2"><Badge tone={d.status === "AUTHORIZED" ? "success" : "neutral"}>{d.status === "AUTHORIZED" ? "autorizada" : d.status.toLowerCase()}</Badge></td>
                <td className="px-3 py-2">{r ? <Link className="text-brand" href={`/produtos/recebimento/${r.id}`}>{r.number}</Link> : "—"}</td>
                <td className="px-3 py-2 font-mono text-[10px] text-muted">{d.access_key}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
