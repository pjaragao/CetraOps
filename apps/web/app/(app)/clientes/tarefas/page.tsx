import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { addDaysIsoSP, isoFromNow, str, type SP } from "@/lib/context";
import { Badge, Button, Card, cn, Empty, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { createTaskAction, postponeTaskAction, setTaskStatusAction, updateTaskAction } from "./actions";

export const metadata = { title: "Tarefas" };

const TYPE: Record<string, string> = { FOLLOW_UP: "Follow-up", CALL: "Ligar", MESSAGE: "Mensagem", VISIT: "Visita", BIRTHDAY: "Aniversário", REACTIVATION: "Reativar", OTHER: "Outro" };
const SYSTEM_TYPE: Record<string, string> = { JOURNEY: "Régua", RECOVERY: "Retomada", OUTREACH: "Prospecção", LOCKER_PREP: "Armário VIP" };
const VIEWS = [{ key: "minhas", label: "Minhas" }, { key: "todas", label: "Todas" }, { key: "atrasadas", label: "Atrasadas" }, { key: "feitas", label: "Concluídas" }];
const fmt = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const dayKey = (iso: string) => new Date(new Date(iso).getTime() - 3 * 3_600_000).toISOString().slice(0, 10);

export default async function TarefasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const ver = VIEWS.some((v) => v.key === str(sp.ver)) ? str(sp.ver)! : "minhas";
  const tipo = Object.keys(TYPE).includes(str(sp.tipo) ?? "") ? str(sp.tipo)! : "";
  const supabase = await createClient();
  let q = supabase.schema("crm").from("tasks").select("id, title, type, body, suggested_message, due_at, status, created_by_ai, party_id, assignee_member_id, completed_at, parties(display_name), deals(title)").limit(300);
  q = ver === "feitas" ? q.eq("status", "DONE").order("completed_at", { ascending: false }) : q.eq("status", "OPEN").order("due_at", { ascending: true, nullsFirst: false });
  if (ver === "minhas") q = q.eq("assignee_member_id", session.memberId);
  if (tipo) q = q.eq("type", tipo);
  if (str(sp.quando) === "hoje") q = q.lt("due_at", `${addDaysIsoSP(1)}T00:00:00-03:00`);
  const { data: rows } = await q;
  const { data: members } = await supabase.schema("core").from("members").select("id, display_name").order("display_name");
  const who = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const now = isoFromNow(0), today = dayKey(now);
  let tasks = rows ?? [];
  if (ver === "atrasadas") tasks = tasks.filter((t) => t.due_at && t.due_at < now);

  const groups: { title: string; tone?: "danger" | "warning"; items: typeof tasks }[] = ver === "feitas" ? [{ title: "Concluídas", items: tasks }] : [
    { title: "Atrasadas", tone: "danger", items: tasks.filter((t) => t.due_at && t.due_at < now && dayKey(t.due_at) < today) },
    { title: "Hoje", tone: "warning", items: tasks.filter((t) => t.due_at && dayKey(t.due_at) === today) },
    { title: "Próximas", items: tasks.filter((t) => t.due_at && dayKey(t.due_at) > today) },
    { title: "Sem data", items: tasks.filter((t) => !t.due_at) },
  ];

  return (
    <>
      <PageHeader title="Tarefas & próximas ações" description="O que fazer com cada cliente e quando. A IA também sugere tarefas, já com a mensagem pronta." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {tipo && <Link href={`/clientes/tarefas?ver=${ver}`} className="rounded-full border border-brand bg-brand/10 px-3 py-1 text-sm text-brand">Só {TYPE[tipo].toLowerCase()} ✕</Link>}
        {VIEWS.map((v) => <Link key={v.key} href={`/clientes/tarefas?ver=${v.key}${tipo ? `&tipo=${tipo}` : ""}`} className={cn("rounded-full border px-3 py-1 text-sm", ver === v.key ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2")}>{v.label}</Link>)}
      </div>

      {canWrite && (
        <Card title="Nova tarefa" className="mb-4">
          <form action={createTaskAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <input type="hidden" name="ver" value={ver} />
            <Field label="O que fazer" className="lg:col-span-2"><input name="title" required minLength={2} maxLength={140} className={inputClass} placeholder="Mandar fotos do look que ela gostou" /></Field>
            <Field label="Cliente (opcional)"><input name="party" className={inputClass} placeholder="Nome ou telefone" /></Field>
            <Field label="Tipo"><select name="type" defaultValue="FOLLOW_UP" className={inputClass}>{Object.entries(TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Quando"><div className="flex gap-2"><input name="due_date" type="date" className={inputClass} /><input name="due_time" type="time" className={`${inputClass} max-w-[7rem]`} /></div></Field>
            <Field label="Responsável"><select name="assignee" defaultValue={session.memberId} className={inputClass}>{(members ?? []).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>
            <Field label="Mensagem pronta (opcional)" className="sm:col-span-2"><input name="suggested_message" maxLength={600} className={inputClass} placeholder="Oi! Separei o look que você gostou 💛" /></Field>
            <div className="sm:col-span-2 lg:col-span-4"><Button>Criar tarefa</Button></div>
          </form>
        </Card>
      )}

      {tasks.length === 0 ? <Empty title={ver === "feitas" ? "Nenhuma tarefa concluída ainda" : "Nada pendente aqui"}>{ver === "minhas" ? "Quando surgir uma próxima ação para você, ela aparece neste lugar." : undefined}</Empty> : (
        <div className="space-y-4">
          {groups.filter((g) => g.items.length > 0).map((g) => (
            <section key={g.title} aria-label={g.title}>
              <h2 className="mb-1.5 flex items-center gap-2 text-sm font-semibold">{g.title} <Badge tone={g.tone ?? "neutral"}>{g.items.length}</Badge></h2>
              <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
                {g.items.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{t.title} <Badge>{TYPE[t.type] ?? SYSTEM_TYPE[t.type] ?? t.type}</Badge>{t.created_by_ai && <span className="ml-1"><Badge tone="brand">sugerida pela IA</Badge></span>}</p>
                      <p className="text-xs text-muted">
                        {t.party_id ? <Link className="text-brand" href={`/clientes/${t.party_id}`}>{t.parties?.display_name}</Link> : "Sem cliente"}
                        {t.deals?.title ? ` · ${t.deals.title}` : ""}{t.assignee_member_id && ver !== "minhas" ? ` · ${who.get(t.assignee_member_id) ?? ""}` : ""}
                        {t.due_at ? <span className={cn(t.status === "OPEN" && t.due_at < now && "text-danger")}> · {fmt(t.due_at)}</span> : ""}
                      </p>
                      {t.suggested_message && <details className="mt-1"><summary className="cursor-pointer text-xs text-brand">Mensagem pronta</summary><p className="mt-1 whitespace-pre-line rounded-lg bg-surface-2 px-3 py-2 text-sm">{t.suggested_message}</p></details>}
                      {canWrite && t.status === "OPEN" && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs text-brand">Editar / atribuir</summary>
                          <form action={updateTaskAction} className="mt-2 grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-6">
                            <input type="hidden" name="id" value={t.id} /><input type="hidden" name="ver" value={ver} />
                            <Field label="Título" className="sm:col-span-3"><input name="title" required minLength={2} maxLength={140} defaultValue={t.title} className={inputClass} /></Field>
                            <Field label="Responsável" className="sm:col-span-3"><select name="assignee" defaultValue={t.assignee_member_id ?? ""} className={inputClass}><option value="">— sem responsável —</option>{(members ?? []).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>
                            <Field label="Tipo" className="sm:col-span-2"><select name="type" defaultValue={TYPE[t.type] ? t.type : ""} className={inputClass}>{!TYPE[t.type] && <option value="">{SYSTEM_TYPE[t.type] ?? t.type}</option>}{Object.entries(TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                            <Field label="Prazo" className="sm:col-span-4"><div className="flex gap-2"><input name="due_date" type="date" defaultValue={t.due_at ? dayKey(t.due_at) : ""} className={inputClass} /><input name="due_time" type="time" defaultValue={t.due_at ? new Date(t.due_at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }) : ""} className={`${inputClass} max-w-[7rem]`} /></div></Field>
                            <Field label="Mensagem pronta" className="sm:col-span-6"><textarea name="suggested_message" rows={2} maxLength={600} defaultValue={t.suggested_message ?? ""} className={inputClass} /></Field>
                            <div className="sm:col-span-6"><Button variant="secondary" className="px-3 py-1.5 text-xs">Salvar tarefa</Button></div>
                          </form>
                        </details>
                      )}
                    </div>
                    {canWrite && (
                      <div className="flex flex-wrap items-center gap-1">
                        {t.status === "OPEN" ? (
                          <>
                            <form action={setTaskStatusAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value="DONE" /><input type="hidden" name="ver" value={ver} /><Button variant="secondary" className="px-2 py-1 text-xs">Concluir</Button></form>
                            <form action={postponeTaskAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="days" value="1" /><input type="hidden" name="ver" value={ver} /><Button variant="ghost" className="px-2 py-1 text-xs">Amanhã</Button></form>
                            <form action={postponeTaskAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="days" value="7" /><input type="hidden" name="ver" value={ver} /><Button variant="ghost" className="px-2 py-1 text-xs">+7 dias</Button></form>
                            <form action={setTaskStatusAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value="CANCELLED" /><input type="hidden" name="ver" value={ver} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Cancelar</Button></form>
                          </>
                        ) : <form action={setTaskStatusAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value="OPEN" /><input type="hidden" name="ver" value={ver} /><Button variant="ghost" className="px-2 py-1 text-xs">Reabrir</Button></form>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
