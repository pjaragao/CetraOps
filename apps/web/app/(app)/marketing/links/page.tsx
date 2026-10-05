import Link from "next/link";
import { formatBRL, LINK_KINDS, trackingMessage, trackingUrl } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { isoFromNow, periodBounds, str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { CopyButton } from "@/components/copy-button";
import { saveLinkAction, setChannelAddressAction, toggleLinkAction } from "./actions";

export const metadata = { title: "Links rastreados" };

interface Stat { link_id: string; code: string; name: string; kind: string; active: boolean; touches: number; new_leads: number; buyers: number; orders: number; revenue: number }

export default async function LinksPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const isAdmin = can(session, "core.admin");
  const b = periodBounds(str(sp.periodo));
  const supabase = await createClient();
  const [{ data: links }, { data: stats }, { data: sources }, { data: channels }, { data: affiliates }, { data: events }] = await Promise.all([
    supabase.schema("mkt").from("tracking_links").select("id, code, name, kind, channel_account_id, prefill_text, affiliate_party_id, event_id, active").order("created_at"),
    supabase.schema("mkt").rpc("tracking_link_stats", { p_from: b.from, p_to: b.to }),
    supabase.schema("crm").rpc("lead_sources", { p_from: b.from, p_to: b.to }),
    supabase.schema("omni").from("channel_accounts").select("id, channel, display_name, public_address").in("channel", ["WHATSAPP", "TELEGRAM"]).order("display_name"),
    supabase.schema("aff").from("affiliates").select("party_id").eq("status", "ACTIVE"),
    supabase.schema("mkt").from("events").select("id, name, starts_at").gte("starts_at", isoFromNow(-24 * 30)).order("starts_at"),
  ]);
  const affIds = (affiliates ?? []).map((a) => a.party_id);
  const { data: affNames } = affIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", affIds).order("display_name") : { data: [] as { id: string; display_name: string }[] };
  const ch = new Map((channels ?? []).map((c) => [c.id, c]));
  const st = new Map(((stats ?? []) as unknown as Stat[]).map((s) => [s.link_id, s]));
  const editing = (links ?? []).find((l) => l.id === str(sp.editar));
  const missing = (channels ?? []).filter((c) => !c.public_address);

  return (
    <>
      <PageHeader title="Links rastreados" description="Um link (ou QR) para cada lugar: recepção e vestiário da academia parceira, bio, stories, trainers, eventos. Quando a cliente manda a primeira mensagem, o sistema reconhece o código e registra de onde ela veio — e o que ela comprou depois."
        actions={<span className="text-xs text-muted">Período: {b.from.split("-").reverse().join("/")} a {b.to.split("-").reverse().join("/")}</span>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

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

      {(links ?? []).length === 0 ? <Empty title="Nenhum link ainda">Crie o primeiro abaixo, por exemplo o QR da recepção da academia.</Empty> : (
        <Table head={["Link", "Tipo", "Endereço", "Conversas", "Leads novas", "Compraram", "Receita", ""]}>
          {(links ?? []).map((l) => {
            const c = ch.get(l.channel_account_id);
            const url = c ? trackingUrl(c.channel, c.public_address, l.code, l.prefill_text) : null;
            const s = st.get(l.id);
            return (
              <tr key={l.id} className={l.active ? "" : "opacity-60"}>
                <td className="px-3 py-2"><span className="font-medium">{l.name}</span><span className="block font-mono text-[11px] text-muted">{l.code} · {c?.display_name}</span></td>
                <td className="px-3 py-2 text-xs">{LINK_KINDS[l.kind] ?? l.kind}{!l.active && <span className="ml-1"><Badge>pausado</Badge></span>}</td>
                <td className="px-3 py-2">
                  {url ? (
                    <div className="flex flex-wrap items-center gap-1">
                      <CopyButton text={url} label="Copiar link" />
                      <a className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-surface-2" href={`/marketing/links/${l.id}/qr`} target="_blank" rel="noreferrer">QR (PNG)</a>
                      <a className="rounded-lg px-2 py-1 text-xs hover:bg-surface-2" href={`/marketing/links/${l.id}/qr?formato=svg`}>SVG</a>
                    </div>
                  ) : <span className="text-xs text-warning">cadastre o número do canal</span>}
                </td>
                <td className="px-3 py-2 tabular-nums">{s?.touches ?? 0}</td>
                <td className="px-3 py-2 tabular-nums">{s?.new_leads ?? 0}</td>
                <td className="px-3 py-2 tabular-nums">{s?.buyers ?? 0}</td>
                <td className="px-3 py-2 tabular-nums">{formatBRL(Number(s?.revenue ?? 0))}</td>
                <td className="px-3 py-2">
                  {canWrite && (
                    <div className="flex items-center gap-1">
                      <Link className="rounded-lg px-2 py-1 text-xs hover:bg-surface-2" href={`/marketing/links?editar=${l.id}`}>Editar</Link>
                      <form action={toggleLinkAction}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="active" value={l.active ? "0" : "1"} /><Button variant="ghost" className="px-2 py-1 text-xs">{l.active ? "Pausar" : "Reativar"}</Button></form>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <p className="mt-1 text-xs text-muted">Compraram e receita: vendas pagas dessas pessoas depois do primeiro toque no link (até 30 dias após o período).</p>

      {canWrite && (
        <Card className="mt-4" title={editing ? `Editar: ${editing.name}` : "Novo link"}>
          {(channels ?? []).length === 0 ? <p className="text-sm text-muted">Cadastre um canal de WhatsApp ou Telegram em Configurações › Integrações.</p> : (
            <form key={editing?.id ?? "novo"} action={saveLinkAction} className="space-y-3">
              {editing && <input type="hidden" name="id" value={editing.id} />}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Nome"><input name="name" required minLength={3} maxLength={80} defaultValue={editing?.name} className={inputClass} placeholder="QR da recepção da academia" /></Field>
                <Field label="Código" hint="3 a 23 letras minúsculas, números ou hífen"><input name="code" required pattern="[a-z0-9][a-z0-9\-]{2,22}" defaultValue={editing?.code} className={`${inputClass} font-mono`} placeholder="qr-recepcao" /></Field>
                <Field label="Tipo"><select name="kind" defaultValue={editing?.kind ?? "QR"} className={inputClass}>{Object.entries(LINK_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="Canal"><select name="channel_account_id" required defaultValue={editing?.channel_account_id ?? channels?.[0]?.id} className={inputClass}>{(channels ?? []).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></Field>
              </div>
              <Field label="Texto pronto (WhatsApp)" hint={`A mensagem sai assim: “${trackingMessage("codigo", editing?.prefill_text ?? "Oi! Vim pelo QR da recepção.")}”. Se a cliente apagar o código, a origem não é registrada.`}>
                <input name="prefill_text" maxLength={200} defaultValue={editing?.prefill_text ?? ""} className={inputClass} placeholder="Oi! Vim pelo QR da recepção." />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Trainer (opcional)" hint="A cliente ganha a etiqueta 'indicacao' e pontos no score">
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
