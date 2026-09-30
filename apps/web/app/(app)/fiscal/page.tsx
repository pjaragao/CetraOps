import Link from "next/link";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, PageHeader, Stat, Table } from "@/components/ui";
import { Field, Flash, fmtMonth } from "@/components/form";
import { postDasAction } from "./actions";

export const metadata = { title: "Apuração do Simples" };

/**
 * Apuração do DAS a partir do razão contábil: receita por anexo, RBT12 (regra de início de atividade) e alíquota efetiva.
 * A guia vira conta a pagar contabilizada. ESTIMATIVA — o PGDAS-D do contador é o oficial.
 */
export default async function FiscalPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fiscal.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const ym = str(sp.mes) ?? todayIsoSP().slice(0, 7);
  const comp = `${ym}-01`;

  const { data: entities } = await supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia").order("razao_social");
  const entity = str(sp.entity) ?? entities?.[0]?.id;
  if (!entity) return (<><PageHeader title="Apuração do Simples" /><p className="text-muted">Cadastre a empresa em Configurações.</p></>);

  const [calc, { data: period }, { data: brackets }, { data: upcoming }] = await Promise.all([
    supabase.schema("fiscal").rpc("simples_calc", { p_entity: entity, p_competence: comp }),
    supabase.schema("fiscal").from("tax_periods").select("id, das_estimated, title_id, status").eq("legal_entity_id", entity).eq("competence", comp).maybeSingle(),
    supabase.schema("fiscal").from("simples_brackets").select("annex, bracket, max_rbt12, nominal_rate, deduction").eq("annex", "I").order("bracket"),
    supabase.schema("fiscal").from("obligations").select("id, kind, competence, due_date, amount, status").eq("status", "PENDING").order("due_date").limit(6),
  ]);
  const c = calc.data?.[0];
  const rbt12 = Number(c?.rbt12 ?? 0);
  const b = (brackets ?? []).find((x) => rbt12 <= Number(x.max_rbt12)) ?? brackets?.[brackets.length - 1];
  const base = Number(c?.revenue_annex1 ?? 0) + Number(c?.revenue_annex3 ?? 0) - Number(c?.returns_amount ?? 0);

  return (
    <>
      <PageHeader title="Apuração do Simples Nacional" description="DAS do mês (Anexo I — comércio; serviços no Anexo III) calculado sobre o razão contábil. Vencimento no dia 20 do mês seguinte. Confirme com o contador." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <form className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="Competência"><input name="mes" type="month" defaultValue={ym} className={inputClass} /></Field>
        {(entities ?? []).length > 1 && <Field label="Empresa"><select name="entity" defaultValue={entity} className={inputClass}>{(entities ?? []).map((e) => <option key={e.id} value={e.id}>{e.nome_fantasia ?? e.razao_social}</option>)}</select></Field>}
        <Button variant="secondary">Ver</Button>
      </form>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Receita do mês" value={formatBRL(base)} hint={`Anexo I ${formatBRL(c?.revenue_annex1 ?? 0)} · Anexo III ${formatBRL(c?.revenue_annex3 ?? 0)}${Number(c?.returns_amount) > 0 ? ` · devoluções ${formatBRL(c?.returns_amount ?? 0)}` : ""}`} />
        <Stat label="RBT12" value={formatBRL(rbt12)} hint={c?.rbt12_method} />
        <Stat label="Alíquota efetiva (Anexo I)" value={`${String(Number(c?.rate1 ?? 0).toFixed(2)).replace(".", ",")}%`} hint={b ? `faixa ${b.bracket}` : undefined} />
        <Stat label="DAS estimado" value={formatBRL(c?.das ?? 0)} tone={period ? "success" : undefined} hint={period ? "guia já gerada" : undefined} />
      </div>

      <Card className="mt-4" title={`Guia de ${fmtMonth(comp)}`}>
        {period ? (
          <p className="text-sm">Guia gerada em <Link className="text-brand" href="/financeiro/pagar">Contas a pagar</Link> ({formatBRL(period.das_estimated)}). Ao pagar, a obrigação sai do calendário.</p>
        ) : can(session, "fiscal.write") && can(session, "fin.write") ? (
          <form action={postDasAction} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="entity" value={entity} /><input type="hidden" name="month" value={ym} />
            <Button disabled={Number(c?.das ?? 0) <= 0}>Gerar guia do DAS ({formatBRL(c?.das ?? 0)})</Button>
            <span className="text-xs text-muted">Cria a conta a pagar (vence dia 20), lança a dedução da receita e coloca no calendário de obrigações. Faça depois de fechar o mês.</span>
          </form>
        ) : <p className="text-sm text-muted">Sem permissão para gerar a guia.</p>}
      </Card>

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
        <div className="space-y-4">
          <Card title="Limites">
            <ul className="space-y-2 text-sm">
              <li className="flex justify-between"><span>Limite do Simples (grupo, R$ 4,8 mi)</span><span>{((rbt12 / 4_800_000) * 100).toFixed(1).replace(".", ",")}%</span></li>
              <li className="flex justify-between"><span>Sublimite de ICMS em SC (R$ 3,6 mi)</span><span>{((rbt12 / 3_600_000) * 100).toFixed(1).replace(".", ",")}%</span></li>
            </ul>
          </Card>
          <Card title="Próximas obrigações" action={<Link className="text-xs text-brand" href="/fiscal/obrigacoes">ver todas</Link>}>
            {(upcoming ?? []).length === 0 ? <p className="text-sm text-muted">Nada pendente.</p> : (
              <ul className="divide-y divide-border text-sm">
                {(upcoming ?? []).map((o) => <li key={o.id} className="flex justify-between py-1"><span><Badge>{o.kind}</Badge> {fmtMonth(o.competence)}</span><span>{o.due_date.split("-").reverse().join("/")} · {formatBRL(o.amount)}</span></li>)}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
