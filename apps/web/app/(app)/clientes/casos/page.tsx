import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { isoFromNow, str, type SP } from "@/lib/context";
import { Badge, Button, Card, cn, Empty, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { assignCaseAction, openCaseAction, reopenCaseAction, resolveCaseAction, respondedCaseAction } from "./actions";

export const metadata = { title: "Casos" };

const KIND: Record<string, string> = { COMPLAINT: "Reclamação", DEFECT: "Defeito / troca", DELIVERY: "Entrega", SERVICE: "Atendimento", CSAT: "Nota baixa", NPS: "NPS (detratora)", OTHER: "Outro" };
const FILTERS = [{ key: "abertos", label: "Abertos" }, { key: "atrasados", label: "Atrasados" }, { key: "resolvidos", label: "Resolvidos" }];
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export default async function CasosPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const filtro = str(sp.filtro) ?? "abertos";
  const supabase = await createClient();
  let q = supabase.schema("crm").from("cases").select("id, number, party_id, kind, title, description, status, owner_member_id, opened_at, first_response_due, first_response_at, resolve_due, resolved_at, solution, courtesy_amount, source").order("opened_at", { ascending: false }).limit(100);
  if (filtro === "resolvidos") q = q.eq("status", "RESOLVED"); else q = q.neq("status", "RESOLVED");
  const [{ data: cases }, { data: members }] = await Promise.all([q, supabase.schema("core").from("members").select("id, display_name").eq("status", "ACTIVE").order("display_name")]);
  const now = new Date(isoFromNow(0)).getTime();
  const late = (c: { first_response_at: string | null; first_response_due: string; resolve_due: string; status: string }) =>
    c.status !== "RESOLVED" && ((!c.first_response_at && new Date(c.first_response_due).getTime() < now) || new Date(c.resolve_due).getTime() < now);
  const list = filtro === "atrasados" ? (cases ?? []).filter(late) : (cases ?? []);
  const ids = [...new Set(list.map((c) => c.party_id))];
  const { data: parties } = ids.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", ids) : { data: [] as { id: string; display_name: string }[] };
  const who = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const owner = new Map((members ?? []).map((m) => [m.id, m.display_name]));

  return (
    <>
      <PageHeader title="Casos" description="Reclamação, defeito ou nota baixa vira um caso com dona e prazo (1ª resposta em 1 hora útil, solução em 48 h). Enquanto o caso está aberto, a cliente fica fora das mensagens de marketing. Ao resolver, o retorno é agendado para 7 dias." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => <Link key={f.key} href={`/clientes/casos?filtro=${f.key}`} className={cn("rounded-full border px-3 py-1 text-sm", filtro === f.key ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2")}>{f.label}</Link>)}
      </div>
      {list.length === 0 ? <Empty title="Nenhum caso aqui">Quando uma cliente reclamar, abra um caso para não perder o prazo.</Empty> : (
        <ul className="space-y-3">
          {list.map((c) => (
            <li key={c.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted">{c.number}</span>
                <Link href={`/clientes/${c.party_id}`} className="font-medium text-brand">{who.get(c.party_id) ?? "Cliente"}</Link>
                <Badge tone="info">{KIND[c.kind] ?? c.kind}</Badge>
                <Badge tone={c.status === "RESOLVED" ? "success" : late(c) ? "danger" : "warning"}>{c.status === "RESOLVED" ? "resolvido" : late(c) ? "atrasado" : c.status === "IN_PROGRESS" ? "em andamento" : "aberto"}</Badge>
                <span className="ml-auto text-xs text-muted">aberto {when(c.opened_at)} · responsável: {c.owner_member_id ? owner.get(c.owner_member_id) ?? "—" : "ninguém"}</span>
              </div>
              <p className="mt-1 text-sm font-medium">{c.title}</p>
              {c.description && <p className="text-sm text-muted">{c.description}</p>}
              {c.status === "RESOLVED" ? (
                <p className="mt-2 rounded-lg bg-success/10 px-3 py-2 text-sm">Solução: {c.solution}{Number(c.courtesy_amount) > 0 && ` · vale de cortesia ${formatBRL(Number(c.courtesy_amount))}`}<span className="block text-xs text-muted">resolvido {c.resolved_at && when(c.resolved_at)}</span></p>
              ) : (
                <p className="mt-1 text-xs text-muted">1ª resposta até {when(c.first_response_due)}{c.first_response_at ? ` (feita ${when(c.first_response_at)})` : ""} · solução até {when(c.resolve_due)}</p>
              )}
              {canWrite && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  {c.status !== "RESOLVED" ? (
                    <>
                      <form action={assignCaseAction} className="flex items-center gap-1"><input type="hidden" name="id" value={c.id} />
                        <select name="member" defaultValue={c.owner_member_id ?? ""} className={`${inputClass} w-40 py-1 text-xs`} aria-label={`Responsável pelo ${c.number}`}><option value="">Ninguém</option>{(members ?? []).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select>
                        <Button variant="ghost" className="px-2 py-1 text-xs">Atribuir</Button></form>
                      {!c.first_response_at && <form action={respondedCaseAction}><input type="hidden" name="id" value={c.id} /><Button variant="ghost" className="px-2 py-1 text-xs">Já respondi</Button></form>}
                      <form action={resolveCaseAction} className="flex flex-wrap items-end gap-1">
                        <input type="hidden" name="id" value={c.id} />
                        <input name="solution" required minLength={5} placeholder="O que foi feito (solução)" aria-label={`Solução do ${c.number}`} className={`${inputClass} w-64 py-1 text-xs`} />
                        <input name="courtesy" inputMode="decimal" placeholder="Vale cortesia R$" aria-label={`Vale de cortesia do ${c.number}`} className={`${inputClass} w-32 py-1 text-xs`} />
                        <Button className="px-2 py-1 text-xs">Resolver</Button>
                      </form>
                    </>
                  ) : <form action={reopenCaseAction}><input type="hidden" name="id" value={c.id} /><Button variant="ghost" className="px-2 py-1 text-xs">Reabrir</Button></form>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <Card className="mt-6" title="Abrir um caso">
          <form action={openCaseAction} className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <Field label="Cliente (nome ou telefone)"><input name="party" required className={inputClass} /></Field>
            <Field label="Tipo"><select name="kind" className={inputClass} defaultValue="COMPLAINT">{["COMPLAINT", "DEFECT", "DELIVERY", "SERVICE", "OTHER"].map((k) => <option key={k} value={k}>{KIND[k]}</option>)}</select></Field>
            <Field label="O que aconteceu" className="sm:col-span-2"><input name="title" required minLength={3} maxLength={140} className={inputClass} placeholder="Legging com a costura aberta" /></Field>
            <Field label="Detalhes (opcional)" className="sm:col-span-3"><input name="description" maxLength={1000} className={inputClass} /></Field>
            <Button>Abrir caso</Button>
          </form>
        </Card>
      )}
    </>
  );
}
