import Link from "next/link";
import { formatBRL, formatPct } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { periodBounds, str, type SP } from "@/lib/context";
import { Button, Card, inputClass, PageHeader } from "@/components/ui";

export const metadata = { title: "DRE" };

/**
 * DRE gerencial a partir do razão. "Com rateio" inclui os ajustes gerenciais entre centros de custo; "sem rateio" mostra a
 * margem de contribuição da unidade antes da alocação de custos corporativos. Filtra por CNPJ e por centro de custo (subárvore).
 */
export default async function DrePage({ searchParams }: { searchParams: SP }) {
  await requirePerm("fin.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const { from, to } = periodBounds(str(sp.periodo));
  const emp = str(sp.emp) || undefined;
  const cc = str(sp.cc) || undefined;
  const rateio = str(sp.rateio) !== "sem";

  const [{ data: entities }, { data: ccs }] = await Promise.all([
    supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia").order("razao_social"),
    supabase.schema("core").from("cost_centers").select("id, code, name, kind, parent_id").is("archived_at", null).order("code"),
  ]);
  let subtree: string[] | undefined;
  if (cc) {
    const r = await supabase.schema("core").rpc("cc_subtree", { p_root: cc });
    subtree = (r.data as string[] | null) ?? [cc];
  }
  const { data: dre, error } = await supabase.schema("fin").rpc("dre", {
    p_from: from, p_to: to, p_entity: emp as string, p_cost_centers: subtree as string[], p_ledger: rateio ? "ALL" : "LEGAL",
  });
  const rows = dre ?? [];
  const rb = Number(rows.find((r) => r.code === "RB")?.amount ?? 0);
  const ccLabel = ccs?.find((c) => c.id === cc);

  return (
    <>
      <PageHeader title="DRE gerencial" description={`Do razão contábil · ${from.split("-").reverse().join("/")} a ${to.split("-").reverse().join("/")} (troque no seletor de período do topo).`} />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        {str(sp.periodo) && <input type="hidden" name="periodo" value={str(sp.periodo)} />}
        <label className="text-xs text-muted">Empresa (CNPJ)
          <select name="emp" defaultValue={emp ?? ""} className={inputClass}><option value="">Todas</option>{(entities ?? []).map((e) => <option key={e.id} value={e.id}>{e.nome_fantasia ?? e.razao_social}</option>)}</select>
        </label>
        <label className="text-xs text-muted">Centro de custo (com filhos)
          <select name="cc" defaultValue={cc ?? ""} className={inputClass}><option value="">Consolidado</option>{(ccs ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select>
        </label>
        <label className="text-xs text-muted">Rateio corporativo
          <select name="rateio" defaultValue={rateio ? "com" : "sem"} className={inputClass}><option value="com">Com rateio</option><option value="sem">Sem rateio (margem da unidade)</option></select>
        </label>
        <Button variant="secondary">Aplicar</Button>
      </form>

      {error ? <p className="text-danger">{error.message}</p> : (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted"><tr><th className="py-1">Linha</th><th className="text-right">Valor</th><th className="w-24 text-right">% receita</th></tr></thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => {
                const v = Number(r.amount);
                const shown = r.sign === -1 && !r.is_subtotal ? -v : v; // despesas aparecem entre parênteses
                return (
                  <tr key={r.code} className={r.is_subtotal ? "bg-surface-2 font-semibold" : ""}>
                    <td className="py-1.5 pl-2">{r.name}</td>
                    <td className={`text-right ${shown < 0 ? "text-danger" : ""}`}>{formatBRL(shown)}</td>
                    <td className="pr-2 text-right text-muted">{rb ? formatPct(v / rb) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted">
            {ccLabel ? `Filtrado em ${ccLabel.code} e centros filhos. ` : ""}
            {rateio ? "Inclui ajustes gerenciais (rateio entre centros de custo). " : "Sem rateio: só os lançamentos diretos. "}
            Deduções entram quando o DAS é apurado (Fiscal). <Link className="text-brand" href="/financeiro/razao">Ver razão</Link>
          </p>
        </Card>
      )}
    </>
  );
}
