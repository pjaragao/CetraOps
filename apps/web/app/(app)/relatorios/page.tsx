import Link from "next/link";
import { can, requirePerm } from "@/lib/session";
import { Card, PageHeader } from "@/components/ui";
import { REPORTS } from "./registry";

export const metadata = { title: "Relatórios" };

export default async function RelatoriosPage() {
  const session = await requirePerm("sales.read");
  return (
    <>
      <PageHeader title="Relatórios" description="Consultas prontas para conferir a operação e tomar decisões. Todas aceitam período e baixam em CSV (abre no Excel)." />
      <div className="grid grid-cards gap-3 [--card-min:22rem]">
        {Object.entries(REPORTS).filter(([, r]) => can(session, r.perm)).map(([key, r]) => (
          <Card key={key} title={r.title}>
            <p className="mb-3 text-sm text-muted">{r.description}</p>
            <Link href={`/relatorios/${key}`} className="text-sm font-medium text-brand">Abrir relatório →</Link>
          </Card>
        ))}
      </div>
    </>
  );
}
