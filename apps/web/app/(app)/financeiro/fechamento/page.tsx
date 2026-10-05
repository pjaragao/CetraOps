import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { addDaysIsoSP, str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash, fmtDate, fmtMonth } from "@/components/form";
import { closeMonthAction, reopenMonthAction, reverseAllocationAction, runAllocationAction } from "../plan-actions";

export const metadata = { title: "Fechamento mensal" };

const TONE = { OK: "success", WARN: "warning", BLOCK: "danger", INFO: "info" } as const;
const LABEL = { OK: "ok", WARN: "atenção", BLOCK: "pendente", INFO: "automático" } as const;

/** Fechamento do mês: checklist, rateio por direcionadores e bloqueio do período contábil. */
export default async function FechamentoPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fin.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const canApprove = can(session, "fin.approve");
  const { data: entities } = await supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia").order("razao_social");
  const entity = str(sp.entity) ?? entities?.[0]?.id;
  if (!entity) return (<><PageHeader title="Fechamento mensal" /><Empty title="Cadastre a empresa em Configurações" /></>);
  const prev = addDaysIsoSP(-new Date(`${todayIsoSP()}T12:00:00Z`).getUTCDate());       // último dia do mês anterior
  const ym = str(sp.mes) ?? prev.slice(0, 7);
  const comp = `${ym}-01`;

  const [{ data: checklist, error }, { data: period }, { data: batch }, { data: rules }, { data: periods }, { data: ccs }] = await Promise.all([
    supabase.schema("fin").rpc("closing_checklist", { p_entity: entity, p_competence: comp }),
    supabase.schema("fin").from("periods").select("status, closed_at, notes").eq("legal_entity_id", entity).eq("competence", comp).maybeSingle(),
    supabase.schema("fin").from("allocation_batches").select("id, total, detail, status, created_at").eq("legal_entity_id", entity).eq("competence", comp).eq("status", "APPLIED").maybeSingle(),
    supabase.schema("fin").from("allocation_rules").select("id").eq("active", true),
    supabase.schema("fin").from("periods").select("competence, status, closed_at").eq("legal_entity_id", entity).order("competence", { ascending: false }).limit(12),
    supabase.schema("core").from("cost_centers").select("id, code, name"),
  ]);
  const closed = period?.status === "CLOSED";
  const blocks = (checklist ?? []).filter((c) => c.status === "BLOCK").length;
  const warns = (checklist ?? []).filter((c) => c.status === "WARN").length;
  const ccname = new Map((ccs ?? []).map((c) => [c.id, c.code]));
  const detail = (batch?.detail ?? []) as { rule: string; method?: string; pool?: number; skipped?: string; weights?: { cost_center_id: string; weight: number }[] }[];
  const monthEnded = new Date(`${comp}T12:00:00Z`).getUTCMonth() !== new Date(`${todayIsoSP()}T12:00:00Z`).getUTCMonth() || comp.slice(0, 4) !== todayIsoSP().slice(0, 4);

  return (
    <>
      <PageHeader title="Fechamento mensal" description="Confira o checklist, aplique o rateio do corporativo e feche o mês: depois disso nenhum lançamento entra no período sem reabrir." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <form className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="Competência"><input name="mes" type="month" defaultValue={ym} className={inputClass} /></Field>
        {(entities ?? []).length > 1 && <Field label="Empresa"><select name="entity" defaultValue={entity} className={inputClass}>{(entities ?? []).map((e) => <option key={e.id} value={e.id}>{e.nome_fantasia ?? e.razao_social}</option>)}</select></Field>}
        <Button variant="secondary">Ver</Button>
        <span className="ml-auto flex items-center gap-2 text-sm">{fmtMonth(comp)}: <Badge tone={closed ? "success" : "warning"}>{closed ? "fechado" : "aberto"}</Badge></span>
      </form>
      {error && <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error.message}</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title={`Checklist · ${blocks} pendência(s) · ${warns} atenção`}>
            <ul className="divide-y divide-border">
              {(checklist ?? []).map((c) => (
                <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div><p className="text-sm font-medium">{c.label}</p><p className="text-xs text-muted">{c.detail}</p></div>
                  <div className="flex items-center gap-2"><Badge tone={TONE[c.status as keyof typeof TONE]}>{LABEL[c.status as keyof typeof LABEL]}</Badge>
                    {c.status !== "OK" && c.href && <Link href={c.href} className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-surface-2">Resolver</Link>}</div>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="mt-4" title="Rateio do corporativo (gerencial)" action={<Link className="text-xs text-brand" href="/configuracoes/rateios">regras</Link>}>
            {!batch ? (
              <div className="space-y-2 text-sm">
                <p className="text-muted">{(rules ?? []).length === 0 ? "Nenhuma regra por direcionadores cadastrada: o corporativo fica no centro de custo de origem." : `${(rules ?? []).length} regra(s) ativa(s). O rateio é aplicado sozinho ao fechar o mês; se preferir, aplique agora para conferir o DRE.`}</p>
                {(rules ?? []).length > 0 && canApprove && !closed && <form action={runAllocationAction}><input type="hidden" name="entity" value={entity} /><input type="hidden" name="mes" value={ym} /><Button variant="secondary">Aplicar rateio agora</Button></form>}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm">Rateio aplicado em {fmtDate(batch.created_at.slice(0, 10))}: <b>{formatBRL(batch.total)}</b> movidos entre centros de custo (lançamentos gerenciais; o razão oficial não muda).</p>
                <Table head={["Regra", "Base", "Valor", "Distribuição (peso)"]}>
                  {detail.map((d, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2">{d.rule}</td><td className="px-3 py-2 text-xs">{d.method ?? "—"}</td>
                      <td className="px-3 py-2">{d.pool != null ? formatBRL(d.pool) : <span className="text-muted">{d.skipped}</span>}</td>
                      <td className="px-3 py-2 text-xs">{(d.weights ?? []).map((w) => `${ccname.get(w.cost_center_id) ?? "?"}: ${Number(w.weight).toLocaleString("pt-BR")}`).join(" · ")}</td>
                    </tr>
                  ))}
                </Table>
                {canApprove && !closed && (
                  <form action={reverseAllocationAction} className="flex items-end gap-2"><input type="hidden" name="entity" value={entity} /><input type="hidden" name="mes" value={ym} /><input type="hidden" name="batch_id" value={batch.id} />
                    <Field label="Estornar o rateio"><input name="reason" placeholder="Motivo" className={`${inputClass} w-56`} /></Field><Button variant="ghost">Estornar</Button></form>
                )}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title={closed ? "Período fechado" : "Fechar o mês"}>
            {closed ? (
              <div className="space-y-3 text-sm">
                <p>Fechado em {period?.closed_at ? fmtDate(period.closed_at.slice(0, 10)) : "—"}. Lançamentos com data em {fmtMonth(comp)} são recusados.</p>
                {canApprove && (
                  <form action={reopenMonthAction} className="space-y-2"><input type="hidden" name="entity" value={entity} /><input type="hidden" name="mes" value={ym} />
                    <Field label="Motivo da reabertura"><input name="reason" required className={inputClass} placeholder="Ex.: ajuste pedido pelo contador" /></Field>
                    <Button variant="danger">Reabrir período</Button>
                    <p className="text-xs text-muted">O rateio do mês é estornado e refeito no próximo fechamento.</p></form>
                )}
              </div>
            ) : canApprove ? (
              <form action={closeMonthAction} className="space-y-3 text-sm"><input type="hidden" name="entity" value={entity} /><input type="hidden" name="mes" value={ym} />
                {!monthEnded && <p className="rounded-lg bg-warning/10 px-3 py-2 text-warning">O mês ainda não terminou. Só feche depois do último dia.</p>}
                {blocks > 0 && <label className="flex items-start gap-2"><input type="checkbox" name="force" className="mt-1" /><span>Fechar mesmo com {blocks} pendência(s) (fica registrado em quem fechou).</span></label>}
                {!monthEnded && <label className="flex items-start gap-2"><input type="checkbox" name="force" className="mt-1" /><span>Fechar antes do fim do mês.</span></label>}
                <Button>Fechar {fmtMonth(comp)}</Button>
                <p className="text-xs text-muted">Aplica o rateio (se houver regras) e bloqueia o período contábil desta empresa.</p>
              </form>
            ) : <p className="text-sm text-muted">Somente quem aprova (sócio/financeiro) fecha o mês.</p>}
          </Card>
          <Card title="Períodos">
            {(periods ?? []).length === 0 ? <p className="text-sm text-muted">Nenhum fechamento ainda.</p> : (
              <ul className="divide-y divide-border text-sm">{(periods ?? []).map((p) => (
                <li key={p.competence} className="flex justify-between py-1.5"><Link className="text-brand" href={`/financeiro/fechamento?mes=${p.competence.slice(0, 7)}&entity=${entity}`}>{fmtMonth(p.competence)}</Link><Badge tone={p.status === "CLOSED" ? "success" : "warning"}>{p.status === "CLOSED" ? "fechado" : "aberto"}</Badge></li>
              ))}</ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
