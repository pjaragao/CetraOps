import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { Badge, PageHeader, Table } from "@/components/ui";

export const metadata = { title: "Plano de contas" };

export default async function PlanoDeContasPage() {
  await requirePerm("fin.read");
  const supabase = await createClient();
  const { data: accounts } = await supabase.schema("fin").from("chart_accounts")
    .select("id, code, name, kind, group, accountant_code, dre_lines(name)").is("archived_at", null).order("code");

  return (
    <>
      <PageHeader title="Plano de contas" description="Reclassificado: a licença de espaço do parceiro anfitrião é patrocínio (não aluguel); MDR (despesa de venda) separado da antecipação (financeira). Coluna do contador para o de-para." />
      <Table head={["Código", "Conta", "Tipo", "Grupo", "Linha do DRE", "Cód. contador"]}>
        {(accounts ?? []).map((a) => {
          const depth = a.code.split(".").length - 1;
          return (
            <tr key={a.id} className={a.kind === "SYNTHETIC" ? "bg-surface-2/60 font-medium" : ""}>
              <td className="px-3 py-1.5 font-mono text-xs">{a.code}</td>
              <td className="px-3 py-1.5" style={{ paddingLeft: `${0.75 + depth * 1}rem` }}>{a.name}</td>
              <td className="px-3 py-1.5 text-xs">{a.kind === "SYNTHETIC" ? "sintética" : "analítica"}</td>
              <td className="px-3 py-1.5"><Badge>{a.group}</Badge></td>
              <td className="px-3 py-1.5 text-xs">{a.dre_lines?.name ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono text-xs text-muted">{a.accountant_code ?? ""}</td>
            </tr>
          );
        })}
      </Table>
    </>
  );
}
