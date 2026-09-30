import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { Card, PageHeader, Stat, Table } from "@/components/ui";

export const metadata = { title: "Apuração do Simples" };

/**
 * Estimativa do DAS (Anexo I) com RBT12. No início de atividade (LC 123, art. 18 §2º):
 * 1º mês → receita do mês × 12; meses seguintes (< 12) → média dos meses anteriores × 12.
 */
export default async function FiscalPage() {
  await requirePerm("fiscal.read");
  const supabase = await createClient();
  const now = new Date();
  const start12 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1)).toISOString();

  const [{ data: orders }, { data: brackets }] = await Promise.all([
    supabase.schema("sales").from("orders").select("total, created_at, legal_entity_id")
      .in("status", ["PAID", "COMPLETED", "FULFILLING", "READY_FOR_PICKUP", "SHIPPED"]).gte("created_at", start12),
    supabase.schema("fiscal").from("simples_brackets").select("bracket, max_rbt12, nominal_rate, deduction").eq("annex", "I").order("bracket"),
  ]);

  const monthKey = (d: string) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 7);
  const current = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 7);
  const byMonth = new Map<string, number>();
  for (const o of orders ?? []) byMonth.set(monthKey(o.created_at), (byMonth.get(monthKey(o.created_at)) ?? 0) + Number(o.total));
  const previous = [...byMonth.entries()].filter(([m]) => m < current).sort();
  const currentRevenue = byMonth.get(current) ?? 0;

  let rbt12: number; let method: string;
  if (previous.length === 0) { rbt12 = currentRevenue * 12; method = "Início de atividade: receita do mês × 12"; }
  else if (previous.length < 12) { rbt12 = (previous.reduce((a, [, v]) => a + v, 0) / previous.length) * 12; method = `Início de atividade: média de ${previous.length} mês(es) × 12`; }
  else { rbt12 = previous.slice(-12).reduce((a, [, v]) => a + v, 0); method = "Receita bruta dos últimos 12 meses"; }

  const b = (brackets ?? []).find((x) => rbt12 <= Number(x.max_rbt12)) ?? brackets?.[brackets.length - 1];
  const effective = !b ? 0 : rbt12 <= 0 ? Number(b.nominal_rate) / 100 : ((rbt12 * Number(b.nominal_rate) / 100) - Number(b.deduction)) / rbt12;
  const das = currentRevenue * effective;

  return (
    <>
      <PageHeader title="Apuração do Simples Nacional" description="Estimativa do DAS do mês (Anexo I · comércio). Vencimento: dia 20 do mês seguinte. Confirme com o contador." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Receita do mês" value={formatBRL(currentRevenue)} />
        <Stat label="RBT12" value={formatBRL(rbt12)} hint={method} />
        <Stat label="Alíquota efetiva" value={`${(effective * 100).toFixed(2).replace(".", ",")}%`} hint={b ? `faixa ${b.bracket}` : undefined} />
        <Stat label="DAS estimado" value={formatBRL(das)} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Faixas do Anexo I">
          <Table head={["Faixa", "Até (RBT12)", "Nominal", "Dedução"]}>
            {(brackets ?? []).map((x) => (
              <tr key={x.bracket} className={b?.bracket === x.bracket ? "bg-brand/5 font-medium" : ""}>
                <td className="px-3 py-1.5">{x.bracket}</td><td className="px-3 py-1.5">{formatBRL(x.max_rbt12)}</td>
                <td className="px-3 py-1.5">{String(x.nominal_rate).replace(".", ",")}%</td><td className="px-3 py-1.5">{formatBRL(x.deduction)}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Limites">
          <ul className="space-y-2 text-sm">
            <li className="flex justify-between"><span>Limite do Simples (grupo, R$ 4,8 mi)</span><span>{((rbt12 / 4_800_000) * 100).toFixed(1).replace(".", ",")}%</span></li>
            <li className="flex justify-between"><span>Sublimite de ICMS em SC (R$ 3,6 mi)</span><span>{((rbt12 / 3_600_000) * 100).toFixed(1).replace(".", ",")}%</span></li>
          </ul>
          <p className="mt-3 text-xs text-muted">Receitas de serviços (Anexo III: promoção de vendas e eventos) entram na apuração quando houver notas de serviço.</p>
        </Card>
      </div>
    </>
  );
}
