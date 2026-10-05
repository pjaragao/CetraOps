import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { budgetStatusAction, importBudgetCsvAction } from "../plan-actions";
import { BudgetGrid, type BudgetAccount } from "./budget-grid";

export const metadata = { title: "Orçamento" };

const SCENARIO: Record<string, string> = { BASE: "Base", OPTIMISTIC: "Otimista", PESSIMISTIC: "Pessimista" };
const STATUS: Record<string, { label: string; tone: "neutral" | "success" | "warning" }> = { DRAFT: { label: "rascunho", tone: "warning" }, APPROVED: { label: "aprovado", tone: "success" }, ARCHIVED: { label: "arquivado", tone: "neutral" } };

/** Orçado × realizado: verde dentro do orçamento, amarelo até 5% de desvio, vermelho acima. */
function farol(nature: string, budget: number, actual: number) {
  if (budget === 0 && actual === 0) return { tone: "neutral" as const, label: "—" };
  if (nature === "CREDIT") { const r = budget ? actual / budget : 1; return r >= 1 ? { tone: "success" as const, label: "ok" } : r >= 0.95 ? { tone: "warning" as const, label: "atenção" } : { tone: "danger" as const, label: "abaixo" }; }
  const r = budget ? actual / budget : Infinity;
  return r <= 1 ? { tone: "success" as const, label: "ok" } : r <= 1.05 ? { tone: "warning" as const, label: "atenção" } : { tone: "danger" as const, label: budget ? "estourou" : "sem orçamento" };
}

export default async function OrcamentoPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fin.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const year = Number(str(sp.ano)) || Number(todayIsoSP().slice(0, 4));
  const { data: entities } = await supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia").order("razao_social");
  const entity = str(sp.empresa) ?? entities?.[0]?.id;
  if (!entity) return (<><PageHeader title="Orçamento" /><Empty title="Cadastre a empresa em Configurações" /></>);
  const canApprove = can(session, "fin.approve");

  const [{ data: budgets }, { data: accounts }] = await Promise.all([
    supabase.schema("fin").from("budgets").select("id, name, version, scenario, status, year").eq("legal_entity_id", entity).eq("year", year).order("scenario").order("version", { ascending: false }),
    supabase.schema("fin").from("chart_accounts").select("id, code, name, group, nature").eq("kind", "ANALYTIC").in("group", ["REVENUE", "DEDUCTION", "COGS", "EXPENSE", "FINANCIAL"]).order("code"),
  ]);
  const accs: BudgetAccount[] = (accounts ?? []).map((a) => ({ id: a.id, code: a.code, name: a.name, grp: a.group, nature: a.nature }));
  const selected = (budgets ?? []).find((b) => b.id === str(sp.orc)) ?? (budgets ?? [])[0];
  const novo = str(sp.novo) === "1";

  const today = todayIsoSP();
  const isCurrent = year === Number(today.slice(0, 4));
  const vista = str(sp.vista) ?? "ano";
  const from = vista === "mes" && isCurrent ? `${today.slice(0, 7)}-01` : `${year}-01-01`;
  const to = vista === "mes" && isCurrent ? today : isCurrent ? today : `${year}-12-31`;

  let grid: Record<string, number[]> = {};
  let compare: { account_id: string; code: string; name: string; grp: string; budget: number; actual: number }[] = [];
  if (selected && !novo) {
    const [{ data: lines }, { data: cmp }] = await Promise.all([
      supabase.schema("fin").from("budget_lines").select("chart_account_id, month, amount").eq("budget_id", selected.id),
      supabase.schema("fin").rpc("budget_vs_actual", { p_budget: selected.id, p_from: from, p_to: to }),
    ]);
    for (const l of lines ?? []) { grid[l.chart_account_id] ??= Array(12).fill(0); grid[l.chart_account_id][Number(l.month.slice(5, 7)) - 1] = Number(l.amount); }
    compare = (cmp ?? []).map((c) => ({ account_id: c.account_id, code: c.code, name: c.name, grp: c.grp, budget: Number(c.budget), actual: Number(c.actual) }));
  } else grid = {};
  const nature = new Map(accs.map((a) => [a.id, a.nature]));
  const sum = (g: string[], k: "budget" | "actual") => compare.filter((c) => g.includes(c.grp)).reduce((s, c) => s + c[k], 0);
  const resBudget = sum(["REVENUE"], "budget") - sum(["DEDUCTION", "COGS", "EXPENSE", "FINANCIAL"], "budget");
  const resActual = sum(["REVENUE"], "actual") - sum(["DEDUCTION", "COGS", "EXPENSE", "FINANCIAL"], "actual");
  const q = (extra: Record<string, string>) => `/financeiro/orcamento?${new URLSearchParams({ ano: String(year), empresa: entity, ...extra }).toString()}`;

  return (
    <>
      <PageHeader title="Orçamento" description="Metas por conta e mês, com versões e cenários. O realizado vem do razão contábil; o farol avisa o desvio."
        actions={<form className="flex items-end gap-2"><input type="hidden" name="empresa" value={entity} /><Field label="Ano"><input name="ano" type="number" defaultValue={year} min={2020} max={2100} className={`${inputClass} w-24`} /></Field><Button variant="secondary">Ver</Button></form>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {(budgets ?? []).map((b) => (
          <Link key={b.id} href={q({ orc: b.id })} className={`rounded-full px-3 py-1 ${selected?.id === b.id && !novo ? "bg-brand text-brand-contrast" : "border border-border hover:bg-surface-2"}`}>
            {SCENARIO[b.scenario]} v{b.version} <span className="opacity-70">· {STATUS[b.status]?.label}</span>
          </Link>
        ))}
        {can(session, "fin.approve") && <Link href={q({ novo: "1" })} className="rounded-full border border-dashed border-border px-3 py-1 hover:bg-surface-2">+ Novo orçamento</Link>}
      </div>

      {novo || !selected ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            {canApprove ? <Card title={`Novo orçamento ${year}`}><BudgetGrid key={`new-${year}`} accounts={accs} initial={{}} legalEntityId={entity} year={year} name={`Orçamento ${year}`} scenario="BASE" editable /></Card>
              : <Empty title="Sem orçamento neste ano" />}
          </div>
          {canApprove && (
            <Card title="Importar de planilha (CSV)">
              <form action={importBudgetCsvAction} encType="multipart/form-data" className="space-y-2">
                <input type="hidden" name="legal_entity_id" value={entity} /><input type="hidden" name="year" value={year} />
                <input type="file" name="file" accept=".csv,text/csv" required className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-surface-2 file:px-2 file:py-1`} />
                <Button variant="secondary">Importar</Button>
              </form>
              <p className="mt-2 text-xs text-muted">Uma linha por conta: código do plano na 1ª coluna e os 12 meses nas seguintes (separador ; ou ,). Exporte do Excel como CSV. Cria uma nova versão do cenário base.</p>
            </Card>
          )}
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone={STATUS[selected.status]?.tone}>{STATUS[selected.status]?.label}</Badge>
            <nav className="flex gap-1 text-sm" aria-label="Período da comparação">
              {[["ano", isCurrent ? "Ano até hoje" : "Ano todo"], ["mes", "Mês atual"]].map(([v, l]) => (
                <Link key={v} href={q({ orc: selected.id, vista: v })} className={`rounded-full px-3 py-1 ${vista === v ? "bg-brand text-brand-contrast" : "border border-border hover:bg-surface-2"}`}>{l}</Link>
              ))}
            </nav>
            {canApprove && selected.status === "DRAFT" && <form action={budgetStatusAction}><input type="hidden" name="budget_id" value={selected.id} /><input type="hidden" name="year" value={year} /><input type="hidden" name="status" value="APPROVED" /><Button variant="secondary" className="px-2 py-1 text-xs">Aprovar orçamento</Button></form>}
            {canApprove && selected.status === "APPROVED" && <form action={budgetStatusAction}><input type="hidden" name="budget_id" value={selected.id} /><input type="hidden" name="year" value={year} /><input type="hidden" name="status" value="ARCHIVED" /><Button variant="ghost" className="px-2 py-1 text-xs">Arquivar</Button></form>}
          </div>
          <Card title={`Orçado × realizado · ${from.split("-").reverse().join("/")} a ${to.split("-").reverse().join("/")}`}>
            {compare.length === 0 ? <p className="text-sm text-muted">Sem valores no período.</p> : (
              <Table head={["Conta", "Orçado", "Realizado", "Diferença", "%", "Farol"]}>
                {compare.map((c) => {
                  const f = farol(nature.get(c.account_id) ?? "DEBIT", c.budget, c.actual);
                  const diff = c.actual - c.budget;
                  return (
                    <tr key={c.account_id}>
                      <td className="px-3 py-1.5"><span className="font-mono text-xs text-muted">{c.code}</span> {c.name}</td>
                      <td className="px-3 py-1.5">{formatBRL(c.budget)}</td><td className="px-3 py-1.5">{formatBRL(c.actual)}</td>
                      <td className="px-3 py-1.5">{formatBRL(diff)}</td><td className="px-3 py-1.5">{c.budget ? `${Math.round((c.actual / c.budget) * 100)}%` : "—"}</td>
                      <td className="px-3 py-1.5"><Badge tone={f.tone}>{f.label}</Badge></td>
                    </tr>
                  );
                })}
                <tr className="bg-surface-2 font-medium"><td className="px-3 py-2">Resultado</td><td className="px-3 py-2">{formatBRL(resBudget)}</td><td className="px-3 py-2">{formatBRL(resActual)}</td><td className="px-3 py-2">{formatBRL(resActual - resBudget)}</td><td colSpan={2} /></tr>
              </Table>
            )}
          </Card>
          <Card className="mt-4" title="Grade do orçamento (valores mensais)">
            <BudgetGrid key={selected.id} accounts={accs} initial={grid} budgetId={selected.id} legalEntityId={entity} year={year} name={selected.name} scenario={selected.scenario} editable={canApprove && selected.status === "DRAFT"} />
            {selected.status !== "DRAFT" && <p className="mt-2 text-xs text-muted">Orçamento aprovado é somente leitura. Crie uma nova versão para ajustar.</p>}
          </Card>
        </>
      )}
    </>
  );
}
