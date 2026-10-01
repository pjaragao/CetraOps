import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { saveNoticeAction } from "./actions";

export const metadata = { title: "Avisos automáticos" };

const EVENTS: Record<string, { label: string; when: string; vars: string; defaultText: string }> = {
  ORDER_PAID: { label: "Pagamento confirmado", when: "Pedido remoto (WhatsApp, Instagram, link) passa a pago. Venda no balcão não avisa.", vars: "{nome} {pedido}", defaultText: "Oi, {nome}! Recebemos o pagamento do pedido {pedido}. Avisamos por aqui assim que estiver pronto. 💛" },
  READY_FOR_PICKUP: { label: "Pronto para retirar", when: "Pedido muda para pronto para retirada.", vars: "{nome} {pedido}", defaultText: "Oi, {nome}! Seu pedido {pedido} está pronto para retirar na SIÉ, dentro da JOY." },
  SHIPPED: { label: "Pedido enviado", when: "Pedido muda para enviado (com o rastreio da entrega).", vars: "{nome} {pedido} {rastreio}", defaultText: "Oi, {nome}! Seu pedido {pedido} saiu para entrega. Rastreio: {rastreio}" },
  LOCKER_READY: { label: "Armário VIP pronto", when: "Peças colocadas no Armário VIP para a cliente.", vars: "{nome} {codigo} {prazo}", defaultText: "Oi, {nome}! Suas peças estão separadas no Armário VIP {codigo} até {prazo}. É só pedir a chave na loja. ✨" },
  RESERVATION_EXPIRING: { label: "Reserva vencendo", when: "Reserva ativa vence nas próximas 6 horas.", vars: "{nome} {prazo}", defaultText: "Oi, {nome}! A peça que separamos para você fica reservada até {prazo}. Quer que a gente segure mais um pouco?" },
  PAYMENT_LINK_REMINDER: { label: "Lembrete do link de pagamento", when: "Link enviado há 2 horas e ainda não pago (uma vez).", vars: "{nome} {pedido} {link}", defaultText: "Oi, {nome}! Passando para lembrar do link do pedido {pedido}: {link} . Se preferir, dá para pagar na loja também." },
  STORE_CREDIT_ISSUED: { label: "Vale-troca gerado", when: "Vale-troca de devolução, cortesia ou comissão de afiliada.", vars: "{nome} {valor}", defaultText: "Oi, {nome}! Geramos um vale-troca de {valor} para você usar na SIÉ. Ele já está no seu cadastro." },
  BACK_IN_STOCK: { label: "Chegou o tamanho (avise-me)", when: "O tamanho que a cliente pediu entrou no estoque (a peça fica separada 24 h para ela).", vars: "{nome} {codigo} = produto, {prazo} = reserva", defaultText: "Oi, {nome}! Chegou {codigo} no tamanho que você pediu. {prazo} 💛" },
  NPS_ASK: { label: "Pergunta de NPS (0 a 10)", when: "Alguns dias depois da compra (padrão 10), uma vez a cada 90 dias por pessoa. Ligue e escolha os dias em Distribuição e satisfação.", vars: "{nome} {pedido}", defaultText: "Oi, {nome}! De 0 a 10, quanto você indicaria a SIÉ para uma amiga? Responda só com o número. Sua resposta ajuda muito a gente. 💛" },
  EVENT_REMINDER: { label: "Lembrete de evento", when: "Convidada confirmada, evento em cerca de 24 horas.", vars: "{nome} {evento} {prazo}", defaultText: "Oi, {nome}! Lembrando do {evento} amanhã, {prazo}. Te esperamos! ✨" },
};
const STATUS: Record<string, { label: string; tone: "success" | "info" | "warning" | "neutral" }> = {
  SENT_TEXT: { label: "texto (janela aberta)", tone: "success" }, SENT_TEMPLATE: { label: "template", tone: "info" }, TASK: { label: "virou tarefa", tone: "warning" }, SKIPPED: { label: "não enviado", tone: "neutral" },
};
const REASON: Record<string, string> = { NO_WHATSAPP: "sem WhatsApp no cadastro", WINDOW_CLOSED_NO_TEMPLATE: "janela fechada e sem template", NO_CONVERSATION: "número de outra pessoa", ANONYMIZED: "cadastro anonimizado" };
const VAR_OPTIONS = "FIRST_NAME, ORDER_NUMBER, DEADLINE, LOCKER_CODE, TRACKING, LINK_URL, EVENT_NAME, AMOUNT";

export default async function AvisosPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("omni.read");
  const sp = await searchParams;
  const canWrite = can(session, "omni.write");
  const supabase = await createClient();
  const [{ data: rules }, { data: log }, { data: accounts }, { data: templates }] = await Promise.all([
    supabase.schema("omni").from("notice_rules").select("event, active, channel_account_id, free_text, template_id, template_vars, task_fallback"),
    supabase.schema("omni").from("notices_log").select("id, event, party_id, status, reason, created_at").order("created_at", { ascending: false }).limit(30),
    supabase.schema("omni").from("channel_accounts").select("id, display_name").eq("channel", "WHATSAPP").order("display_name"),
    supabase.schema("omni").from("templates").select("id, name, status, channel_account_id").eq("category", "UTILITY").order("name"),
  ]);
  const byEvent = new Map((rules ?? []).map((r) => [r.event, r]));
  const editing = str(sp.editar);
  const def = editing ? EVENTS[editing] : undefined;
  const rule = editing ? byEvent.get(editing) : undefined;
  const partyIds = [...new Set((log ?? []).map((l) => l.party_id))];
  const { data: parties } = partyIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : { data: [] as { id: string; display_name: string }[] };
  const who = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  return (
    <>
      <PageHeader title="Avisos automáticos" description="Mensagens transacionais que saem sozinhas, uma por fato: com a janela de 24 h aberta vai o texto; fechada, o template de UTILIDADE escolhido; sem template, vira tarefa para a equipe avisar. Nascem desligados." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <Table head={["Aviso", "Quando sai", "Fora da janela", "Situação", ""]}>
        {Object.entries(EVENTS).map(([k, e]) => {
          const r = byEvent.get(k);
          const tpl = r?.template_id ? (templates ?? []).find((t) => t.id === r.template_id) : undefined;
          return (
            <tr key={k}>
              <td className="px-3 py-2 font-medium">{e.label}</td>
              <td className="px-3 py-2 text-xs text-muted">{e.when}</td>
              <td className="px-3 py-2 text-xs">{tpl ? <span className="font-mono">{tpl.name}{tpl.status !== "APPROVED" && <span className="ml-1 text-warning">(não aprovado)</span>}</span> : r?.task_fallback === false ? "não avisa" : "vira tarefa"}</td>
              <td className="px-3 py-2"><Badge tone={r?.active ? "success" : "neutral"}>{r?.active ? "ligado" : "desligado"}</Badge></td>
              <td className="px-3 py-2">{canWrite && <Link className="rounded-lg px-2 py-1 text-xs hover:bg-surface-2" href={`/atendimento/avisos?editar=${k}`}>Configurar</Link>}</td>
            </tr>
          );
        })}
      </Table>

      {canWrite && def && (
        <Card className="mt-4" title={`Configurar: ${def.label}`}>
          <form key={editing} action={saveNoticeAction} className="space-y-3">
            <input type="hidden" name="event" value={editing} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={rule?.active ?? false} /> Ligado</label>
            <Field label="Texto (janela aberta)" hint={`Use ${def.vars}. Sem oferta ou promoção: é aviso, não marketing.`}>
              <textarea name="free_text" rows={3} maxLength={600} defaultValue={rule?.free_text ?? def.defaultText} className={inputClass} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Número"><select name="channel_account_id" defaultValue={rule?.channel_account_id ?? ""} className={inputClass}><option value="">Primeiro número ativo</option>{(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></Field>
              <Field label="Template de utilidade (janela fechada)"><select name="template_id" defaultValue={rule?.template_id ?? ""} className={inputClass}><option value="">Nenhum</option>{(templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}{t.status !== "APPROVED" ? " (não aprovado)" : ""}</option>)}</select></Field>
              <Field label="Variáveis do template, em ordem" hint={VAR_OPTIONS}><input name="template_vars" defaultValue={((rule?.template_vars ?? []) as string[]).join(", ")} className={`${inputClass} font-mono text-xs`} placeholder="FIRST_NAME, ORDER_NUMBER" /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="task_fallback" defaultChecked={rule?.task_fallback ?? true} /> Sem como enviar (janela fechada sem template, sem WhatsApp): criar tarefa para a equipe</label>
            <div className="flex items-center gap-3"><Button>Salvar aviso</Button><Link href="/atendimento/avisos" className="text-xs text-brand">Cancelar</Link></div>
          </form>
        </Card>
      )}

      <h2 className="mb-2 mt-8 text-sm font-semibold">Últimos avisos</h2>
      {(log ?? []).length === 0 ? <Empty title="Nenhum aviso ainda" /> : (
        <Table head={["Quando", "Aviso", "Cliente", "Como saiu"]}>
          {(log ?? []).map((l) => (
            <tr key={l.id}>
              <td className="px-3 py-2 text-xs">{when(l.created_at)}</td>
              <td className="px-3 py-2 text-xs">{EVENTS[l.event]?.label ?? l.event}</td>
              <td className="px-3 py-2 text-xs"><Link className="text-brand" href={`/clientes/${l.party_id}`}>{who.get(l.party_id) ?? "—"}</Link></td>
              <td className="px-3 py-2"><Badge tone={STATUS[l.status]?.tone}>{STATUS[l.status]?.label ?? l.status}</Badge>{l.reason && <span className="ml-1 text-xs text-muted">{REASON[l.reason] ?? l.reason}</span>}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
