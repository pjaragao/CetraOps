import Link from "next/link";
import { formatBRL, OBJECTIVE_LABEL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { Badge, Card, Empty, PageHeader, Stat } from "@/components/ui";

export const metadata = { title: "Marketing" };

interface Res { revenue: number; orders: number; cost: { total: number } }

export default async function MarketingHome() {
  await requirePerm("crm.read");
  const supabase = await createClient();
  const [{ data: active }, { data: dispatches }, { data: conns }, { data: addr }, { data: failed }] = await Promise.all([
    supabase.schema("mkt").from("campaigns").select("id, name, objective, ends_at").eq("status", "ACTIVE").order("created_at", { ascending: false }).limit(20),
    supabase.schema("mkt").from("campaign_dispatches").select("id, campaign_id, seq, filter, scheduled_at, status").in("status", ["SCHEDULED", "SENDING"]).order("scheduled_at").limit(8),
    supabase.schema("core").from("integration_connections").select("provider, status").eq("provider", "META_ADS"),
    supabase.schema("omni").from("channel_accounts").select("id").eq("channel", "WHATSAPP").eq("status", "ACTIVE").is("public_address", null),
    supabase.schema("omni").from("templates").select("id, name").eq("status", "REJECTED").limit(5),
  ]);
  const results = await Promise.all((active ?? []).map(async (c) => ({ c, r: ((await supabase.schema("mkt").rpc("campaign_results", { p_id: c.id })).data ?? null) as unknown as Res | null })));
  const revenue = results.reduce((s, x) => s + (x.r?.revenue ?? 0), 0);
  const cost = results.reduce((s, x) => s + (x.r?.cost.total ?? 0), 0);
  const names = new Map((active ?? []).map((c) => [c.id, c.name]));
  const alerts: { text: string; href: string }[] = [];
  if (!(conns ?? []).some((c) => c.status !== "DISABLED")) alerts.push({ text: "Meta Ads não conectada: públicos e anúncios não funcionam.", href: "/configuracoes/integracoes" });
  if ((addr ?? []).length > 0) alerts.push({ text: "Há número de WhatsApp sem endereço público: links e QR das campanhas não são criados.", href: "/marketing/links" });
  for (const t of failed ?? []) alerts.push({ text: `Template reprovado pela Meta: ${t.name}`, href: "/atendimento/templates" });

  return (
    <>
      <PageHeader title="Marketing" description="Visão geral: campanhas ativas, receita atribuída e próximos disparos."
        actions={<Link href="/marketing/campanhas/nova" className="inline-flex items-center rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-contrast hover:opacity-90">Nova campanha</Link>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label="Campanhas ativas" value={(active ?? []).length} />
        <Stat label="Receita atribuída (ativas)" value={formatBRL(revenue)} tone={revenue > 0 ? "success" : undefined} />
        <Stat label="Custo (ativas)" value={formatBRL(cost)} hint={cost > 0 ? `Retorno ${(revenue / cost).toFixed(1)}x` : undefined} />
      </div>
      {alerts.length > 0 && (
        <Card title="Atenção" className="mb-4">
          <ul className="space-y-1 text-sm">{alerts.map((a) => <li key={a.text}><Link href={a.href} className="text-warning hover:underline">{a.text}</Link></li>)}</ul>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Campanhas ativas">
          {results.length === 0 ? <Empty title="Nenhuma campanha ativa" /> : (
            <ul className="divide-y divide-border text-sm">
              {results.map(({ c, r }) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                  <Link href={`/marketing/campanhas/${c.id}`} className="font-medium hover:underline">{c.name}<span className="block text-[11px] font-normal text-muted">{OBJECTIVE_LABEL[c.objective] ?? c.objective}</span></Link>
                  <span className="text-right tabular-nums">{formatBRL(r?.revenue ?? 0)}<span className="block text-[11px] text-muted">{r?.orders ?? 0} pedido(s)</span></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Próximos disparos">
          {(dispatches ?? []).length === 0 ? <Empty title="Nada agendado" /> : (
            <ul className="divide-y divide-border text-sm">
              {(dispatches ?? []).map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                  <Link href={`/marketing/campanhas/${d.campaign_id}`} className="hover:underline">{names.get(d.campaign_id) ?? "Campanha"} · {d.filter === "ALL" ? "disparo" : "lembrete"} {d.seq}</Link>
                  <span className="text-xs text-muted">{d.status === "SENDING" ? <Badge tone="warning">enviando</Badge> : d.scheduled_at ? new Date(d.scheduled_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
