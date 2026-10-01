import Link from "next/link";
import { formatBRL, templateExamples, templateParts, type TemplateComponent } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { isoFromNow, str, type SP } from "@/lib/context";
import { Badge, cn, Empty, LinkButton, PageHeader } from "@/components/ui";
import { ConversationPane } from "./conversation-pane";
import { RealtimeRefresh } from "./realtime-refresh";

export const metadata = { title: "Atendimento" };

const FILTERS = [
  { key: "todas", label: "Todas" },
  { key: "minhas", label: "Minhas" },
  { key: "sem-dono", label: "Não atribuídas" },
  { key: "aguardando", label: "Aguardando humano" },
  { key: "ia", label: "IA atendendo" },
  { key: "janela", label: "Janela expirando" },
];

const MODE_LABEL: Record<string, { label: string; tone: "brand" | "info" | "warning" | "success" }> = {
  AI_AUTOPILOT: { label: "IA Piloto", tone: "info" },
  AI_COPILOT: { label: "IA Copiloto", tone: "brand" },
  HUMAN: { label: "Humano", tone: "success" },
  WAITING_HUMAN: { label: "Aguardando", tone: "warning" },
};

export default async function AtendimentoPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = await requirePerm("omni.read");
  const supabase = await createClient();
  const filtro = str(sp.filtro) ?? "todas";
  const selected = str(sp.c);

  let q = supabase.schema("omni").from("conversations")
    .select("id, party_id, mode, status, unread_count, last_message_at, service_window_expires_at, assignee_member_id, channel_accounts:channel_account_id(channel, display_name)")
    .neq("status", "CLOSED").order("last_message_at", { ascending: false, nullsFirst: false }).limit(100);
  if (filtro === "minhas") q = q.eq("assignee_member_id", session.memberId);
  if (filtro === "sem-dono") q = q.is("assignee_member_id", null);
  if (filtro === "aguardando") q = q.eq("mode", "WAITING_HUMAN");
  if (filtro === "ia") q = q.in("mode", ["AI_AUTOPILOT", "AI_COPILOT"]);
  if (filtro === "janela") q = q.lte("service_window_expires_at", isoFromNow(2)).gte("service_window_expires_at", isoFromNow(0));
  const { data: convs } = await q;
  // PostgREST não faz embed entre schemas: busca os nomes das clientes à parte
  const partyIds = [...new Set((convs ?? []).map((c) => c.party_id))];
  const { data: partyRows } = partyIds.length
    ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds)
    : { data: [] as { id: string; display_name: string }[] };
  const partyName = new Map((partyRows ?? []).map((p) => [p.id, p.display_name]));

  let detail = null;
  if (selected) {
    const [{ data: conv }, { data: messages }, { data: drafts }, { data: notes }, { data: members }] = await Promise.all([
      supabase.schema("omni").from("conversations")
        .select("id, mode, last_inbound_at, ai_paused_until, ai_instruction, assignee_member_id, party_id, channel_account_id, channel_accounts:channel_account_id(channel, display_name)")
        .eq("id", selected).maybeSingle(),
      supabase.schema("omni").from("messages").select("id, direction, author_type, body, transcript, type, status, created_at")
        .eq("conversation_id", selected).order("created_at").order("seq").limit(300),
      supabase.schema("omni").from("message_drafts").select("id, variants, intent, confidence, needs_human, flags")
        .eq("conversation_id", selected).eq("status", "PENDING").order("created_at", { ascending: false }).limit(1),
      supabase.schema("omni").from("internal_notes").select("id, member_id, body, mentions, created_at").eq("conversation_id", selected).order("created_at").limit(100),
      supabase.schema("core").from("members").select("id, display_name").eq("status", "ACTIVE").order("display_name"),
    ]);
    if (conv) {
      const { data: party } = await supabase.schema("crm").from("parties")
        .select("id, display_name, lifecycle_stage, tier, sizes, lead_score, city, last_purchase_at").eq("id", conv.party_id).maybeSingle();
      const { data: orders } = await supabase.schema("sales").from("orders").select("number, total, created_at")
        .eq("party_id", conv.party_id).order("created_at", { ascending: false }).limit(5);
      const ltv = (orders ?? []).reduce((a, o) => a + Number(o.total), 0);
      const isWhatsApp = conv.channel_accounts?.channel === "WHATSAPP";
      const [{ data: tpls }, { data: replies }] = await Promise.all([
        isWhatsApp
          ? supabase.schema("omni").from("templates").select("id, name, category, components").eq("channel_account_id", conv.channel_account_id).eq("status", "APPROVED").order("name")
          : Promise.resolve({ data: [] as { id: string; name: string; category: string; components: unknown }[] }),
        supabase.schema("omni").from("quick_replies").select("id, shortcut, body").order("shortcut"),
      ]);
      const templates = (tpls ?? []).map((t) => ({ id: t.id, name: t.name, category: t.category, body: templateParts(t.components as TemplateComponent[]).body, examples: templateExamples(t.components as TemplateComponent[]) }));
      const { data: suggested } = await supabase.schema("omni").rpc("suggest_outcome", { p_conversation: conv.id });
      detail = { suggested: (suggested as string | null) ?? null, conv: { ...conv, parties: party }, messages: messages ?? [], notes: notes ?? [], members: members ?? [], draft: drafts?.[0] ?? null, orders: orders ?? [], ltv, templates, quickReplies: replies ?? [] };
    }
  }

  return (
    <>
      <PageHeader title="Atendimento" description="WhatsApp, Instagram e Telegram numa caixa só. Troque entre IA e humano a qualquer momento."
        actions={<LinkButton href="/atendimento/templates">Templates e respostas rápidas</LinkButton>} />
      <RealtimeRefresh conversationId={selected} />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Link key={f.key} href={`/atendimento?filtro=${f.key}${selected ? `&c=${selected}` : ""}`}
            className={cn("rounded-full border px-3 py-1 text-sm", filtro === f.key ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2")}>
            {f.label}
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <ul className={cn("max-h-[75dvh] overflow-y-auto rounded-xl border border-border bg-surface", selected && "hidden lg:block")}>
          {(convs ?? []).length === 0 && <li className="p-6 text-center text-sm text-muted">Nenhuma conversa neste filtro.</li>}
          {(convs ?? []).map((c) => {
            const m = MODE_LABEL[c.mode];
            return (
              <li key={c.id}>
                <Link href={`/atendimento?filtro=${filtro}&c=${c.id}`}
                  className={cn("flex flex-col gap-1 border-b border-border px-3 py-2.5 hover:bg-surface-2", selected === c.id && "bg-surface-2")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{partyName.get(c.party_id) ?? "Cliente"}</span>
                    {c.unread_count > 0 && <span className="rounded-full bg-brand px-1.5 text-xs text-brand-contrast">{c.unread_count}</span>}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <span>{c.channel_accounts?.channel}</span>
                    <Badge tone={m.tone}>{m.label}</Badge>
                    {c.last_message_at && <span className="ml-auto">{new Date(c.last_message_at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}</span>}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>

        {detail ? (
          <div className="grid gap-4 xl:grid-cols-[1fr_280px]">
            <ConversationPane
              key={detail.conv.id}
              conversationId={detail.conv.id}
              mode={detail.conv.mode}
              channel={detail.conv.channel_accounts?.channel ?? "WHATSAPP"}
              lastInboundAt={detail.conv.last_inbound_at}
              aiPausedUntil={detail.conv.ai_paused_until}
              aiInstruction={detail.conv.ai_instruction}
              assigneeId={detail.conv.assignee_member_id}
              meId={session.memberId}
              members={detail.members.map((m) => ({ id: m.id, name: m.display_name }))}
              notes={detail.notes}
              customerName={detail.conv.parties?.display_name ?? ""}
              templates={detail.templates}
              quickReplies={detail.quickReplies}
              messages={detail.messages}
              draft={detail.draft ? { id: detail.draft.id, variants: detail.draft.variants as { messages: string[] }[], confidence: detail.draft.confidence, intent: detail.draft.intent, needsHuman: detail.draft.needs_human } : null}
              backHref={`/atendimento?filtro=${filtro}`}
              suggestedOutcome={detail.suggested}
              initialText={str(sp.msg)}
            />
            <aside className="space-y-3 rounded-xl border border-border bg-surface p-4 text-sm">
              <div>
                <p className="text-xs text-muted">Cliente</p>
                <Link href={`/clientes/${detail.conv.parties?.id}`} className="font-medium text-brand">{detail.conv.parties?.display_name}</Link>
                <p className="text-xs text-muted">{detail.conv.parties?.city ?? "cidade não informada"}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge tone="brand">{detail.conv.parties?.lifecycle_stage}</Badge>
                <Badge>{detail.conv.parties?.tier}</Badge>
                <Badge tone="info">score {detail.conv.parties?.lead_score}</Badge>
              </div>
              <div>
                <p className="text-xs text-muted">Tamanhos</p>
                <p>{Object.entries((detail.conv.parties?.sizes ?? {}) as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join(" · ") || "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Compras (LTV {formatBRL(detail.ltv)})</p>
                {detail.orders.length === 0 ? <p className="text-muted">Nenhuma compra ainda</p> : (
                  <ul className="mt-1 space-y-1">{detail.orders.map((o) => (
                    <li key={o.number} className="flex justify-between"><span>{o.number}</span><span>{formatBRL(o.total)}</span></li>
                  ))}</ul>
                )}
              </div>
            </aside>
          </div>
        ) : (
          <div className="hidden lg:block"><Empty title="Selecione uma conversa">As mensagens chegam em tempo real.</Empty></div>
        )}
      </div>
    </>
  );
}
