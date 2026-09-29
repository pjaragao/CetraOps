import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { daysSince } from "@/lib/context";
import { Badge, Card, Empty, PageHeader, Stat } from "@/components/ui";

export const metadata = { title: "Cliente 360°" };

const CONSENT_LABEL: Record<string, string> = {
  TRANSACTIONAL: "Transacional", MARKETING_WHATSAPP: "Marketing WhatsApp", MARKETING_EMAIL: "Marketing e-mail",
  MARKETING_IG: "Marketing Instagram", AI_PROFILING: "Perfilamento por IA", ENRICHMENT: "Enriquecimento", IMAGE_USE: "Uso de imagem",
};

export default async function Cliente360({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requirePerm("crm.read");
  const supabase = await createClient();

  const { data: p } = await supabase.schema("crm").from("parties").select("*").eq("id", id).maybeSingle();
  if (!p) notFound();

  const [contacts, consents, timeline, orders, convs, credit] = await Promise.all([
    supabase.schema("crm").from("party_contact_points").select("type, value_display, is_primary").eq("party_id", id),
    supabase.schema("crm").from("v_current_consents").select("purpose, granted, legal_basis, created_at").eq("party_id", id),
    supabase.schema("crm").from("timeline_events").select("id, occurred_at, kind, summary").eq("party_id", id).order("occurred_at", { ascending: false }).limit(30),
    can(session, "sales.read")
      ? supabase.schema("sales").from("orders").select("id, number, total, channel, created_at, payments(method, installments)").eq("party_id", id).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as never[] }),
    can(session, "omni.read")
      ? supabase.schema("omni").from("conversations").select("id, mode, status, last_message_at, channel_accounts:channel_account_id(channel)").eq("party_id", id).order("last_message_at", { ascending: false })
      : Promise.resolve({ data: [] as never[] }),
    supabase.schema("sales").rpc("store_credit_balance", { p_party: id }),
  ]);

  const list = orders.data ?? [];
  const ltv = list.reduce((a, o) => a + Number(o.total), 0);
  const ticket = list.length ? ltv / list.length : 0;
  const pays = list.flatMap((o) => o.payments ?? []);
  const favMethod = Object.entries(pays.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.method]: (acc[x.method] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0]?.[0];
  const avgInst = pays.filter((x) => x.method === "CREDIT").reduce((a, x, _, arr) => a + x.installments / arr.length, 0);
  const since = daysSince(p.last_purchase_at);

  return (
    <>
      <PageHeader title={p.display_name} description={[p.profession, p.city, p.instagram_handle && `@${p.instagram_handle}`].filter(Boolean).join(" · ") || "Cliente"}
        actions={<div className="flex gap-1.5"><Badge tone="brand">{p.lifecycle_stage}</Badge><Badge>{p.tier}</Badge><Badge tone="info">score {p.lead_score}</Badge></div>} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="LTV (total comprado)" value={formatBRL(ltv)} hint={`${list.length} compras`} />
        <Stat label="Ticket médio" value={formatBRL(ticket)} />
        <Stat label="Dias desde a última compra" value={since ?? "—"} tone={since !== null && since > 60 ? "warning" : undefined} />
        <Stat label="Vale-troca disponível" value={formatBRL(Number(credit.data ?? 0))} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Perfil financeiro e preferências">
          <ul className="space-y-1.5 text-sm">
            <li className="flex justify-between"><span className="text-muted">Pagamento preferido</span><span>{favMethod ?? "—"}</span></li>
            <li className="flex justify-between"><span className="text-muted">Parcelamento médio</span><span>{avgInst ? `${avgInst.toFixed(1)}x` : "—"}</span></li>
            <li className="flex justify-between"><span className="text-muted">Tamanhos</span><span>{Object.entries(p.sizes as Record<string, string>).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</span></li>
            <li className="flex justify-between"><span className="text-muted">Sócia JOY</span><span>{p.joy_member_status === "UNKNOWN" ? "não informado" : p.joy_member_status}</span></li>
            <li className="flex justify-between"><span className="text-muted">Origem</span><span>{p.source ?? "—"}</span></li>
          </ul>
        </Card>
        <Card title="Contatos">
          <ul className="space-y-1 text-sm">{(contacts.data ?? []).map((c) => (
            <li key={c.type + c.value_display} className="flex justify-between"><span className="text-muted">{c.type}</span><span>{c.value_display}</span></li>
          ))}</ul>
          <h3 className="mt-4 mb-1 text-xs font-semibold text-muted">Consentimentos (LGPD)</h3>
          {(consents.data ?? []).length === 0 ? <p className="text-sm text-muted">Nenhum registrado.</p> : (
            <ul className="space-y-1 text-sm">{(consents.data ?? []).map((c) => (
              <li key={c.purpose} className="flex justify-between"><span>{CONSENT_LABEL[c.purpose ?? ""] ?? c.purpose}</span><Badge tone={c.granted ? "success" : "danger"}>{c.granted ? "sim" : "revogado"}</Badge></li>
            ))}</ul>
          )}
        </Card>
        <Card title="Conversas">
          {(convs.data ?? []).length === 0 ? <p className="text-sm text-muted">Nenhuma conversa.</p> : (
            <ul className="space-y-1 text-sm">{(convs.data ?? []).map((c) => (
              <li key={c.id}><Link href={`/atendimento?c=${c.id}`} className="flex justify-between text-brand"><span>{c.channel_accounts?.channel}</span><span className="text-muted">{c.mode}</span></Link></li>
            ))}</ul>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Compras">
          {list.length === 0 ? <Empty title="Nenhuma compra" /> : (
            <ul className="divide-y divide-border text-sm">{list.map((o) => (
              <li key={o.id} className="flex justify-between py-1.5"><span>{o.number} · {o.channel}</span><span>{formatBRL(o.total)}</span></li>
            ))}</ul>
          )}
        </Card>
        <Card title="Linha do tempo">
          {(timeline.data ?? []).length === 0 ? <Empty title="Sem eventos" /> : (
            <ol className="space-y-2 text-sm">{(timeline.data ?? []).map((e) => (
              <li key={e.id}><span className="text-xs text-muted">{new Date(e.occurred_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} · {e.kind}</span><br />{e.summary}</li>
            ))}</ol>
          )}
        </Card>
      </div>
    </>
  );
}
