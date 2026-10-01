import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Stat, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { deleteBudgetAction, inviteGroupAction, inviteOneAction, removeGuestAction, saveBudgetAction, setEventStatusAction, setRsvpAction, setPresaleAction } from "../actions";
import { EventForm, KIND, STATUS, when, type EventInitial } from "../event-form";

/** Instante ISO → "AAAA-MM-DDTHH:MM" no fuso de São Paulo (valor do campo datetime-local). */
const localInput = (iso: string) => new Date(iso).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).slice(0, 16).replace(" ", "T");

export const metadata = { title: "Evento" };

const RSVP: Record<string, { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" }> = {
  INVITED: { label: "convidada", tone: "neutral" }, CONFIRMED: { label: "confirmada", tone: "info" }, WAITLIST: { label: "lista de espera", tone: "warning" },
  ATTENDED: { label: "compareceu", tone: "success" }, DECLINED: { label: "recusou", tone: "danger" }, NO_SHOW: { label: "não veio", tone: "danger" },
};
const SOURCE: Record<string, string> = { MANUAL: "manual", TRAINER: "trainer", CUSTOMER: "cliente", SEGMENT: "grupo", AI: "IA" };
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

interface Results { guests: Record<string, number>; headcount: number; capacity: number | null; revenue: number; margin: number; orders: number; buyers: number; avg_ticket: number | null; target_revenue: number | null; planned: number; spent: number; roi: number | null }

export default async function EventoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const { id } = await params;
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const supabase = await createClient();
  const { data: ev } = await supabase.schema("mkt").from("events").select("*").eq("id", id).maybeSingle();
  if (!ev) notFound();
  const mkt = supabase.schema("mkt");
  const [{ data: guests }, { data: lines }, resultsRes, salesRes, { data: collections }] = await Promise.all([
    mkt.from("event_guests").select("id, party_id, rsvp_status, plus_ones, source, checked_in_at").eq("event_id", id).order("created_at"),
    mkt.from("event_budget_lines").select("id, category, planned, memo").eq("event_id", id).order("created_at"),
    mkt.rpc("event_results", { p_event: id }),
    mkt.rpc("event_guest_sales", { p_event: id }),
    supabase.schema("catalog").from("collections").select("id, name").order("name"),
  ]);
  const r = (resultsRes.data ?? {}) as unknown as Partial<Results>;
  const sold = new Map(((salesRes.data ?? []) as { party_id: string; orders: number; revenue: number }[]).map((s) => [s.party_id, s]));
  const partyIds = (guests ?? []).map((g) => g.party_id);
  const { data: parties } = partyIds.length ? await supabase.schema("crm").from("parties").select("id, display_name, tier").in("id", partyIds) : { data: [] as { id: string; display_name: string; tier: string }[] };
  const party = new Map((parties ?? []).map((p) => [p.id, p]));
  const st = STATUS[ev.status];
  const open = ev.status !== "DONE" && ev.status !== "CANCELLED";
  const stores = session.stores.map((s) => ({ id: s.id, name: s.name }));
  const initial: EventInitial = { id: ev.id, kind: ev.kind, name: ev.name, store_id: ev.store_id, starts_at: ev.starts_at, ends_at: ev.ends_at, venue: ev.venue, capacity: ev.capacity, target_revenue: ev.target_revenue, collection_id: ev.collection_id, notes: ev.notes };
  const invited = (guests ?? []).length;

  return (
    <>
      <PageHeader title={ev.name} description={`${KIND[ev.kind]} · ${when(ev.starts_at)}${ev.venue ? ` · ${ev.venue}` : ""}`}
        actions={<div className="flex items-center gap-2"><Badge tone={st.tone}>{st.label}</Badge><Link href="/marketing/eventos" className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Eventos</Link></div>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {ev.kind === "DROP" && (
        <form action={setPresaleAction} className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-3 text-sm">
          <input type="hidden" name="event_id" value={ev.id} />
          <span className="w-full text-xs text-muted">Pré-venda VIP: as VIPs (convide pelo grupo “VIP” abaixo) reservam antes; o público entra na abertura.</span>
          <label className="text-xs text-muted">Pré-venda a partir de<input type="datetime-local" name="presale" defaultValue={ev.presale_starts_at ? localInput(ev.presale_starts_at) : ""} className="mt-1 block rounded-lg border border-border bg-bg px-2 py-1 text-sm" /></label>
          <label className="text-xs text-muted">Abertura ao público<input type="datetime-local" name="public" defaultValue={ev.public_starts_at ? localInput(ev.public_starts_at) : ""} className="mt-1 block rounded-lg border border-border bg-bg px-2 py-1 text-sm" /></label>
          <button className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2">Salvar datas</button>
        </form>
      )}

      {canWrite && open && (
        <div className="mb-4 flex flex-wrap gap-2">
          {ev.status === "PLANNED" && <form action={setEventStatusAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="status" value="CONFIRMED" /><Button variant="secondary">Confirmar evento</Button></form>}
          <form action={setEventStatusAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="status" value="DONE" /><Button variant="secondary">Encerrar (quem confirmou e não veio vira “não veio”)</Button></form>
          <form action={setEventStatusAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="status" value="CANCELLED" /><Button variant="ghost" className="text-danger">Cancelar evento</Button></form>
        </div>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Convidadas" value={invited} hint={`${r.guests?.ATTENDED ?? 0} compareceram`} />
        <Stat label="Confirmadas" value={`${r.headcount ?? 0}${ev.capacity != null ? ` / ${ev.capacity}` : ""}`} hint="Com acompanhantes" tone={ev.capacity != null && (r.headcount ?? 0) >= ev.capacity ? "warning" : undefined} />
        <Stat label="Vendas das convidadas" value={formatBRL(r.revenue ?? 0)} hint={`${r.orders ?? 0} pedido(s) · ${r.buyers ?? 0} compradora(s)${ev.target_revenue ? ` · meta ${formatBRL(Number(ev.target_revenue))}` : ""}`} tone={ev.target_revenue && (r.revenue ?? 0) >= Number(ev.target_revenue) ? "success" : undefined} />
        <Stat label="Custo real" value={formatBRL(r.spent ?? 0)} hint={`Orçado ${formatBRL(r.planned ?? 0)}`} tone={(r.planned ?? 0) > 0 && (r.spent ?? 0) > (r.planned ?? 0) ? "danger" : undefined} />
        <Stat label="ROI" value={r.roi != null ? pct(r.roi) : "—"} hint={r.roi != null ? `Margem ${formatBRL(r.margin ?? 0)} menos o custo` : "Aparece quando houver custo lançado no centro de custo do evento"} tone={r.roi != null ? (r.roi >= 0 ? "success" : "danger") : undefined} />
      </div>

      <Card title="Convidadas" className="mb-4">
        {canWrite && open && (
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <form action={inviteOneAction} className="flex items-end gap-2">
              <input type="hidden" name="event_id" value={id} />
              <Field label="Convidar uma pessoa" hint="Nome ou telefone"><input name="party" required minLength={2} className={`${inputClass} w-56`} placeholder="Ana Souza" /></Field>
              <Button variant="secondary">Convidar</Button>
            </form>
            <form action={inviteGroupAction} className="flex items-end gap-2">
              <input type="hidden" name="event_id" value={id} />
              <Field label="Convidar um grupo" hint="Até 200, pelas de maior score"><select name="group" defaultValue="" required className={`${inputClass} w-56`}><option value="" disabled>Escolha…</option><option value="VIP">Clientes VIP</option><option value="CUSTOMER">Todas as clientes</option><option value="HOT_LEADS">Leads quentes (score 60+)</option></select></Field>
              <Button variant="secondary">Convidar grupo</Button>
            </form>
          </div>
        )}
        {(guests ?? []).length === 0 ? <Empty title="Ninguém convidado ainda" /> : (
          <Table head={["Pessoa", "Origem", "Situação", "Acompanhantes", "Comprou", canWrite ? "Atualizar" : ""]}>
            {(guests ?? []).map((g) => {
              const p = party.get(g.party_id);
              const s = RSVP[g.rsvp_status];
              const buy = sold.get(g.party_id);
              return (
                <tr key={g.id}>
                  <td className="px-3 py-2 font-medium"><Link href={`/clientes/${g.party_id}`} className="hover:underline">{p?.display_name}</Link>{p?.tier && p.tier !== "STANDARD" && <span className="ml-1"><Badge tone="brand">{p.tier === "VIP_BLACK" ? "VIP black" : "VIP"}</Badge></span>}</td>
                  <td className="px-3 py-2 text-xs">{SOURCE[g.source]}</td>
                  <td className="px-3 py-2"><Badge tone={s.tone}>{s.label}</Badge></td>
                  <td className="px-3 py-2 tabular-nums">{g.plus_ones}</td>
                  <td className="px-3 py-2 tabular-nums">{buy ? formatBRL(Number(buy.revenue)) : "—"}</td>
                  <td className="px-3 py-2">
                    {canWrite && ev.status !== "CANCELLED" && (
                      <div className="flex flex-wrap items-center gap-1">
                        <form action={setRsvpAction} className="flex items-center gap-1">
                          <input type="hidden" name="event_id" value={id} /><input type="hidden" name="guest_id" value={g.id} />
                          <select name="status" defaultValue={g.rsvp_status} className={`${inputClass} w-36 py-1 text-xs`} aria-label="Situação">{Object.entries(RSVP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
                          <input name="plus_ones" type="number" min={0} max={5} defaultValue={g.plus_ones} className={`${inputClass} w-16 py-1 text-xs`} aria-label="Acompanhantes" />
                          <Button variant="secondary" className="px-2 py-1 text-xs">Salvar</Button>
                        </form>
                        <a href={`/marketing/eventos/checkin/qr/${g.id}`} target="_blank" rel="noreferrer" className="px-2 text-xs text-brand">QR</a>
                        {g.rsvp_status !== "ATTENDED" && <form action={removeGuestAction}><input type="hidden" name="event_id" value={id} /><input type="hidden" name="guest_id" value={g.id} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Remover</Button></form>}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card title="Orçamento" className="mb-4">
        {(lines ?? []).length > 0 && (
          <Table head={["Categoria", "Observação", "Orçado", ""]}>
            {(lines ?? []).map((l) => (
              <tr key={l.id}>
                <td className="px-3 py-2 font-medium">{l.category}</td><td className="px-3 py-2 text-xs text-muted">{l.memo}</td><td className="px-3 py-2 tabular-nums">{formatBRL(Number(l.planned))}</td>
                <td className="px-3 py-2">{canWrite && <form action={deleteBudgetAction}><input type="hidden" name="event_id" value={id} /><input type="hidden" name="line_id" value={l.id} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Remover</Button></form>}</td>
              </tr>
            ))}
          </Table>
        )}
        {canWrite && (
          <form action={saveBudgetAction} className="mt-3 grid gap-3 sm:grid-cols-[1fr_8rem_1.5fr_auto] sm:items-end">
            <input type="hidden" name="event_id" value={id} />
            <Field label="Categoria"><input name="category" required minLength={2} maxLength={60} className={inputClass} placeholder="Buffet" /></Field>
            <Field label="Orçado (R$)"><input name="planned" required inputMode="decimal" className={inputClass} placeholder="1.500,00" /></Field>
            <Field label="Observação"><input name="memo" className={inputClass} /></Field>
            <Button variant="secondary">Adicionar</Button>
          </form>
        )}
        <p className="mt-2 text-xs text-muted">{ev.cost_center_id ? "O custo real vem do Financeiro: lance as contas a pagar do evento com o centro de custo do projeto." : "Este evento não tem centro de custo: o custo real e o ROI não aparecem."}</p>
      </Card>

      {canWrite && <Card title="Dados do evento"><EventForm stores={stores} collections={collections ?? []} initial={initial} /></Card>}
    </>
  );
}
