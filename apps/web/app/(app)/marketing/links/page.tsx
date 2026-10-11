import Link from "next/link";
import { formatBRL, LINK_KINDS, shortLink, trackingUrl } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { isoFromNow, periodBounds, str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { CopyButton } from "@/components/copy-button";
import { saveLinkAction, setChannelAddressAction, setPublicUrlAction, toggleLinkAction } from "./actions";

export const metadata = { title: "Links rastreados" };

interface Stat { link_id: string; code: string; name: string; kind: string; active: boolean; touches: number; new_leads: number; buyers: number; orders: number; revenue: number }
interface ClickStat { link_id: string; clicks: number; clicks_ad: number; last_click: string | null }

export default async function LinksPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const isAdmin = can(session, "core.admin");
  const b = periodBounds(str(sp.periodo));
  const campFilter = str(sp.campanha);
  const supabase = await createClient();
  const [{ data: links }, { data: stats }, { data: clickStats }, { data: sources }, { data: channels }, { data: affiliates }, { data: events }, { data: campaigns }, { data: pubUrlSetting }] = await Promise.all([
    supabase.schema("mkt").from("tracking_links").select("id, code, name, kind, channel_account_id, prefill_text, affiliate_party_id, event_id, active, campaign_id, target, target_url").order("created_at", { ascending: false }),
    supabase.schema("mkt").rpc("tracking_link_stats", { p_from: b.from, p_to: b.to }),
    supabase.schema("mkt").rpc("link_click_stats", { p_from: b.from, p_to: b.to }),
    supabase.schema("crm").rpc("lead_sources", { p_from: b.from, p_to: b.to }),
    supabase.schema("omni").from("channel_accounts").select("id, channel, display_name, public_address").in("channel", ["WHATSAPP", "TELEGRAM"]).order("display_name"),
    supabase.schema("aff").from("affiliates").select("party_id").eq("status", "ACTIVE"),
    supabase.schema("mkt").from("events").select("id, name, starts_at").gte("starts_at", isoFromNow(-24 * 30)).order("starts_at"),
    supabase.schema("mkt").from("campaigns").select("id, name, code").order("created_at", { ascending: false }),
    supabase.schema("core").from("settings").select("value").eq("key", "public_url").maybeSingle(),
  ]);
  const publicBase = (pubUrlSetting?.value as { base?: string } | null)?.base ?? null;
  const affIds = (affiliates ?? []).map((a) => a.party_id);
  const { data: affNames } = affIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", affIds).order("display_name") : { data: [] as { id: string; display_name: string }[] };
  const ch = new Map((channels ?? []).map((c) => [c.id, c]));
  const campMap = new Map((campaigns ?? []).map((c) => [c.id, c]));
  const st = new Map(((stats ?? []) as unknown as Stat[]).map((s) => [s.link_id, s]));
  const clk = new Map(((clickStats ?? []) as unknown as ClickStat[]).map((s) => [s.link_id, s]));
  const filteredLinks = (links ?? []).filter((l) => (campFilter ? l.campaign_id === campFilter : true));
  const editing = (links ?? []).find((l) => l.id === str(sp.editar));
  const missing = (channels ?? []).filter((c) => !c.public_address);

  return (
    <>
      <PageHeader title="Links & QR" description="Um link curto (/r/código) ou QR para cada lugar: stories, bio, impressos, trainers e campanhas. Registra cliques e toques que entram pelo WhatsApp."
        actions={<span className="text-xs text-muted">Período: {b.from.split("-").reverse().join("/")} a {b.to.split("-").reverse().join("/")}</span>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      {!publicBase && isAdmin && (
        <Card className="mb-4" title="Endereço público do sistema">
          <p className="mb-2 text-sm text-muted">Defina o endereço completo do sistema para ativar os links curtos (/r/código) e os QR codes impressos.</p>
          <form action={setPublicUrlAction} className="flex flex-wrap items-end gap-2">
            <Field label="URL do sistema (ex.: https://app.meudominio.com.br)"><input name="base" required type="url" className={inputClass} placeholder="https://app.meudominio.com.br" /></Field>
            <Button variant="secondary">Salvar URL</Button>
          </form>
        </Card>
      )}

      {missing.length > 0 && (
        <Card className="mb-4" title="Falta o endereço público do canal">
          <p className="mb-2 text-sm text-muted">Sem o número do WhatsApp (com DDI) ou o @ do bot do Telegram não dá para montar o link.</p>
          {isAdmin ? missing.map((c) => (
            <form key={c.id} action={setChannelAddressAction} className="mb-2 flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={c.id} />
              <Field label={c.display_name}><input name="address" required className={inputClass} placeholder={c.channel === "WHATSAPP" ? "55 48 99999-0000" : "@minhalojabot"} /></Field>
              <Button variant="secondary">Salvar</Button>
            </form>
          )) : <p className="text-sm">Peça a um sócio para cadastrar.</p>}
        </Card>
      )}

      {(campaigns ?? []).length > 0 && (
        <nav aria-label="Filtro de campanha" className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Campanha:</span>
          <Link href="/marketing/links"><Badge tone={!campFilter ? "brand" : "neutral"}>Todas</Badge></Link>
          {(campaigns ?? []).map((cp) => <Link key={cp.id} href={`/marketing/links?campanha=${cp.id}`}><Badge tone={campFilter === cp.id ? "brand" : "neutral"}>{cp.name}</Badge></Link>)}
        </nav>
      )}

      {filteredLinks.length === 0 ? <Empty title="Nenhum link ainda">Crie o primeiro abaixo, por exemplo o QR da recepção da academia.</Empty> : (
        <Table head={["Link", "Tipo", "Campanha", "Cliques", "Conversas", "Leads novas", "Compraram", "Receita", ""]}>
          {filteredLinks.map((l) => {
            const c = l.channel_account_id ? ch.get(l.channel_account_id) : undefined;
            const directUrl = c ? trackingUrl(c.channel, c.public_address, l.code, l.prefill_text) : l.target_url;
            const shortUrl = shortLink(publicBase, l.code);
            const copyUrl = shortUrl ?? directUrl;
            const s = st.get(l.id);
            const cs = clk.get(l.id);
            const camp = l.campaign_id ? campMap.get(l.campaign_id) : undefined;
            return (
              <tr key={l.id} className={l.active ? "" : "opacity-60"}>
                <td className="px-3 py-2"><span className="font-medium">{l.name}</span><span className="block font-mono text-[11px] text-muted">/r/{l.code} {c ? `· ${c.display_name}` : ""}</span></td>
                <td className="px-3 py-2 text-xs">{LINK_KINDS[l.kind] ?? l.kind}{!l.active && <span className="ml-1"><Badge>pausado</Badge></span>}</td>
                <td className="px-3 py-2 text-xs">{camp ? <Link href={`/marketing/campanhas/${camp.id}`} className="text-brand hover:underline">{camp.name}</Link> : <span className="text-muted">—</span>}</td>
                <td className="px-3 py-2 tabular-nums text-xs">{cs?.clicks ?? 0}{cs?.clicks_ad ? ` (${cs.clicks_ad} de anúncios)` : ""}</td>
                <td className="px-3 py-2 tabular-nums text-xs">{s?.touches ?? 0}</td>
                <td className="px-3 py-2 tabular-nums text-xs">{s?.new_leads ?? 0}</td>
                <td className="px-3 py-2 tabular-nums text-xs">{s?.buyers ?? 0}</td>
                <td className="px-3 py-2 tabular-nums text-xs">{formatBRL(Number(s?.revenue ?? 0))}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1">
                    {copyUrl && <CopyButton text={copyUrl} label="Copiar" />}
                    <a className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-surface-2" href={`/marketing/links/${l.id}/qr`} target="_blank" rel="noreferrer">QR</a>
                    {canWrite && (
                      <>
                        <Link className="rounded-lg px-2 py-1 text-xs hover:bg-surface-2" href={`/marketing/links?editar=${l.id}`}>Editar</Link>
                        <form action={toggleLinkAction}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="active" value={l.active ? "0" : "1"} /><Button variant="ghost" className="px-2 py-1 text-xs">{l.active ? "Pausar" : "Ativar"}</Button></form>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <p className="mt-1 text-xs text-muted">Cliques: acessos na rota curta /r/código. Conversas, leads e compras: pessoas que mandaram mensagem e compraram após o toque no link.</p>

      {canWrite && (
        <Card className="mt-4" title={editing ? `Editar: ${editing.name}` : "Novo link"}>
          {(channels ?? []).length === 0 ? <p className="text-sm text-muted">Cadastre um canal de WhatsApp ou Telegram em Configurações › Integrações.</p> : (
            <form key={editing?.id ?? "novo"} action={saveLinkAction} className="space-y-3">
              {editing && <input type="hidden" name="id" value={editing.id} />}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Nome"><input name="name" required minLength={3} maxLength={80} defaultValue={editing?.name} className={inputClass} placeholder="QR da recepção da academia" /></Field>
                <Field label="Código" hint="3 a 23 letras minúsculas, números ou hífen"><input name="code" required pattern="[a-z0-9][a-z0-9\-]{2,22}" defaultValue={editing?.code} className={`${inputClass} font-mono`} placeholder="qr-recepcao" /></Field>
                <Field label="Tipo"><select name="kind" defaultValue={editing?.kind ?? "QR"} className={inputClass}>{Object.entries(LINK_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="Canal"><select name="channel_account_id" defaultValue={editing?.channel_account_id ?? channels?.[0]?.id} className={inputClass}><option value="">— Página externa (web) —</option>{(channels ?? []).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Texto pronto (WhatsApp)" hint={`Mensagem com o código: se a cliente apagar o código, a origem não é registrada.`}>
                  <input name="prefill_text" maxLength={200} defaultValue={editing?.prefill_text ?? ""} className={inputClass} placeholder="Oi! Vim pelo QR da recepção." />
                </Field>
                <Field label="Página de destino (se destino web)"><input name="target_url" type="url" defaultValue={editing?.target_url ?? ""} className={inputClass} placeholder="https://..." /></Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Campanha (opcional)">
                  <select name="campaign_id" defaultValue={editing?.campaign_id ?? ""} className={inputClass}><option value="">—</option>{(campaigns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                </Field>
                <Field label="Trainer (opcional)" hint="Indicação de afiliada">
                  <select name="affiliate_party_id" defaultValue={editing?.affiliate_party_id ?? ""} className={inputClass}><option value="">—</option>{(affNames ?? []).map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select>
                </Field>
                <Field label="Evento (opcional)">
                  <select name="event_id" defaultValue={editing?.event_id ?? ""} className={inputClass}><option value="">—</option>{(events ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
                </Field>
              </div>
              <div className="flex items-center gap-3"><Button>{editing ? "Salvar link" : "Criar link"}</Button>{editing && <Link href="/marketing/links" className="text-xs text-brand">Cancelar</Link>}</div>
            </form>
          )}
        </Card>
      )}

      <h2 className="mb-2 mt-8 text-sm font-semibold">De onde vieram as leads novas do período</h2>
      {(sources ?? []).length === 0 ? <Empty title="Nenhuma lead nova no período" /> : (
        <Table head={["Origem", "Leads", "Já compraram"]}>
          {(sources ?? []).map((s) => <tr key={s.source}><td className="px-3 py-2 font-mono text-xs">{s.source}</td><td className="px-3 py-2 tabular-nums">{s.leads}</td><td className="px-3 py-2 tabular-nums">{s.buyers}</td></tr>)}
        </Table>
      )}
    </>
  );
}
