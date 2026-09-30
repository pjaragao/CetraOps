import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { periodBounds, str, type SP } from "@/lib/context";
import { Card, Empty, PageHeader, Stat, Table } from "@/components/ui";

export const metadata = { title: "Desempenho do atendimento" };

interface Perf {
  conversations: { started: number; open: number; waiting_human: number; closed: number };
  response: { rounds: number; answered: number; median_s: number | null; p90_s: number | null; by_author: Record<string, { n: number; median_s: number }> };
  sla_breaches: number;
  volume: { ai_replies: number; human_replies: number; echo_replies: number; inbound: number; handoffs: number; resolved_without_people: number; cost_usd: number; runs: number };
  drafts: { total: number; sent: number; edited: number; discarded: number; pending: number; discard_reasons: { reason: string; n: number }[] };
  sales: { orders: number; revenue: number; ai_assisted_orders: number; ai_assisted_revenue: number };
  channels: { channel: string; conversations: number; inbound: number }[];
  hours: Record<string, number>;
  people: { member_id: string; name: string; replies: number }[];
}

const AUTHOR: Record<string, string> = { AI: "IA", HUMAN: "Equipe pelo sistema", ECHO_FROM_APP: "Equipe pelo celular" };
const CHANNEL: Record<string, string> = { WHATSAPP: "WhatsApp", INSTAGRAM: "Instagram", TELEGRAM: "Telegram", TIKTOK: "TikTok" };

function dur(s: number | null | undefined): string {
  if (s == null) return "—";
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h} h${m ? ` ${m} min` : ""}`;
}
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((100 * n) / d)}%` : "—");

export default async function DesempenhoPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("omni.read");
  const sp = await searchParams;
  const b = periodBounds(str(sp.periodo));
  const supabase = await createClient();
  const { data, error } = await supabase.schema("omni").rpc("performance", { p_from: b.fromTs, p_to: b.toTs });
  const d = data as unknown as Perf | null;
  if (error || !d) return <><PageHeader title="Desempenho" /><Empty title="Não foi possível calcular agora">{error?.message}</Empty></>;

  const replies = d.volume.ai_replies + d.volume.human_replies + d.volume.echo_replies;
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, n: d.hours[String(h)] ?? 0 }));
  const peak = Math.max(1, ...hours.map((x) => x.n));
  const drafted = d.drafts.sent + d.drafts.edited + d.drafts.discarded;

  return (
    <>
      <PageHeader title="Desempenho do atendimento" description={`${b.from.split("-").reverse().join("/")} a ${b.to.split("-").reverse().join("/")}. Muda com o período do topo da tela.`} />
      {d.conversations.started === 0 && d.volume.inbound === 0 ? <Empty title="Sem conversas neste período">Troque o período no topo para ver outro intervalo.</Empty> : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Conversas novas" value={d.conversations.started} hint={`${d.conversations.open} abertas agora · ${d.conversations.closed} encerradas`} />
            <Stat label="Tempo até a primeira resposta" value={dur(d.response.median_s)} hint={`Mediana · 9 em 10 em até ${dur(d.response.p90_s)}`} />
            <Stat label="Sem resposta" value={d.response.rounds - d.response.answered} hint={`de ${d.response.rounds} vezes que a cliente escreveu`} tone={d.response.rounds - d.response.answered > 0 ? "warning" : "success"} />
            <Stat label="SLA estourado" value={d.sla_breaches} hint={`${d.conversations.waiting_human} aguardando pessoa agora`} tone={d.sla_breaches > 0 ? "danger" : "success"} />
          </div>

          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Respostas da IA" value={pct(d.volume.ai_replies, replies)} hint={`${d.volume.ai_replies} de ${replies} mensagens enviadas`} />
            <Stat label="Resolvidas só pela IA" value={d.volume.resolved_without_people} hint="Encerradas sem ninguém da equipe" />
            <Stat label="Transferências automáticas" value={d.volume.handoffs} hint="IA, regras ou automações chamaram uma pessoa" />
            <Stat label="Custo da IA" value={`US$ ${d.volume.cost_usd.toFixed(2)}`} hint={d.conversations.started > 0 ? `US$ ${(d.volume.cost_usd / d.conversations.started).toFixed(3)} por conversa nova` : undefined} />
          </div>

          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Card title="Vendas saídas de conversa">
              <p className="text-2xl font-semibold tabular-nums">{formatBRL(d.sales.revenue)}</p>
              <p className="text-xs text-muted">{d.sales.orders} pedido(s) pagos · {d.sales.ai_assisted_orders} com ajuda da IA ({formatBRL(d.sales.ai_assisted_revenue)})</p>
            </Card>
            <Card title="Rascunhos da IA">
              {drafted === 0 ? <p className="text-sm text-muted">Nenhum rascunho decidido no período.</p> : (
                <div className="space-y-1 text-sm">
                  <p><span className="font-medium tabular-nums">{pct(d.drafts.sent, drafted)}</span> enviados como vieram · <span className="font-medium tabular-nums">{pct(d.drafts.edited, drafted)}</span> editados · <span className="font-medium tabular-nums">{pct(d.drafts.discarded, drafted)}</span> descartados</p>
                  {d.drafts.discard_reasons.length > 0 && <p className="text-xs text-muted">Motivos: {d.drafts.discard_reasons.map((r) => `${r.reason} (${r.n})`).join(" · ")}</p>}
                  <p className="text-xs text-muted">Para soltar o piloto automático: 70% ou mais enviados sem edição relevante.</p>
                </div>
              )}
            </Card>
          </div>

          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Card title="Quem respondeu primeiro">
              {Object.keys(d.response.by_author).length === 0 ? <p className="text-sm text-muted">—</p> : (
                <Table head={["Quem", "Respostas", "Mediana"]}>
                  {Object.entries(d.response.by_author).map(([k, v]) => <tr key={k}><td className="px-3 py-2">{AUTHOR[k] ?? k}</td><td className="px-3 py-2 tabular-nums">{v.n}</td><td className="px-3 py-2 tabular-nums">{dur(v.median_s)}</td></tr>)}
                </Table>
              )}
            </Card>
            <Card title="Por canal">
              {d.channels.length === 0 ? <p className="text-sm text-muted">—</p> : (
                <Table head={["Canal", "Conversas", "Mensagens da cliente"]}>
                  {d.channels.map((c) => <tr key={c.channel}><td className="px-3 py-2">{CHANNEL[c.channel] ?? c.channel}</td><td className="px-3 py-2 tabular-nums">{c.conversations}</td><td className="px-3 py-2 tabular-nums">{c.inbound}</td></tr>)}
                </Table>
              )}
            </Card>
          </div>

          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Card title="Horários em que a cliente escreve">
              <div className="flex h-28 items-end gap-0.5" role="img" aria-label="Mensagens da cliente por hora do dia">
                {hours.map((x) => <div key={x.h} title={`${x.h}h: ${x.n}`} className="flex-1 rounded-t bg-brand/60" style={{ height: `${Math.max(2, (100 * x.n) / peak)}%` }} />)}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-muted"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
            </Card>
            <Card title="Respostas por pessoa (pelo sistema)">
              {d.people.length === 0 ? <p className="text-sm text-muted">—</p> : (
                <Table head={["Pessoa", "Respostas"]}>{d.people.map((p) => <tr key={p.member_id}><td className="px-3 py-2">{p.name}</td><td className="px-3 py-2 tabular-nums">{p.replies}</td></tr>)}</Table>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
