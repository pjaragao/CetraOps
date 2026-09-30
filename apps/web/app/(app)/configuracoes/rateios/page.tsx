import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { Card, Empty, PageHeader } from "@/components/ui";
import { TemplateForm } from "./template-form";

export const metadata = { title: "Modelos de rateio" };

export default async function RateiosPage() {
  await requirePerm("core.admin");
  const supabase = await createClient();
  const [{ data: templates }, { data: lines }, { data: ccs }] = await Promise.all([
    supabase.schema("fin").from("allocation_templates").select("id, name, description, active").order("name"),
    supabase.schema("fin").from("allocation_template_lines").select("template_id, cost_center_id, pct").order("pct", { ascending: false }),
    supabase.schema("core").from("cost_centers").select("id, code, name").is("archived_at", null).order("code"),
  ]);
  const cc = new Map((ccs ?? []).map((c) => [c.id, `${c.code} · ${c.name}`]));

  return (
    <>
      <PageHeader title="Modelos de rateio" description="Divisões prontas de um custo entre centros de custo (ex.: mídia paga 80% digital / 20% balcão). Aparecem ao lançar contas a pagar; juros e multas da baixa seguem a divisão do título." />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          {(templates ?? []).length === 0 ? <Empty title="Nenhum modelo ainda" /> : (templates ?? []).map((t) => (
            <Card key={t.id} title={t.name}>
              {t.description && <p className="mb-2 text-sm text-muted">{t.description}</p>}
              <ul className="text-sm">{(lines ?? []).filter((l) => l.template_id === t.id).map((l) => (
                <li key={l.cost_center_id} className="flex justify-between border-b border-border py-1 last:border-0"><span>{cc.get(l.cost_center_id)}</span><span className="font-medium">{String(l.pct).replace(".", ",")}%</span></li>
              ))}</ul>
            </Card>
          ))}
        </div>
        <Card title="Novo modelo"><TemplateForm costCenters={(ccs ?? []).map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))} /></Card>
      </div>
      <p className="mt-4 text-xs text-muted">Rateio por direcionadores mensais (receita, pedidos, equipe, área) do custo corporativo será aplicado no fechamento do mês, gerando ajustes gerenciais no DRE.</p>
    </>
  );
}
