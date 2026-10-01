import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { Badge, Button, Card, Empty, PageHeader } from "@/components/ui";
import { toggleAllocationRuleAction } from "../../financeiro/plan-actions";
import { TemplateForm } from "./template-form";
import { METHODS, RuleForm } from "./rule-form";

export const metadata = { title: "Rateios" };

export default async function RateiosPage() {
  await requirePerm("core.admin");
  const supabase = await createClient();
  const [{ data: templates }, { data: lines }, { data: ccs }, { data: rules }] = await Promise.all([
    supabase.schema("fin").from("allocation_templates").select("id, name, description, active").order("name"),
    supabase.schema("fin").from("allocation_template_lines").select("template_id, cost_center_id, pct").order("pct", { ascending: false }),
    supabase.schema("core").from("cost_centers").select("id, code, name").is("archived_at", null).order("code"),
    supabase.schema("fin").from("allocation_rules").select("id, name, method, source_cost_center_id, targets, active, notes").order("created_at"),
  ]);
  const cc = new Map((ccs ?? []).map((c) => [c.id, `${c.code} · ${c.name}`]));

  return (
    <>
      <PageHeader title="Rateios" description="Modelos: divisões prontas de um custo entre centros de custo (ex.: mídia paga 80% digital / 20% balcão). Aparecem ao lançar contas a pagar; juros e multas da baixa seguem a divisão do título." />
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
      <h2 className="mb-1 mt-8 text-lg font-semibold">Rateio por direcionadores (no fechamento)</h2>
      <p className="mb-3 text-sm text-muted">Divide o custo de um centro de origem (ex.: Corporativo) entre lojas e canais na proporção de receita, margem, pedidos, equipe ou área. É aplicado ao fechar o mês como ajuste <b>gerencial</b>: o DRE “com rateio” mostra o resultado após o corporativo; “sem rateio”, a margem da unidade. O razão oficial não muda.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          {(rules ?? []).length === 0 ? <Empty title="Nenhuma regra ainda" /> : (rules ?? []).map((r) => (
            <Card key={r.id} title={r.name} action={<Badge tone={r.active ? "success" : "neutral"}>{r.active ? "ativa" : "pausada"}</Badge>}>
              <p className="text-sm"><span className="text-muted">Base:</span> {METHODS[r.method]?.label ?? r.method} · <span className="text-muted">Origem:</span> {cc.get(r.source_cost_center_id)}</p>
              <ul className="mt-1 text-sm">{((r.targets ?? []) as { cost_center_id: string; pct?: number }[]).map((t) => (
                <li key={t.cost_center_id} className="flex justify-between border-b border-border py-1 last:border-0"><span>{cc.get(t.cost_center_id)}</span>{t.pct != null && <span className="font-medium">{String(t.pct).replace(".", ",")}%</span>}</li>
              ))}</ul>
              <form action={toggleAllocationRuleAction} className="mt-2"><input type="hidden" name="id" value={r.id} /><input type="hidden" name="active" value={r.active ? "0" : "1"} /><Button variant="ghost" className="px-2 py-1 text-xs">{r.active ? "Pausar" : "Reativar"}</Button></form>
            </Card>
          ))}
        </div>
        <Card title="Nova regra"><RuleForm costCenters={(ccs ?? []).map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))} /></Card>
      </div>
    </>
  );
}
