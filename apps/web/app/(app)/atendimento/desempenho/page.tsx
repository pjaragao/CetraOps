import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { periodBounds, str, type SP } from "@/lib/context";
import { Card, Empty, PageHeader, Stat, Table } from "@/components/ui";
import { OUTCOME_LABEL } from "../conversation-pane";

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
  const [{ data, error }, { data: outcomes }, { data: csatData }, { data: topics }, { data: members }, { data: npsData }] = await Promise.all([
    supabase.schema("omni").rpc("performance", { p_from: b.fromTs, p_to: b.toTs }),
    supabase.schema("omni").rpc("outcomes", { p_from: b.fromTs, p_to: b.toTs }),
    supabase.schema("omni").rpc("csat_summary", { p_from: b.fromTs, p_to: b.toTs }),
    supabase.schema("omni").rpc("topics_report", { p_from: b.fromTs, p_to: b.toTs }),
    supabase.schema("core").from("members").select("id, display_name"),
    supabase.schema("omni").rpc("nps_summary", { p_from: b.fromTs, p_to: b.toTs }),
  ]);
  const nps = npsData as unknown as { asked: number; answered: number; promoters: number; passives: number; detractors: number; nps: number | null } | null;
  const csat = csatData as unknown as { asked: number; answered: number; avg: number | null; low: number; by_member: { member_id: string; n: number; avg: number }[] } | null;
  const memberName = new Map((members ?? []).map((m) => [m.id, m.display_name]));
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
            <Card title="Satisfação (nota de 1 a 5)">
              {!csat || csat.asked === 0 ? <p className="text-sm text-muted">Nenhuma pesquisa no período. Ligue em Atendimento › Distribuição e satisfação.</p> : (
                <div className="space-y-2 text-sm">
                  <p><span className="text-2xl font-semibold tabular-nums">{csat.avg ?? "—"}</span> <span className="text-muted">média · {csat.answered} de {csat.asked} responderam ({pct(csat.answered, csat.asked)}) · {csat.low} nota(s) até 3</span></p>
                  {csat.by_member.length > 0 && <ul className="text-xs text-muted">{csat.by_member.map((m) => <li key={m.member_id}>{memberName.get(m.member_id) ?? "—"}: {m.avg} ({m.n})</li>)}</ul>}
                </div>
              )}
            </Card>
            <Card title="NPS">
              {!nps || nps.asked === 0 ? <p className="text-sm text-muted">Nenhuma pergunta no período. Ligue em Atendimento › Distribuição e satisfação.</p> : (
                <p className="text-sm"><span className="text-2xl font-semibold tabular-nums">{nps.nps ?? "—"}</span> <span className="text-muted">{nps.answered} de {nps.asked} responderam · {nps.promoters} promotoras · {nps.passives} neutras · {nps.detractors} detratoras</span></p>
              )}
            </Card>
            <Card title="O que as clientes mais perguntam">
              {(topics ?? []).length === 0 ? <p className="text-sm text-muted">Os temas aparecem quando a IA resume as conversas encerradas.</p> : (
                <ul className="flex flex-wrap gap-1.5 text-xs">{(topics ?? []).map((t) => (
                  <li key={t.topic} className={`rounded-full border px-2 py-0.5 ${t.negative > 0 ? "border-danger/40" : "border-border"}`}>{t.topic} <b className="tabular-nums">{t.conversations}</b>{t.negative > 0 && <span className="text-danger"> · {t.negative} insatisfeita(s)</span>}</li>
                ))}</ul>
              )}
            </Card>
          </div>

          <Card className="mb-4" title="Como as conversas terminaram">
            {(outcomes ?? []).length === 0 ? <p className="text-sm text-muted">Nenhuma conversa encerrada no período.</p> : (() => {
              const total = (outcomes ?? []).reduce((a, o) => a + o.conversations, 0);
              const byOutcome = new Map<string, { human: number; auto: number }>();
              for (const o of outcomes ?? []) {
                const v = byOutcome.get(o.outcome) ?? { human: 0, auto: 0 };
                if (o.source === "AUTO") v.auto += o.conversations; else v.human += o.conversations;
                byOutcome.set(o.outcome, v);
              }
              return (
                <Table head={["Desfecho", "Conversas", "%", "Encerradas sozinhas (7 dias paradas)"]}>
                  {[...byOutcome.entries()].sort((a, b) => b[1].human + b[1].auto - a[1].human - a[1].auto).map(([k, v]) => (
                    <tr key={k}><td className="px-3 py-2">{OUTCOME_LABEL[k] ?? "Sem desfecho"}</td><td className="px-3 py-2 tabular-nums">{v.human + v.auto}</td>
                      <td className="px-3 py-2 tabular-nums">{pct(v.human + v.auto, total)}</td><td className="px-3 py-2 tabular-nums text-muted">{v.auto || "—"}</td></tr>
                  ))}
                </Table>
              );
            })()}
          </Card>

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
