import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { deleteAutomationAction, saveAutomationAction, testAutomationAction, toggleAutomationAction } from "./actions";

export const metadata = { title: "Automações" };

const TRIGGERS: Record<string, { label: string; help: string; actions: string[]; channel?: "WHATSAPP" | "INSTAGRAM" }> = {
  KEYWORD: { label: "Palavra na mensagem", help: "Quando a cliente escreve uma destas palavras (sem diferença de acento ou maiúscula).", actions: ["SEND_TEXT", "ADD_TAG", "CREATE_TASK", "HANDOFF"] },
  CTWA_REFERRAL: { label: "Chegou por anúncio no WhatsApp", help: "Na primeira mensagem de quem clicou no anúncio que abre o WhatsApp.", actions: ["SEND_TEXT", "ADD_TAG", "CREATE_TASK", "HANDOFF"], channel: "WHATSAPP" },
  STORY_MENTION: { label: "Menção em story", help: "Quando alguém marca a marca no story do Instagram.", actions: ["SEND_TEXT", "ADD_TAG", "CREATE_TASK", "HANDOFF"], channel: "INSTAGRAM" },
  COMMENT_KEYWORD: { label: "Comentário no Instagram", help: "Comentário com uma destas palavras (vazio = qualquer comentário): responde em privado, uma vez por comentário e em até 7 dias.", actions: ["PRIVATE_REPLY", "ADD_TAG", "CREATE_TASK"], channel: "INSTAGRAM" },
  BIRTHDAY: { label: "Aniversário (todo dia de manhã)", help: "Cria uma tarefa para a equipe no dia (ou alguns dias antes). Não manda mensagem sozinha.", actions: ["CREATE_TASK", "ADD_TAG"] },
  INACTIVITY: { label: "Cliente parada (todo dia de manhã)", help: "Cria tarefa para reativar quem não compra há N dias (faixa de N a N+30 dias). Não manda mensagem sozinha.", actions: ["CREATE_TASK", "ADD_TAG"] },
};
const ACTION: Record<string, string> = { SEND_TEXT: "Responder com um texto", PRIVATE_REPLY: "Responder em privado ao comentário", ADD_TAG: "Colocar etiqueta", CREATE_TASK: "Criar tarefa para a equipe", HANDOFF: "Chamar uma pessoa" };
const RUN: Record<string, { label: string; tone: "success" | "warning" | "danger" }> = { DONE: { label: "feita", tone: "success" }, SKIPPED: { label: "pulada", tone: "warning" }, FAILED: { label: "falhou", tone: "danger" } };
const REASON: Record<string, string> = { COOLDOWN: "intervalo mínimo entre execuções", ALREADY_REPLIED: "outra automação já respondeu", WINDOW_CLOSED: "janela de resposta fechada", COMMENT_TOO_OLD: "comentário com mais de 7 dias", NOT_A_COMMENT: "não é comentário", ALREADY_WITH_PEOPLE: "já estava com uma pessoa" };

interface Action { type: string; text?: string; tag?: string; title?: string; suggested_message?: string; due_in_hours?: number }
const ago = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function summary(a: { trigger: string; conditions: unknown; actions: unknown; cooldown_days: number }): string {
  const c = (a.conditions ?? {}) as { keywords?: string[]; days_before?: number; days?: number };
  const when = a.trigger === "KEYWORD" || a.trigger === "COMMENT_KEYWORD" ? (c.keywords?.length ? `“${c.keywords.join(", ")}”` : "qualquer comentário") : a.trigger === "BIRTHDAY" ? (c.days_before ? `${c.days_before} dia(s) antes` : "no dia") : a.trigger === "INACTIVITY" ? `${c.days} dias sem comprar` : "";
  return `${TRIGGERS[a.trigger].label}${when ? ` · ${when}` : ""} → ${((a.actions ?? []) as Action[]).map((x) => ACTION[x.type]).join(", ")}`;
}

export default async function AutomacoesPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("omni.read");
  const sp = await searchParams;
  const canWrite = can(session, "omni.write");
  const supabase = await createClient();
  const [{ data: rules }, { data: runs }, { data: accounts }] = await Promise.all([
    supabase.schema("omni").from("automations").select("id, name, trigger, channel_account_id, conditions, actions, cooldown_days, active, last_run_at").order("created_at"),
    supabase.schema("omni").from("automation_runs").select("id, automation_id, party_id, status, reason, detail, created_at").order("created_at", { ascending: false }).limit(25),
    supabase.schema("omni").from("channel_accounts").select("id, channel, display_name").order("display_name"),
  ]);
  const editing = (rules ?? []).find((r) => r.id === str(sp.editar));
  const trigger = editing?.trigger ?? (TRIGGERS[str(sp.novo) ?? ""] ? str(sp.novo)! : undefined);
  const def = trigger ? TRIGGERS[trigger] : undefined;
  const ruleName = new Map((rules ?? []).map((r) => [r.id, r.name]));
  const partyIds = [...new Set((runs ?? []).map((r) => r.party_id).filter(Boolean))] as string[];
  const { data: parties } = partyIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : { data: [] as { id: string; display_name: string }[] };
  const who = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const ec = (editing?.conditions ?? {}) as { keywords?: string[]; days_before?: number; days?: number };
  const eActions = ((editing?.actions ?? []) as unknown as Action[]);
  const channelOptions = (accounts ?? []).filter((a) => !def?.channel || a.channel === def.channel);

  return (
    <>
      <PageHeader title="Automações" description="Regras do tipo “quando acontecer isto, faça aquilo”. Nascem desligadas. Uma automação que responde impede a IA de responder à mesma mensagem." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      {(rules ?? []).length === 0 ? <Empty title="Nenhuma automação ainda">Escolha um tipo abaixo para criar a primeira.</Empty> : (
        <Table head={["Automação", "Quando → o que faz", "Situação", "Última vez", ""]}>
          {(rules ?? []).map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 font-medium">{r.name}</td>
              <td className="px-3 py-2 text-xs">{summary(r)}<span className="block text-[11px] text-muted">Intervalo por pessoa: {r.cooldown_days === 0 ? "sem intervalo" : `${r.cooldown_days} dia(s)`}</span></td>
              <td className="px-3 py-2"><Badge tone={r.active ? "success" : "neutral"}>{r.active ? "ligada" : "desligada"}</Badge></td>
              <td className="px-3 py-2 text-xs">{r.last_run_at ? ago(r.last_run_at) : "—"}</td>
              <td className="px-3 py-2">
                {canWrite && (
                  <div className="flex flex-wrap items-center gap-1">
                    <form action={toggleAutomationAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="active" value={r.active ? "0" : "1"} /><Button variant="secondary" className="px-2 py-1 text-xs">{r.active ? "Desligar" : "Ligar"}</Button></form>
                    <Link className="rounded-lg px-2 py-1 text-xs hover:bg-surface-2" href={`/atendimento/automacoes?editar=${r.id}`}>Editar</Link>
                    <form action={deleteAutomationAction}><input type="hidden" name="id" value={r.id} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Excluir</Button></form>
                    {(r.trigger === "KEYWORD" || r.trigger === "COMMENT_KEYWORD") && (
                      <form action={testAutomationAction} className="flex items-center gap-1"><input type="hidden" name="id" value={r.id} /><input name="text" required placeholder="Testar uma frase" className={`${inputClass} w-44 py-1 text-xs`} aria-label="Frase de teste" /><Button variant="ghost" className="px-2 py-1 text-xs">Testar</Button></form>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      {canWrite && (
        <Card className="mt-4" title={editing ? `Editar: ${editing.name}` : def ? `Nova automação: ${def.label}` : "Nova automação"}>
          {!def ? (
            <div className="grid grid-cards gap-2">
              {Object.entries(TRIGGERS).map(([k, t]) => (
                <Link key={k} href={`/atendimento/automacoes?novo=${k}`} className="rounded-xl border border-border p-3 text-sm hover:bg-surface-2"><span className="font-medium">{t.label}</span><span className="mt-1 block text-xs text-muted">{t.help}</span></Link>
              ))}
            </div>
          ) : (
            <form key={editing?.id ?? trigger} action={saveAutomationAction} className="space-y-4">
              {editing && <input type="hidden" name="id" value={editing.id} />}<input type="hidden" name="trigger" value={trigger} />
              <p className="text-xs text-muted">{def.help}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Nome"><input name="name" required minLength={3} maxLength={120} defaultValue={editing?.name} className={inputClass} placeholder="Horário e endereço" /></Field>
                {def.actions.length > 0 && trigger !== "BIRTHDAY" && trigger !== "INACTIVITY" && (
                  <Field label="Canal (opcional)" hint="Vazio = qualquer canal"><select name="channel_account_id" defaultValue={editing?.channel_account_id ?? ""} className={inputClass}><option value="">Todos</option>{channelOptions.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}</select></Field>
                )}
                <Field label="Intervalo por pessoa (dias)" hint="Não repete para a mesma pessoa antes disso"><input name="cooldown_days" type="number" min={0} max={365} defaultValue={editing?.cooldown_days ?? ""} className={inputClass} placeholder="padrão" /></Field>
              </div>
              {(trigger === "KEYWORD" || trigger === "COMMENT_KEYWORD") && <Field label="Palavras-chave" hint="Separadas por vírgula. Ex.: horário, endereço, onde fica"><input name="keywords" defaultValue={(ec.keywords ?? []).join(", ")} className={inputClass} /></Field>}
              {trigger === "BIRTHDAY" && <Field label="Avisar quantos dias antes" hint="0 = no dia"><input name="days_before" type="number" min={0} max={30} defaultValue={ec.days_before ?? 0} className={`${inputClass} max-w-[8rem]`} /></Field>}
              {trigger === "INACTIVITY" && <Field label="Sem comprar há (dias)"><input name="days" type="number" min={15} max={720} defaultValue={ec.days ?? 60} className={`${inputClass} max-w-[8rem]`} /></Field>}
              <fieldset className="space-y-3"><legend className="mb-1 text-xs font-medium text-muted">O que fazer (até 3 ações) · use {"{nome}"} para o primeiro nome</legend>
                {[0, 1, 2].map((i) => {
                  const a = eActions[i];
                  return (
                    <div key={i} className="grid gap-2 sm:grid-cols-[14rem_1fr_1fr_6rem]">
                      <select name={`a${i}_type`} defaultValue={a?.type ?? ""} className={inputClass} aria-label={`Ação ${i + 1}`}><option value="">— sem ação —</option>{def.actions.map((t) => <option key={t} value={t}>{ACTION[t]}</option>)}</select>
                      <input name={`a${i}_text`} defaultValue={a?.text ?? a?.tag ?? a?.title ?? ""} className={inputClass} placeholder="Texto da resposta · etiqueta · título da tarefa" aria-label={`Texto da ação ${i + 1}`} />
                      <input name={`a${i}_extra`} defaultValue={a?.suggested_message ?? ""} className={inputClass} placeholder="Tarefa: mensagem pronta (opcional)" aria-label={`Mensagem pronta da ação ${i + 1}`} />
                      <input name={`a${i}_hours`} type="number" min={0} max={720} defaultValue={a?.due_in_hours ?? ""} className={inputClass} placeholder="Prazo (h)" aria-label={`Prazo da ação ${i + 1}`} />
                    </div>
                  );
                })}
              </fieldset>
              <div className="flex items-center gap-3"><Button>{editing ? "Salvar" : "Criar automação"}</Button><Link href="/atendimento/automacoes" className="text-xs text-brand">Cancelar</Link></div>
            </form>
          )}
        </Card>
      )}

      <h2 className="mb-2 mt-8 text-sm font-semibold">Últimas execuções</h2>
      {(runs ?? []).length === 0 ? <Empty title="Nada executado ainda" /> : (
        <Table head={["Quando", "Automação", "Pessoa", "Resultado", "Detalhe"]}>
          {(runs ?? []).map((r) => {
            const st = RUN[r.status];
            const acts = ((r.detail as { actions?: { type: string; skipped?: string }[] } | null)?.actions ?? []).map((x) => `${ACTION[x.type] ?? x.type}${x.skipped ? ` (${REASON[x.skipped] ?? x.skipped})` : ""}`).join(", ");
            return (
              <tr key={r.id}>
                <td className="px-3 py-2 text-xs">{ago(r.created_at)}</td>
                <td className="px-3 py-2 text-xs">{ruleName.get(r.automation_id)}</td>
                <td className="px-3 py-2 text-xs">{r.party_id ? who.get(r.party_id) : "—"}</td>
                <td className="px-3 py-2"><Badge tone={st.tone}>{st.label}</Badge></td>
                <td className="px-3 py-2 text-xs text-muted">{r.reason ? REASON[r.reason] ?? r.reason : acts}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
