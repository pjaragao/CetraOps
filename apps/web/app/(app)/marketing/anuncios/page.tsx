import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge, Button, Empty, PageHeader, Stat, Table, inputClass } from "@/components/ui";
import { Flash } from "@/components/form";
import { syncAdsAction } from "./actions";

export const metadata = { title: "Anúncios Meta" };

interface Ad {
  ad_id: string; ad_name: string | null; campaign_name: string | null; adset_name: string | null; meta_campaign_id?: string | null;
  system_campaign?: string | null; system_campaign_id?: string | null;
  spend: number; impressions: number; reach: number; clicks: number; leads: number; conversations: number; leads_system: number; orders_system: number; revenue_system: number;
}

const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const money = (n: number) => formatBRL(Number(n));
const div = (a: number, b: number) => (b > 0 ? a / b : null);

export default async function AnunciosPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const today = todayIsoSP();
  const to = str(sp.ate) ?? today;
  const from = str(sp.de) ?? addDays(to, -29);
  const campFilter = str(sp.campanha);
  const supabase = await createClient();
  const [{ data }, { data: state }, { data: campaigns }] = await Promise.all([
    supabase.schema("mkt").rpc("ads_overview", { p_from: from, p_to: to }),
    supabase.schema("mkt").from("ad_sync_state").select("ad_account, last_day, last_run_at, last_error").order("last_run_at", { ascending: false }).limit(1),
    supabase.schema("mkt").from("campaigns").select("id, name, code").order("created_at", { ascending: false }),
  ]);
  const allAds = (data as unknown as Ad[] | null) ?? [];
  const ads = campFilter ? allAds.filter((a) => a.system_campaign_id === campFilter) : allAds;
  const sum = (k: keyof Ad) => ads.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const spend = sum("spend");
  const revenue = sum("revenue_system");
  const conv = sum("conversations");
  const roas = div(revenue, spend);
  const st = state?.[0];

  return (
    <>
      <PageHeader title="Anúncios Meta" description="O que cada anúncio gastou e rendeu. As conversas e compras da Meta são estimativas dela; os leads e a receita “do sistema” são de quem realmente chegou por aquele anúncio e comprou na loja."
        actions={canWrite ? <form action={syncAdsAction}><Button variant="secondary">Atualizar agora</Button></form> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {str(sp.wait) && <AutoRefresh />}
      {st?.last_error && <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">A última atualização falhou: {st.last_error}</p>}

      <form className="mb-4 flex flex-wrap items-end gap-2 text-sm" action="/marketing/anuncios">
        <label className="text-xs text-muted">De<input type="date" name="de" defaultValue={from} className={`${inputClass} mt-1`} /></label>
        <label className="text-xs text-muted">Até<input type="date" name="ate" defaultValue={to} className={`${inputClass} mt-1`} /></label>
        {(campaigns ?? []).length > 0 && (
          <label className="text-xs text-muted">Campanha do sistema
            <select name="campanha" defaultValue={campFilter ?? ""} className={`${inputClass} mt-1`}>
              <option value="">Todas</option>
              {(campaigns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <Button variant="secondary">Filtrar</Button>
        {st?.last_run_at && <span className="ml-auto text-xs text-muted">Última atualização: {new Date(st.last_run_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>}
      </form>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Investido" value={money(spend)} />
        <Stat label="Conversas iniciadas (Meta)" value={conv} hint={div(spend, conv) !== null ? `${money(div(spend, conv)!)} por conversa` : undefined} />
        <Stat label="Clientes que chegaram por anúncio" value={sum("leads_system")} hint="confirmado pelo sistema" />
        <Stat label="Retorno real (receita ÷ gasto)" value={roas === null ? "—" : `${roas.toFixed(2).replace(".", ",")}x`} tone={roas === null ? undefined : roas >= 1 ? "success" : "warning"} hint={`${money(revenue)} em vendas pagas`} />
      </div>

      {ads.length === 0 ? <Empty title="Sem resultados neste período">Conecte a Meta (Anúncios) em Configurações › Integrações e use “Atualizar agora”.</Empty> : (
        <Table head={["Anúncio", "Campanha do sistema", "Gasto", "Alcance", "Cliques", "Conversas (Meta)", "Chegaram (sistema)", "Pedidos", "Receita", "Retorno"]}>
          {ads.map((a) => {
            const r = div(Number(a.revenue_system), Number(a.spend));
            return (
              <tr key={a.ad_id}>
                <td className="px-3 py-2"><p className="font-medium">{a.ad_name ?? a.ad_id}</p><p className="text-[11px] text-muted">{a.campaign_name}{a.adset_name ? ` · ${a.adset_name}` : ""}</p></td>
                <td className="px-3 py-2 text-xs">{a.system_campaign ? <Link href={`/marketing/campanhas/${a.system_campaign_id}`} className="text-brand hover:underline">{a.system_campaign}</Link> : <span className="text-muted">—</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap">{money(a.spend)}</td>
                <td className="px-3 py-2 tabular-nums">{Number(a.reach).toLocaleString("pt-BR")}</td>
                <td className="px-3 py-2 tabular-nums">{Number(a.clicks).toLocaleString("pt-BR")}</td>
                <td className="px-3 py-2 tabular-nums">{a.conversations}</td>
                <td className="px-3 py-2 tabular-nums">{a.leads_system}</td>
                <td className="px-3 py-2 tabular-nums">{a.orders_system}</td>
                <td className="px-3 py-2 whitespace-nowrap">{money(a.revenue_system)}</td>
                <td className="px-3 py-2">{r === null ? "—" : <Badge tone={r >= 1 ? "success" : Number(a.spend) > 0 && Number(a.orders_system) === 0 ? "danger" : "warning"}>{r.toFixed(2).replace(".", ",")}x</Badge>}</td>
              </tr>
            );
          })}
        </Table>
      )}
      <p className="mt-2 text-xs text-muted">“Chegaram” e “Receita” só contam conversas que começaram pelo botão do anúncio (Click-to-WhatsApp) e pedidos pagos dessas clientes. Vendas depois de outro caminho (loja, indicação) não entram aqui.</p>
    </>
  );
}
