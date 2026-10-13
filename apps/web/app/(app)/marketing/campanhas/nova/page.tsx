import Link from "next/link";
import { CAMPAIGN_PRESETS } from "@centralops/domain";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Button, Card, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { startCampaignAction } from "../../actions";

export const metadata = { title: "Nova campanha" };

export default async function NovaCampanhaPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("crm.write");
  const sp = await searchParams;
  return (
    <>
      <PageHeader title="Nova campanha" description="Passo 1 de 5 · Objetivo. Escolha um modelo: ele já preenche público, oferta e lembrete, e tudo continua editável."
        actions={<Link href="/marketing/campanhas" className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Campanhas</Link>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="grid grid-cards gap-3 [--card-min:18rem]">
        {CAMPAIGN_PRESETS.map((p) => (
          <Card key={p.key} title={p.label}>
            <form action={startCampaignAction} className="space-y-3">
              <input type="hidden" name="preset" value={p.key} />
              <p className="text-sm text-muted">{p.description}</p>
              <Field label="Nome da campanha"><input name="name" required minLength={3} maxLength={120} defaultValue={p.label} className={inputClass} /></Field>
              <Button>Usar este modelo</Button>
            </form>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted">Aniversário é automação, não campanha pontual: configure em <Link href="/marketing/reguas" className="text-brand">Réguas</Link>.</p>
    </>
  );
}
