import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ATTRIBUTION_KIND_LABEL, CAMPAIGN_STATUS_LABEL, DISPATCH_FILTERS, DISPATCH_STATUS_LABEL, OBJECTIVE_LABEL, OFFER_MODES, SKIP_REASON_LABEL, formatBRL, describeAudience, type AudienceDef } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge, Button, Card, inputClass, PageHeader, Stat, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { cancelCampaignAction, cancelDispatchAction, endCampaignAction, linkAdsAction, sendCampaignAudienceAction, updateActiveCampaignAction } from "../../actions";

export const metadata = { title: "Campanha" };

const TABS: [string, string][] = [["resultado", "Resultado"], ["pessoas", "Pessoas"], ["oferta", "Oferta"], ["canais", "Canais"], ["config", "Configuração"]];
const local = (iso: string | null) => (iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace(" ", "T").slice(0, 16) : "");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

interface Results {
  recipients: Record<string, number>; skipped: Record<string, number>; delivered: number; read: number; replied: number; buyers: number; orders: number; revenue: number; reached: number; clicks: number; members: number;
  by_kind: Record<string, { orders: number; revenue: number }>; daily: { day: string; orders: number; revenue: number }[];
  lift: { treatment_n: number; holdout_n: number; treatment_buyers: number; holdout_buyers: number; treatment_rate: number | null; holdout_rate: number | null; lift_pp: number | null };
  coupons: { issued: number; used: number }; cost: { discount: number; commission: number; ads: number; messages: number; total: number }; roi: number | null; budget: number | null;
}

export default async function CampanhaPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const { id } = await params;
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const isAdmin = can(session, "core.admin");
  const supabase = await createClient();
  const { data: c } = await supabase.schema("mkt").from("campaigns").select("*").eq("id", id).maybeSingle();
  if (!c) notFound();
  if (c.status === "DRAFT") redirect(`/marketing/campanhas/${id}/montar`);
  const aba = TABS.some(([k]) => k === str(sp.aba)) ? (str(sp.aba) as string) : "resultado";
  const st = CAMPAIGN_STATUS_LABEL[c.status] ?? { label: c.status, tone: "neutral" as const };
  const live = c.status === "ACTIVE";

  const [resRes, { data: offer }, { data: dispatches }, { data: links }, { data: adLinks }, { data: members }, { data: coupons }, { data: segment }] = await Promise.all([
    supabase.schema("mkt").rpc("campaign_results", { p_id: id }),
    supabase.schema("mkt").from("campaign_offers").select("*").eq("campaign_id", id).maybeSingle(),
    supabase.schema("mkt").from("campaign_dispatches").select("id, seq, label, filter, status, scheduled_at, template_id").eq("campaign_id", id).order("seq"),
    supabase.schema("mkt").from("tracking_links").select("id, code, name, kind, active").eq("campaign_id", id).order("code"),
    supabase.schema("mkt").from("campaign_ad_links").select("meta_campaign_id, meta_campaign_name, source").eq("campaign_id", id),
    aba === "pessoas" ? supabase.schema("mkt").from("campaign_members").select("party_id, grp, coupon_id").eq("campaign_id", id).limit(500) : Promise.resolve({ data: null }),
    aba === "oferta" ? supabase.schema("sales").from("coupons").select("id, code, kind, value, party_id, valid_to, source").eq("campaign_id", id).order("created_at", { ascending: false }).limit(200) : Promise.resolve({ data: null }),
    c.segment_id ? supabase.schema("mkt").from("segments").select("id, name").eq("id", c.segment_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const r = resRes.data as unknown as Results | null;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const [{ data: stats }, { data: metaCamps }, { data: audiences }] = await Promise.all([
    aba === "canais" ? supabase.schema("mkt").rpc("link_click_stats", { p_from: "2020-01-01", p_to: today }) : Promise.resolve({ data: null }),
    aba === "canais" ? supabase.schema("mkt").rpc("ad_campaigns") : Promise.resolve({ data: null }),
    aba === "canais" && c.segment_id ? supabase.schema("mkt").from("ad_audiences").select("status, uploaded, matched, kind").eq("segment_id", c.segment_id) : Promise.resolve({ data: null }),
  ]);
  const clicks = new Map((stats ?? []).map((s) => [s.link_id, s]));
  const names = new Map<string, string>();
  if (members?.length) {
    const { data: ps } = await supabase.schema("crm").from("parties").select("id, display_name").in("id", members.map((m) => m.party_id));
    for (const p of ps ?? []) names.set(p.id, p.display_name);
  }
  const sent = (r?.recipients.QUEUED ?? 0) + (r?.recipients.SENT ?? 0);
  const total = Object.values(r?.recipients ?? {}).reduce((a, b) => a + b, 0);
  const skipped = r?.recipients.SKIPPED ?? 0;
  const maxRev = Math.max(1, ...(r?.daily ?? []).map((d) => d.revenue));
  const tabHref = (k: string) => `/marketing/campanhas/${id}?aba=${k}`;

  return (
    <>
      <PageHeader title={c.name} description={`${OBJECTIVE_LABEL[c.objective] ?? c.objective} · ${when(c.starts_at)} → ${c.ends_at ? when(c.ends_at) : "sem fim"} · [c:${c.code}]`}
        actions={<div className="flex items-center gap-2"><Badge tone={st.tone}>{st.label}</Badge><Link href="/marketing/campanhas" className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Campanhas</Link></div>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(live || str(sp.wait)) && <AutoRefresh />}
      <nav aria-label="Abas" className="mb-4 flex flex-wrap gap-1 border-b border-border">
        {TABS.map(([k, l]) => <Link key={k} href={tabHref(k)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${aba === k ? "border-brand font-medium" : "border-transparent text-muted hover:text-foreground"}`}>{l}</Link>)}
      </nav>

      {aba === "resultado" && r && (
        <div className="space-y-4">
          <Card title="Funil">
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="No público" value={r.members} />
              <Stat label="Enviadas" value={`${sent} de ${total - skipped}`} hint={skipped ? `${skipped} ficaram de fora` : undefined} />
              <Stat label="Entregues" value={r.delivered} hint={pct(r.delivered, sent)} />
              <Stat label="Leram" value={r.read} hint={pct(r.read, r.delivered)} />
              <Stat label="Responderam (72 h)" value={r.replied} hint={`${r.clicks} clique(s) em links`} />
              <Stat label="Compraram" value={r.buyers} hint={`${r.orders} pedido(s)`} />
            </div>
          </Card>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Receita atribuída" value={formatBRL(r.revenue)} tone={r.revenue > 0 ? "success" : undefined} />
            <Stat label="Custo" value={formatBRL(r.cost.total)} hint={r.budget ? `de ${formatBRL(r.budget)} orçados` : undefined} />
            <Stat label="Retorno (ROI)" value={r.roi == null ? "—" : `${r.roi >= 0 ? "+" : ""}${Math.round(r.roi * 100)}%`} tone={r.roi == null ? undefined : r.roi >= 0 ? "success" : "danger"} />
            <Stat label="Cupons usados" value={`${r.coupons.used} de ${r.coupons.issued}`} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Efeito real (vs. grupo de controle)">
              {r.lift.holdout_n > 0 ? (
                <div className="space-y-1 text-sm">
                  <p>Quem recebeu: <b>{r.lift.treatment_rate ?? 0}%</b> compraram ({r.lift.treatment_buyers} de {r.lift.treatment_n}).</p>
                  <p>Grupo de controle: <b>{r.lift.holdout_rate ?? 0}%</b> compraram ({r.lift.holdout_buyers} de {r.lift.holdout_n}).</p>
                  <p className={r.lift.lift_pp != null && r.lift.lift_pp > 0 ? "text-success" : "text-warning"}>Efeito da campanha: {r.lift.lift_pp != null ? `${r.lift.lift_pp > 0 ? "+" : ""}${r.lift.lift_pp} ponto(s) percentual(is)` : "—"}</p>
                </div>
              ) : <p className="text-sm text-muted">Esta campanha não teve grupo de controle: o resultado inclui compras que aconteceriam de qualquer forma.</p>}
            </Card>
            <Card title="Como a venda foi atribuída">
              {Object.keys(r.by_kind).length === 0 ? <p className="text-sm text-muted">Nenhuma venda atribuída ainda.</p> : (
                <ul className="space-y-1 text-sm">{Object.entries(r.by_kind).map(([k, v]) => <li key={k} className="flex justify-between"><span>{ATTRIBUTION_KIND_LABEL[k] ?? k}</span><span className="tabular-nums">{v.orders} pedido(s) · {formatBRL(v.revenue)}</span></li>)}</ul>
              )}
              <p className="mt-2 text-[11px] text-muted">Regra única: cupom, depois link/anúncio, depois mensagem recebida. Cada pedido conta para uma campanha só.</p>
            </Card>
          </div>
          <Card title="Custo detalhado"><p className="text-sm text-muted">Desconto {formatBRL(r.cost.discount)} · comissão de afiliadas {formatBRL(r.cost.commission)} · anúncios {formatBRL(r.cost.ads)} · mensagens {formatBRL(r.cost.messages)}</p></Card>
          {r.daily.length > 0 && (
            <Card title="Receita por dia">
              <ul className="space-y-1">{r.daily.map((d) => <li key={d.day} className="flex items-center gap-2 text-xs"><span className="w-20 tabular-nums text-muted">{d.day.split("-").reverse().slice(0, 2).join("/")}</span><span className="h-2 rounded bg-brand" style={{ width: `${Math.max(2, (d.revenue / maxRev) * 60)}%` }} /><span className="tabular-nums">{formatBRL(d.revenue)}</span></li>)}</ul>
            </Card>
          )}
          {Object.keys(r.skipped).length > 0 && <Card title="Quem ficou de fora"><ul className="text-sm">{Object.entries(r.skipped).map(([k, n]) => <li key={k}>{n} · {SKIP_REASON_LABEL[k] ?? k}</li>)}</ul></Card>}
        </div>
      )}

      {aba === "pessoas" && (
        <Card title={`Pessoas do público${(members ?? []).length >= 500 ? " (primeiras 500)" : ""}`}>
          <p className="mb-2 text-xs text-muted">{c.segment_id ? `Público salvo: ${segment?.name ?? ""}. ` : ""}{describeAudience((c.audience ?? {}) as unknown as AudienceDef).join(" · ")}</p>
          <Table head={["Pessoa", "Grupo", "Cupom"]}>
            {(members ?? []).map((m) => <tr key={m.party_id}><td className="px-3 py-1.5"><Link href={`/clientes/${m.party_id}`} className="hover:underline">{names.get(m.party_id) ?? m.party_id.slice(0, 8)}</Link></td><td className="px-3 py-1.5 text-xs">{m.grp === "HOLDOUT" ? <Badge>controle</Badge> : "recebe"}</td><td className="px-3 py-1.5 text-xs">{m.coupon_id ? "emitido" : "—"}</td></tr>)}
          </Table>
        </Card>
      )}

      {aba === "oferta" && (
        <div className="space-y-4">
          <Card title="Oferta"><p className="text-sm">{OFFER_MODES[offer?.mode ?? "NONE"].label}{offer?.value ? ` · ${offer.kind === "PERCENT" ? `${offer.value}%` : formatBRL(offer.value)}` : ""}{offer?.code ? ` · código ${offer.code}` : ""}{r ? ` · ${r.coupons.used} de ${r.coupons.issued} cupons usados · desconto dado ${formatBRL(r.cost.discount)}` : ""}</p></Card>
          {(coupons ?? []).length > 0 && (
            <Table head={["Código", "Desconto", "Validade", "Origem"]}>
              {(coupons ?? []).map((cp) => <tr key={cp.id}><td className="px-3 py-1.5 font-mono text-xs">{cp.code}</td><td className="px-3 py-1.5 text-xs">{cp.kind === "PERCENT" ? `${cp.value}%` : formatBRL(cp.value)}</td><td className="px-3 py-1.5 text-xs">{cp.valid_to ? when(cp.valid_to) : "—"}</td><td className="px-3 py-1.5 text-xs">{cp.source}</td></tr>)}
            </Table>
          )}
        </div>
      )}

      {aba === "canais" && (
        <div className="space-y-4">
          <Card title="WhatsApp">
            {(dispatches ?? []).length === 0 ? <p className="text-sm text-muted">Sem disparos.</p> : (
              <ul className="divide-y divide-border text-sm">
                {(dispatches ?? []).map((d) => {
                  const ds = DISPATCH_STATUS_LABEL[d.status];
                  return (
                    <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                      <span>{d.filter === "ALL" ? "Disparo principal" : `Lembrete · ${DISPATCH_FILTERS[d.filter]}`} <span className="text-xs text-muted">· {when(d.scheduled_at)}</span> <Badge tone={ds.tone}>{ds.label}</Badge></span>
                      {canWrite && ["SCHEDULED", "SENDING", "DRAFT"].includes(d.status) && <form action={cancelDispatchAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="dispatch_id" value={d.id} /><Button variant="ghost" className="text-danger">Cancelar</Button></form>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card title="Links e QR">
            {(links ?? []).length === 0 ? <p className="text-sm text-muted">Sem links (configure o número público do WhatsApp em Marketing › Links).</p> : (
              <Table head={["Link", "Tipo", "Cliques", "QR"]}>
                {(links ?? []).map((l) => <tr key={l.id}><td className="px-3 py-1.5 text-xs"><span className="font-medium">{l.name}</span><span className="block font-mono text-[11px] text-muted">/r/{l.code}</span></td><td className="px-3 py-1.5 text-xs">{l.kind}</td><td className="px-3 py-1.5 tabular-nums text-xs">{clicks.get(l.id)?.clicks ?? 0}</td><td className="px-3 py-1.5 text-xs"><a className="text-brand" href={`/marketing/links/${l.id}/qr`} target="_blank" rel="noreferrer">Baixar</a></td></tr>)}
              </Table>
            )}
          </Card>
          <Card title="Anúncios da Meta">
            <p className="mb-2 text-xs text-muted">Coloque <span className="font-mono">[c:{c.code}]</span> no nome da campanha na Meta para ligar sozinho, ou escolha abaixo.</p>
            {(audiences ?? []).length > 0 && <p className="mb-2 text-sm">Público na Meta: {(audiences ?? []).map((a) => `${a.kind === "LOOKALIKE" ? "semelhante" : "personalizado"} (${a.status === "READY" ? `pronto, ${a.uploaded ?? 0} contatos` : a.status === "ERROR" ? "erro" : "enviando"})`).join(" · ")}</p>}
            {isAdmin && c.segment_id && c.audience_scope !== "LOCAL" && <form action={sendCampaignAudienceAction} className="mb-3"><input type="hidden" name="id" value={id} /><input type="hidden" name="segment_id" value={c.segment_id} /><Button variant="secondary">Enviar público para a Meta</Button></form>}
            <form action={linkAdsAction} className="space-y-2">
              <input type="hidden" name="id" value={id} />
              {(metaCamps ?? []).length === 0 ? <p className="text-sm text-muted">Nenhuma campanha da Meta sincronizada ainda.</p> : (
                <ul className="max-h-56 space-y-1 overflow-auto text-sm">{(metaCamps ?? []).map((m) => {
                  const mine = (adLinks ?? []).find((l) => l.meta_campaign_id === m.meta_campaign_id);
                  const other = m.linked_to && m.linked_to !== id;
                  return <li key={m.meta_campaign_id}><label className="flex items-center gap-2"><input type="checkbox" name="meta_ids" value={m.meta_campaign_id} defaultChecked={!!mine} disabled={!!other || !canWrite || mine?.source === "TAG"} /> {m.meta_campaign_name}<span className="text-xs text-muted"> · gasto {formatBRL(m.spend)}{mine?.source === "TAG" ? " · ligada pela tag" : other ? " · de outra campanha" : ""}</span></label></li>;
                })}</ul>
              )}
              {canWrite && (metaCamps ?? []).length > 0 && <Button variant="secondary">Salvar vínculos</Button>}
            </form>
          </Card>
        </div>
      )}

      {aba === "config" && (
        <div className="space-y-4">
          {canWrite && live && (
            <Card title="Ajustes da campanha ativa">
              <form action={updateActiveCampaignAction} className="grid gap-3 sm:grid-cols-4 sm:items-end">
                <input type="hidden" name="id" value={id} />
                <Field label="Nome"><input name="name" required minLength={3} defaultValue={c.name} className={inputClass} /></Field>
                <Field label="Fim"><input name="ends_at" type="datetime-local" defaultValue={local(c.ends_at)} className={inputClass} /></Field>
                <Field label="Orçamento (R$)"><input name="budget" type="number" step="0.01" min={0} defaultValue={c.budget ?? ""} className={inputClass} /></Field>
                <Button variant="secondary">Salvar</Button>
              </form>
              <p className="mt-2 text-xs text-muted">Público, oferta e grupo de controle ficam congelados depois do lançamento. Para um lembrete novo, use a aba Canais após cancelar o que não vale mais.</p>
            </Card>
          )}
          {canWrite && live && (
            <div className="flex flex-wrap gap-2">
              <form action={endCampaignAction}><input type="hidden" name="id" value={id} /><Button variant="secondary">Encerrar campanha</Button></form>
              <form action={cancelCampaignAction}><input type="hidden" name="id" value={id} /><Button variant="ghost" className="text-danger">Cancelar (quem não recebeu não receberá)</Button></form>
            </div>
          )}
          {!live && <p className="text-sm text-muted">Campanha {st.label}: não pode mais ser alterada.</p>}
        </div>
      )}
    </>
  );
}
