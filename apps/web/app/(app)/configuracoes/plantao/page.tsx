import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { Badge, Card, Empty, PageHeader, Table } from "@/components/ui";

export const metadata = { title: "Plantão do sistema" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

/** O que está quebrado agora (core.ops_status), com a causa provável. O plantão das 08:10 manda o mesmo resumo pelo sino. */
export default async function PlantaoPage() {
  await requirePerm("core.admin");
  const supabase = await createClient();
  const { data, error } = await supabase.schema("core").rpc("ops_status");
  const rows = data ?? [];

  return (
    <>
      <PageHeader title="Plantão do sistema"
        description="Integrações, filas, rotinas agendadas e IA que estão falhando agora. Todo dia às 08:10 o plantão fecha sozinho os avisos que já se resolveram e manda um resumo só." />
      {error ? <Card><p className="text-sm text-danger">Não foi possível ler o plantão: {error.message}</p></Card>
        : rows.length === 0 ? <Empty title="Nada quebrado agora">Integrações, filas, rotinas agendadas e IA sem falhas nas últimas 24 horas.</Empty>
        : (
          <Card title={`${rows.length} problema(s) em aberto`}>
            <Table head={["Onde", "O quê", "Detalhe", "Causa provável", "Desde"]} noSort={[2, 3]}>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="px-3 py-2 whitespace-nowrap"><Badge tone={r.area === "Integração" || r.area === "Fila com falhas" ? "danger" : "warning"}>{r.area}</Badge></td>
                  <td className="px-3 py-2">{r.href ? <Link href={r.href} className="text-brand hover:underline">{r.item}</Link> : <span className="font-mono text-xs">{r.item}</span>}</td>
                  <td className="px-3 py-2 text-sm">{r.detail}</td>
                  <td className="px-3 py-2 text-sm text-muted">{r.cause ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-sm">{when(r.since)}</td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
    </>
  );
}
