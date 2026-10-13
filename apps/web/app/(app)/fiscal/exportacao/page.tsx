import { monthBounds } from "@centralops/domain";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Button, Card, LinkButton, PageHeader, inputClass } from "@/components/ui";
import { DATASETS } from "./datasets";

export const metadata = { title: "Exportação para o contador" };

function currentMonth(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}`;
}

export default async function ExportacaoPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("fiscal.read");
  const sp = await searchParams;
  const mes = monthBounds(str(sp.mes) ?? "") ? str(sp.mes)! : currentMonth();
  const label = monthBounds(mes)!.label;
  return (
    <>
      <PageHeader title="Exportação para o contador" description="Planilhas do mês (CSV, abre direto no Excel) para enviar ao contador. Valem as mesmas permissões da sua conta: sai só o que você pode ver." />
      <form className="mb-4 flex flex-wrap items-end gap-2" action="/fiscal/exportacao">
        <label className="text-xs text-muted">Mês
          <input type="month" name="mes" defaultValue={mes} className={`${inputClass} mt-1`} />
        </label>
        <Button variant="secondary">Atualizar</Button>
      </form>
      <div className="grid grid-cards gap-3 [--card-min:22rem]">
        {Object.entries(DATASETS).map(([key, d]) => (
          <Card key={key} title={d.title}>
            <p className="mb-3 text-sm text-muted">{d.description}</p>
            <LinkButton href={`/fiscal/exportacao/${key}?mes=${mes}`}>Baixar {label} (CSV)</LinkButton>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted">Os XMLs das notas emitidas continuam disponíveis em Notas emitidas. Cada arquivo traz até 5.000 linhas; para meses maiores, fale com o suporte.</p>
    </>
  );
}
