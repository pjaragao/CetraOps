import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash, fmtMonth } from "@/components/form";
import { approveStatementAction, generateStatementsAction, reopenStatementAction } from "../actions";

export const metadata = { title: "Metas e comissões" };

const STATUS: Record<string, [string, "neutral" | "info" | "success" | "warning" | "danger"]> = {
  DRAFT: ["rascunho", "warning"], APPROVED: ["aprovado", "info"], PAID: ["pago na folha", "success"], CANCELLED: ["cancelado", "danger"],
};

export default async function ComissoesPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("hr.payroll.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const canWrite = can(session, "hr.payroll.write");
  const ym = str(sp.mes) ?? todayIsoSP().slice(0, 7);
  const comp = `${ym}-01`;

  const [{ data: stm }, { data: emps }, { data: plan }] = await Promise.all([
    supabase.schema("comm").from("statements").select("*").eq("competence", comp),
    supabase.schema("hr").from("employees").select("id, party_id, member_id, store_id").eq("status", "ACTIVE").eq("commissioned", true),
    supabase.schema("core").from("settings").select("value").eq("key", "commission_plan_default").maybeSingle(),
  ]);
  const partyIds = (emps ?? []).map((e) => e.party_id);
  const { data: parties } = partyIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : { data: [] as { id: string; display_name: string }[] };
  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const byMember = new Map((stm ?? []).map((s) => [s.member_id, s]));
  const planValue = (plan?.value ?? {}) as { base?: string; rates_by_channel?: Record<string, number>; tiers?: { from: number; to?: number; bonus?: number; pct_over?: number }[] };
  const total = (stm ?? []).reduce((a, s) => a + Number(s.total), 0);

  return (
    <>
      <PageHeader title="Metas e comissões" description="Extrato mensal por vendedora, calculado no banco com o plano vigente. O extrato aprovado entra na folha como comissão (+ DSR); vendas canceladas ou devolvidas saem do cálculo enquanto o extrato não é aprovado." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <form className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="Competência"><input name="mes" type="month" defaultValue={ym} className={inputClass} /></Field>
        <Button variant="secondary">Ver</Button>
      </form>
      {canWrite && (
        <form action={generateStatementsAction} className="mb-4"><input type="hidden" name="month" value={ym} /><Button>Gerar / recalcular extratos de {fmtMonth(comp)}</Button></form>
      )}

      {(emps ?? []).length === 0 ? <Empty title="Nenhum colaborador comissionado">Marque “Recebe comissão” na admissão e vincule o colaborador a um acesso ao sistema.</Empty> : (
        <Table head={["Vendedora", "Vendas creditadas", "Base das faixas", "Comissão", "Bônus", "Total", "Situação", ""]}>
          {(emps ?? []).map((e) => {
            const s = e.member_id ? byMember.get(e.member_id) : undefined;
            return (
              <tr key={e.id}>
                <td className="px-3 py-2 font-medium">{pname.get(e.party_id)}{!e.member_id && <span className="block text-xs text-warning">sem acesso vinculado</span>}</td>
                <td className="px-3 py-2">{s ? formatBRL(s.sales_amount) : "—"}</td><td className="px-3 py-2">{s ? formatBRL(s.base_amount) : "—"}</td>
                <td className="px-3 py-2">{s ? formatBRL(s.commission) : "—"}</td><td className="px-3 py-2">{s ? formatBRL(s.bonus) : "—"}</td>
                <td className="px-3 py-2 font-medium">{s ? formatBRL(s.total) : "—"}</td>
                <td className="px-3 py-2">{s ? <Badge tone={STATUS[s.status][1]}>{STATUS[s.status][0]}</Badge> : <Badge>não gerado</Badge>}</td>
                <td className="px-3 py-2">
                  {canWrite && s?.status === "DRAFT" && <form action={approveStatementAction}><input type="hidden" name="statement_id" value={s.id} /><input type="hidden" name="mes" value={ym} /><Button variant="secondary" className="px-2 py-1 text-xs">Aprovar</Button></form>}
                  {canWrite && s?.status === "APPROVED" && <form action={reopenStatementAction}><input type="hidden" name="statement_id" value={s.id} /><input type="hidden" name="mes" value={ym} /><Button variant="ghost" className="px-2 py-1 text-xs">Reabrir</Button></form>}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <p className="mt-2 text-sm text-muted">Total do mês: <b>{formatBRL(total)}</b></p>

      <Card className="mt-4" title="Plano vigente">
        <p className="text-sm text-muted">Base das faixas: <b>{planValue.base === "INDIVIDUAL_REVENUE" ? "faturamento individual" : "faturamento da loja"}</b> · taxas por canal: {Object.entries(planValue.rates_by_channel ?? {}).map(([k, v]) => `${k} ${v}%`).join(" · ") || "—"}</p>
        <ul className="mt-2 list-disc pl-5 text-sm text-muted">
          {(planValue.tiers ?? []).map((t, i) => <li key={i}>{t.to ? `de ${formatBRL(t.from)} a ${formatBRL(t.to)}` : `acima de ${formatBRL(t.from)}`}: {t.bonus ? `bônus de ${formatBRL(t.bonus)}` : `${t.pct_over}% sobre o excedente`}</li>)}
        </ul>
        <p className="mt-2 text-xs text-muted">Decisões pendentes dos sócios: base individual × loja e tratamento das vendas fechadas pela IA.</p>
      </Card>
    </>
  );
}
