import Link from "next/link";
import { formatBRL, SEGMENTS, STAGE_LABEL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { periodBounds, str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Stat, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { refreshLifecycleAction, saveLifecycleSettingsAction } from "../actions";

export const metadata = { title: "Ciclo de vida" };

interface Overview {
  stages: Record<string, number>; tiers: Record<string, number>; segments: Record<string, number>; at_risk: number;
  funnel: { new_leads: number; qualified: number; first_purchases: number; second_purchases: number; repeat_orders: number; became_vip: number; became_inactive: number; became_lost: number; reactivated: number };
  revenue: { total: number; repeat: number };
  consent_whatsapp: { customers: number; granted: number };
  second_purchase_90d: { cohort: number; returned: number };
  avg_interval_days: number | null;
  settings: Record<string, number>;
}

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((100 * n) / d)}%` : "—");
const SETTINGS: [string, string, string][] = [
  ["vip_min_revenue_12m", "VIP: gasto em 12 meses (R$)", "Ou o número de compras abaixo"],
  ["vip_min_orders_12m", "VIP: compras em 12 meses", ""],
  ["at_risk_factor", "Em risco: vezes o intervalo dela", "Ex.: 1,5 = 50% além do normal"],
  ["at_risk_single_days", "Em risco: dias (quem comprou 1 vez)", ""],
  ["inactive_days", "Inativa a partir de (dias)", ""],
  ["lost_days", "Perdida a partir de (dias)", ""],
  ["prospect_min_score", "Prospect a partir do score", "0 a 100"],
];

export default async function CicloDeVidaPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const b = periodBounds(str(sp.periodo));
  const supabase = await createClient();
  const [{ data, error }, { data: risk }] = await Promise.all([
    supabase.schema("crm").rpc("lifecycle_overview", { p_from: b.from, p_to: b.to }),
    supabase.schema("crm").from("customer_metrics").select("party_id, days_since_last, avg_interval_days, revenue_12m, orders_total").eq("at_risk", true).order("revenue_12m", { ascending: false }).limit(15),
  ]);
  const d = data as unknown as Overview | null;
  if (error || !d) return <><PageHeader title="Ciclo de vida" /><Empty title="Não foi possível calcular agora">{error?.message}</Empty></>;
  const ids = (risk ?? []).map((r) => r.party_id);
  const { data: people } = ids.length ? await supabase.schema("crm").from("parties").select("id, display_name, tier").in("id", ids) : { data: [] as { id: string; display_name: string; tier: string }[] };
  const who = new Map((people ?? []).map((p) => [p.id, p]));
  const f = d.funnel;
  const stageOrder = ["LEAD", "PROSPECT", "CUSTOMER", "VIP", "INACTIVE", "LOST"];

  return (
    <>
      <PageHeader title="Ciclo de vida" description={`Quem chegou, quem comprou, quem voltou e quem está sumindo. Período: ${b.from.split("-").reverse().join("/")} a ${b.to.split("-").reverse().join("/")} (muda no topo da tela). Recalculado toda madrugada e a cada venda.`}
        actions={can(session, "crm.write") ? <form action={refreshLifecycleAction}><Button variant="secondary">Recalcular agora</Button></form> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      <h2 className="mb-2 text-sm font-semibold">Funil do período</h2>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Leads novas" value={f.new_leads} hint={`${f.qualified} qualificadas`} />
        <Stat label="Primeiras compras" value={f.first_purchases} />
        <Stat label="Segundas compras" value={f.second_purchases} hint={`${f.repeat_orders} pedidos de quem já tinha comprado`} />
        <Stat label="Viraram VIP" value={f.became_vip} />
        <Stat label="Reativadas" value={f.reactivated} hint={`${f.became_inactive} ficaram inativas · ${f.became_lost} perdidas`} tone={f.reactivated > 0 ? "success" : undefined} />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Receita de recorrentes" value={pct(d.revenue.repeat, d.revenue.total)} hint={`${formatBRL(d.revenue.repeat)} de ${formatBRL(d.revenue.total)}`} />
        <Stat label="2ª compra em até 90 dias" value={pct(d.second_purchase_90d.returned, d.second_purchase_90d.cohort)} hint={`${d.second_purchase_90d.returned} de ${d.second_purchase_90d.cohort} clientes novas (coorte de 90 dias antes)`} />
        <Stat label="Intervalo médio entre compras" value={d.avg_interval_days ? `${d.avg_interval_days} dias` : "—"} hint="Meta do plano: até 90 dias" />
        <Stat label="Aceite de marketing no WhatsApp" value={pct(d.consent_whatsapp.granted, d.consent_whatsapp.customers)} hint={`${d.consent_whatsapp.granted} de ${d.consent_whatsapp.customers} clientes`} />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title="Base hoje, por estágio">
          <ul className="space-y-1.5 text-sm">{stageOrder.map((s) => (
            <li key={s} className="flex justify-between"><Link className="text-brand" href={`/clientes?estagio=${s}`}>{STAGE_LABEL[s]}</Link><span className="tabular-nums">{d.stages[s] ?? 0}</span></li>
          ))}</ul>
        </Card>
        <Card title="Segmentos (quem já comprou)">
          <ul className="space-y-1.5 text-sm">{Object.entries(SEGMENTS).map(([k, s]) => (
            <li key={k} className="flex items-start justify-between gap-3">
              <span><Link className="text-brand" href={`/clientes?segmento=${k}`}>{s.label}</Link><span className="block text-xs text-muted">{s.hint} · {s.action}</span></span>
              <span className="tabular-nums">{d.segments[k] ?? 0}</span>
            </li>
          ))}</ul>
        </Card>
      </div>

      <h2 className="mb-2 text-sm font-semibold">Em risco agora ({d.at_risk})</h2>
      {(risk ?? []).length === 0 ? <Empty title="Ninguém em risco">Quem passar do intervalo habitual de compra aparece aqui.</Empty> : (
        <Table head={["Cliente", "Sem comprar", "Costuma comprar a cada", "Gasto em 12 meses", "Compras"]}>
          {(risk ?? []).map((r) => {
            const p = who.get(r.party_id);
            return (
              <tr key={r.party_id}>
                <td className="px-3 py-2"><Link className="font-medium text-brand" href={`/clientes/${r.party_id}`}>{p?.display_name ?? "—"}</Link>{p && p.tier !== "STANDARD" && <span className="ml-2"><Badge tone="warning">{p.tier === "VIP_BLACK" ? "VIP Black" : "VIP"}</Badge></span>}</td>
                <td className="px-3 py-2 tabular-nums">{r.days_since_last} dias</td>
                <td className="px-3 py-2 tabular-nums">{r.avg_interval_days ? `${Math.round(Number(r.avg_interval_days))} dias` : "1 compra só"}</td>
                <td className="px-3 py-2 tabular-nums">{formatBRL(Number(r.revenue_12m))}</td>
                <td className="px-3 py-2 tabular-nums">{r.orders_total}</td>
              </tr>
            );
          })}
        </Table>
      )}

      {can(session, "core.admin") && (
        <Card className="mt-6" title="Regras do ciclo de vida">
          <form action={saveLifecycleSettingsAction} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {SETTINGS.map(([k, label, hint]) => (
                <Field key={k} label={label} hint={hint || undefined}><input name={k} inputMode="decimal" defaultValue={String(d.settings[k] ?? "").replace(".", ",")} className={inputClass} /></Field>
              ))}
            </div>
            <div className="flex items-center gap-3"><Button>Salvar e recalcular</Button><span className="text-xs text-muted">VIP Black é sempre definido à mão, na ficha da cliente.</span></div>
          </form>
        </Card>
      )}
    </>
  );
}
