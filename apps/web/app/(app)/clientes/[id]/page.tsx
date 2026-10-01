import Link from "next/link";
import { notFound } from "next/navigation";
import { CONSENT_LABEL, formatBRL, scoreBand, SEGMENTS, STAGE_LABEL, TIER_LABEL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { daysSince, str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, LinkButton, PageHeader, Stat } from "@/components/ui";
import { Flash } from "@/components/form";
import { ForHerNow, type ForHerNowData } from "@/components/for-her-now";
import { addInterestAction, cancelInterestAction, refreshLifecycleAction, setConsentAction } from "../actions";
import { openCaseAction, recordNpsAction } from "../casos/actions";

export const metadata = { title: "Cliente 360°" };

const SIZE_LABEL: Record<string, string> = { top: "Top", bottom: "Calça/short", bra: "Top/sutiã", shoe: "Calçado" };
const JOY_LABEL: Record<string, string> = { UNKNOWN: "não informado", SELF_DECLARED: "autodeclarada", CONFIRMED_IN_STORE: "confirmada na loja" };
const CHANNELS: [string, string][] = [["BALCAO", "No balcão"], ["TELEFONE", "Por telefone"], ["EVENTO", "Em evento"], ["WHATSAPP", "Pelo WhatsApp"], ["INSTAGRAM", "Pelo Instagram"], ["EMAIL", "Por e-mail"]];

interface ScoreItem { key: string; label: string; points: number }

export default async function Cliente360({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const sp = await searchParams;
  const session = await requirePerm("crm.read");
  const canWrite = can(session, "crm.write");
  const supabase = await createClient();

  const { data: p } = await supabase.schema("crm").from("parties").select("*").eq("id", id).maybeSingle();
  if (!p) notFound();

  const [contacts, consents, timeline, orders, convs, credit, metrics, owner, alerts, products] = await Promise.all([
    supabase.schema("crm").from("party_contact_points").select("type, value_display, is_primary").eq("party_id", id),
    supabase.schema("crm").from("v_current_consents").select("purpose, granted, legal_basis, created_at, evidence").eq("party_id", id),
    supabase.schema("crm").from("timeline_events").select("id, occurred_at, kind, summary").eq("party_id", id).order("occurred_at", { ascending: false }).limit(30),
    can(session, "sales.read")
      ? supabase.schema("sales").from("orders").select("id, number, total, channel, created_at, payments(method, installments)").eq("party_id", id).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as never[] }),
    can(session, "omni.read")
      ? supabase.schema("omni").from("conversations").select("id, mode, status, last_message_at, channel_accounts:channel_account_id(channel)").eq("party_id", id).order("last_message_at", { ascending: false })
      : Promise.resolve({ data: [] as never[] }),
    supabase.schema("sales").rpc("store_credit_balance", { p_party: id }),
    supabase.schema("crm").from("customer_metrics").select("*").eq("party_id", id).maybeSingle(),
    p.relationship_owner_member_id ? supabase.schema("core").from("members").select("display_name").eq("id", p.relationship_owner_member_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.schema("crm").from("interest_alerts").select("id, product_id, size, note, status, created_via, created_at, notified_at").eq("party_id", id).order("created_at", { ascending: false }).limit(10),
    supabase.schema("catalog").from("products").select("id, name").eq("status", "ACTIVE").order("name").limit(300),
  ]);
  const { data: forHer } = await supabase.schema("crm").rpc("for_her_now", { p_party: id });
  const productName = new Map((products.data ?? []).map((x) => [x.id, x.name]));

  const list = orders.data ?? [];
  const ltv = list.reduce((a, o) => a + Number(o.total), 0);
  const ticket = list.length ? ltv / list.length : 0;
  const pays = list.flatMap((o) => o.payments ?? []);
  const favMethod = Object.entries(pays.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.method]: (acc[x.method] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0]?.[0];
  const avgInst = pays.filter((x) => x.method === "CREDIT").reduce((a, x, _, arr) => a + x.installments / arr.length, 0);
  const since = daysSince(p.last_purchase_at);
  const m = metrics.data;
  const sb = (p.score_breakdown ?? {}) as { items?: ScoreItem[]; hot?: number; warm?: number; computed_at?: string };
  const band = scoreBand(p.lead_score, sb.hot, sb.warm);
  const prefs = (p.preferences ?? {}) as { activities?: string[]; notes?: string };
  const seg = m ? SEGMENTS[m.rfm_segment] : undefined;

  return (
    <>
      <PageHeader title={p.display_name} description={[p.profession, p.city, p.instagram_handle && `@${p.instagram_handle}`].filter(Boolean).join(" · ") || "Cliente"}
        actions={<div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="brand">{STAGE_LABEL[p.lifecycle_stage] ?? p.lifecycle_stage}</Badge>
          {p.tier !== "STANDARD" && <Badge tone="warning">{TIER_LABEL[p.tier]}</Badge>}
          {m?.at_risk && <Badge tone="danger">em risco</Badge>}
          <Badge tone={band.tone}>score {p.lead_score} · {band.label}</Badge>
          {canWrite && <LinkButton href={`/clientes/${id}/editar`}>Editar ficha</LinkButton>}
          <LinkButton href={`/cadastros/${id}`}>Cadastro completo</LinkButton>
        </div>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="LTV (total comprado)" value={formatBRL(ltv)} hint={`${list.length} compras`} />
        <Stat label="Ticket médio" value={formatBRL(ticket)} />
        <Stat label="Dias desde a última compra" value={since ?? "—"} tone={m?.at_risk ? "danger" : since !== null && since > 60 ? "warning" : undefined}
          hint={m?.avg_interval_days ? `costuma comprar a cada ${Math.round(Number(m.avg_interval_days))} dias` : undefined} />
        <Stat label="Vale-troca disponível" value={formatBRL(Number(credit.data ?? 0))} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Ciclo de vida" action={canWrite ? <form action={refreshLifecycleAction}><input type="hidden" name="id" value={id} /><Button variant="ghost" className="px-2 py-1 text-xs">Recalcular</Button></form> : undefined}>
          <ul className="space-y-1.5 text-sm">
            <li className="flex justify-between gap-2"><span className="text-muted">Estágio</span><span>{STAGE_LABEL[p.lifecycle_stage]}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Nível</span><span>{TIER_LABEL[p.tier]}{p.tier_manual ? " (definido à mão)" : ""}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Segmento</span><span title={seg?.hint}>{seg?.label ?? "—"}</span></li>
            {seg && <li className="text-xs text-muted">Sugestão: {seg.action}</li>}
            <li className="flex justify-between gap-2"><span className="text-muted">Compras em 12 meses</span><span>{m ? `${m.orders_12m} · ${formatBRL(Number(m.revenue_12m))}` : "—"}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Dona do relacionamento</span><span>{owner.data?.display_name ?? "—"}</span></li>
          </ul>
        </Card>
        <Card title={`Por que o score é ${p.lead_score}`}>
          {(sb.items ?? []).length === 0 ? <p className="text-sm text-muted">Nenhum sinal ainda. Completar a ficha (profissão, atividades, cidade) ajuda.</p> : (
            <ul className="space-y-1 text-sm">{(sb.items ?? []).map((it) => (
              <li key={it.key} className="flex justify-between gap-2"><span>{it.label}</span><span className="tabular-nums text-muted">+{it.points}</span></li>
            ))}</ul>
          )}
          <p className="mt-2 text-xs text-muted">Quente a partir de {sb.hot ?? 70}, morna a partir de {sb.warm ?? 40}. A cliente pode pedir a revisão desta avaliação (LGPD).</p>
        </Card>
        <Card title="Perfil e preferências">
          <ul className="space-y-1.5 text-sm">
            <li className="flex justify-between gap-2"><span className="text-muted">Tamanhos</span><span>{Object.entries((p.sizes ?? {}) as Record<string, string>).map(([k, v]) => `${SIZE_LABEL[k] ?? k} ${v}`).join(" · ") || "—"}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Atividades</span><span>{prefs.activities?.join(", ") || "—"}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Aniversário</span><span>{p.birth_date ? p.birth_date.slice(5).split("-").reverse().join("/") : "—"}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Pagamento preferido</span><span>{favMethod ?? "—"}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Parcelamento médio</span><span>{avgInst ? `${avgInst.toFixed(1)}x` : "—"}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Aluna JOY</span><span>{JOY_LABEL[p.joy_member_status] ?? p.joy_member_status}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Origem</span><span>{p.source ?? "—"}</span></li>
            {(p.tags ?? []).length > 0 && <li className="flex flex-wrap gap-1 pt-1">{p.tags.map((t: string) => <Badge key={t}>{t}</Badge>)}</li>}
            {prefs.notes && <li className="rounded-lg bg-surface-2 p-2 text-xs">{prefs.notes}</li>}
          </ul>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Contatos e aceites (LGPD)">
          <ul className="space-y-1 text-sm">{(contacts.data ?? []).map((c) => (
            <li key={c.type + c.value_display} className="flex justify-between gap-2"><span className="text-muted">{c.type}</span><span className="truncate">{c.value_display}</span></li>
          ))}</ul>
          <h3 className="mb-1 mt-4 text-xs font-semibold text-muted">Aceites</h3>
          {(consents.data ?? []).length === 0 ? <p className="text-sm text-muted">Nenhum registrado.</p> : (
            <ul className="space-y-1 text-sm">{(consents.data ?? []).map((c) => (
              <li key={c.purpose} className="flex justify-between gap-2"><span>{CONSENT_LABEL[c.purpose ?? ""] ?? c.purpose}</span><Badge tone={c.granted ? "success" : "danger"}>{c.granted ? "sim" : "não"}</Badge></li>
            ))}</ul>
          )}
          {canWrite && (
            <form action={setConsentAction} className="mt-3 grid gap-2 rounded-lg border border-border p-2">
              <input type="hidden" name="id" value={id} />
              <p className="text-xs font-medium text-muted">Registrar o que ela respondeu</p>
              <select name="purpose" className={inputClass} aria-label="Finalidade" defaultValue="MARKETING_WHATSAPP">
                {["MARKETING_WHATSAPP", "MARKETING_EMAIL", "MARKETING_IG", "IMAGE_USE"].map((k) => <option key={k} value={k}>{CONSENT_LABEL[k]}</option>)}
              </select>
              <select name="channel" className={inputClass} aria-label="Onde" defaultValue="BALCAO">{CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              <div className="flex gap-2">
                <Button name="granted" value="1" className="flex-1 px-2 py-1 text-xs">Aceitou</Button>
                <Button name="granted" value="0" variant="secondary" className="flex-1 px-2 py-1 text-xs">Recusou</Button>
              </div>
            </form>
          )}
        </Card>
        <Card title="Conversas">
          {(convs.data ?? []).length === 0 ? <p className="text-sm text-muted">Nenhuma conversa.</p> : (
            <ul className="space-y-1 text-sm">{(convs.data ?? []).map((c) => (
              <li key={c.id}><Link href={`/atendimento?c=${c.id}`} className="flex justify-between text-brand"><span>{c.channel_accounts?.channel}</span><span className="text-muted">{c.status === "CLOSED" ? "encerrada" : c.mode}</span></Link></li>
            ))}</ul>
          )}
        </Card>
        <Card title="Compras">
          {list.length === 0 ? <Empty title="Nenhuma compra" /> : (
            <ul className="divide-y divide-border text-sm">{list.map((o) => (
              <li key={o.id} className="flex justify-between py-1.5"><span>{o.number} · {o.channel}</span><span>{formatBRL(o.total)}</span></li>
            ))}</ul>
          )}
        </Card>
      </div>

      {forHer && <Card className="mt-4" title="Para ela agora"><ForHerNow data={forHer as unknown as ForHerNowData} /></Card>}

      <Card className="mt-4" title="Avise-me (quando chegar o tamanho)">
        {(alerts.data ?? []).length === 0 ? <p className="text-sm text-muted">Nenhum pedido. Quando faltar o tamanho, registre aqui: ao chegar, ela é avisada e a peça fica separada.</p> : (
          <ul className="space-y-1 text-sm">{(alerts.data ?? []).map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{productName.get(a.product_id) ?? "Produto"} · <b>{a.size}</b>{a.note ? ` · ${a.note}` : ""} <span className="text-xs text-muted">({a.created_via === "AI" ? "pela IA" : "pela equipe"})</span></span>
              <span className="flex items-center gap-1">
                <Badge tone={a.status === "WAITING" ? "warning" : a.status === "NOTIFIED" ? "success" : "neutral"}>{a.status === "WAITING" ? "aguardando" : a.status === "NOTIFIED" ? "avisada" : "cancelado"}</Badge>
                {canWrite && a.status === "WAITING" && <form action={cancelInterestAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="alert_id" value={a.id} /><Button variant="ghost" className="px-2 py-1 text-xs">Cancelar</Button></form>}
              </span>
            </li>
          ))}</ul>
        )}
        {canWrite && (
          <form action={addInterestAction} className="mt-3 grid gap-2 sm:grid-cols-[1fr_6rem_1fr_auto] sm:items-end">
            <input type="hidden" name="id" value={id} />
            <select name="product_id" required className={inputClass} aria-label="Produto" defaultValue=""><option value="" disabled>Produto…</option>{(products.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
            <input name="size" required maxLength={6} placeholder="Tamanho" aria-label="Tamanho" className={`${inputClass} uppercase`} />
            <input name="note" maxLength={200} placeholder="Observação (cor, ocasião…)" aria-label="Observação" className={inputClass} />
            <Button variant="secondary">Registrar</Button>
          </form>
        )}
      </Card>

      {canWrite && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card title="Abrir caso (reclamação, defeito…)">
            <form action={openCaseAction} className="grid gap-2 sm:grid-cols-[9rem_1fr_auto] sm:items-end">
              <input type="hidden" name="party_id" value={id} /><input type="hidden" name="back" value={`/clientes/${id}`} />
              <select name="kind" className={inputClass} aria-label="Tipo do caso" defaultValue="COMPLAINT"><option value="COMPLAINT">Reclamação</option><option value="DEFECT">Defeito / troca</option><option value="DELIVERY">Entrega</option><option value="SERVICE">Atendimento</option><option value="OTHER">Outro</option></select>
              <input name="title" required minLength={3} maxLength={140} placeholder="O que aconteceu" aria-label="O que aconteceu" className={inputClass} />
              <Button variant="secondary">Abrir caso</Button>
            </form>
          </Card>
          <Card title="Registrar NPS (0 a 10)">
            <form action={recordNpsAction} className="grid gap-2 sm:grid-cols-[6rem_1fr_auto] sm:items-end">
              <input type="hidden" name="party_id" value={id} />
              <input name="score" type="number" min={0} max={10} required placeholder="0 a 10" aria-label="Nota NPS" className={inputClass} />
              <input name="comment" maxLength={400} placeholder="O que ela disse (opcional)" aria-label="Comentário do NPS" className={inputClass} />
              <Button variant="secondary">Registrar</Button>
            </form>
          </Card>
        </div>
      )}

      <Card className="mt-4" title="Linha do tempo">
        {(timeline.data ?? []).length === 0 ? <Empty title="Sem eventos" /> : (
          <ol className="space-y-2 text-sm">{(timeline.data ?? []).map((e) => (
            <li key={e.id}><span className="text-xs text-muted">{new Date(e.occurred_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} · {e.kind}</span><br />{e.summary}</li>
          ))}</ol>
        )}
      </Card>
    </>
  );
}
