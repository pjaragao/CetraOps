import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { AutoRefresh } from "@/components/auto-refresh";
import { CopyButton } from "@/components/copy-button";
import { Badge, Button, cn, Empty, inputClass, PageHeader, Stat } from "@/components/ui";
import { Flash } from "@/components/form";
import { generateOutreachAction, saveOutreachMessageAction, setOutreachStatusAction } from "./actions";

export const metadata = { title: "Prospecção assistida" };

const STEP: Record<string, { label: string; how: string }> = {
  STORY: { label: "Story", how: "Assista aos stories do perfil e reaja a um (uma reação simples, sem texto)." },
  LIKE: { label: "Curtir", how: "Curta de 2 a 3 fotos recentes, sem exagero." },
  FOLLOW: { label: "Seguir", how: "Siga o perfil pelo app." },
  DM: { label: "DM", how: "Envie a mensagem abaixo pelo app oficial do Instagram (copie, cole e ajuste ao tom da conversa)." },
};
const VIEWS = [{ key: "hoje", label: "Para fazer" }, { key: "feitas", label: "Feitas" }, { key: "todas", label: "Da equipe" }];

export default async function ProspeccaoPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const ver = VIEWS.some((v) => v.key === str(sp.ver)) ? str(sp.ver)! : "hoje";
  const supabase = await createClient();
  let q = supabase.schema("crm").from("outreach_items").select("id, party_id, playbook_step, suggested_message, status, due_on, assigned_member_id, done_at, skip_reason, evidence_message_id, parties:party_id(display_name, instagram_handle, profession, city, lead_score)").limit(200);
  q = ver === "feitas" ? q.in("status", ["SENT_MANUALLY", "SKIPPED"]).order("done_at", { ascending: false }) : q.in("status", ["SUGGESTED", "APPROVED"]).order("due_on").order("created_at");
  if (ver !== "todas") q = q.eq("assigned_member_id", session.memberId);
  const [{ data: items }, { data: setting }, { count: today }] = await Promise.all([
    q,
    supabase.schema("core").from("settings").select("value").eq("key", "outreach").maybeSingle(),
    supabase.schema("crm").from("outreach_items").select("id", { count: "exact", head: true }).eq("assigned_member_id", session.memberId).eq("due_on", todayIsoSP()).neq("status", "SKIPPED"),
  ]);
  const limit = Number((setting?.value as { daily_limit?: number } | null)?.daily_limit ?? 15);
  const drafting = (items ?? []).some((i) => i.playbook_step === "DM" && !i.suggested_message);

  return (
    <>
      <PageHeader title="Prospecção assistida" description="O sistema separa quem abordar hoje, na cadência story → curtir → seguir → DM, e a IA redige a primeira mensagem. Você faz tudo pelo app oficial do Instagram: nada de robô, que arrisca banir o perfil da marca."
        actions={canWrite ? <form action={generateOutreachAction}><Button>Gerar lista de hoje</Button></form> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(str(sp.wait) || drafting) && <AutoRefresh />}
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label="Na sua lista de hoje" value={`${today ?? 0} / ${limit}`} hint="Meta diária (limite contra abordagem em massa)" tone={(today ?? 0) >= limit ? "success" : undefined} />
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {VIEWS.map((v) => <Link key={v.key} href={`/clientes/prospeccao?ver=${v.key}`} className={cn("rounded-full border px-3 py-1 text-sm", ver === v.key ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2")}>{v.label}</Link>)}
      </div>

      {(items ?? []).length === 0 ? <Empty title={ver === "feitas" ? "Nada feito ainda" : "Lista vazia"}>{ver === "hoje" ? "Use “Gerar lista de hoje”: entram leads com @ do Instagram que ainda não foram abordados." : undefined}</Empty> : (
        <ul className="space-y-2">
          {(items ?? []).map((i) => {
            const st = STEP[i.playbook_step];
            const handle = i.parties?.instagram_handle?.replace(/^@/, "");
            const open = i.status === "SUGGESTED" || i.status === "APPROVED";
            return (
              <li key={i.id} className="rounded-xl border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={i.playbook_step === "DM" ? "brand" : "info"}>{st.label}</Badge>
                  <Link href={`/clientes/${i.party_id}`} className="font-medium hover:underline">{i.parties?.display_name}</Link>
                  {handle && <a href={`https://instagram.com/${encodeURIComponent(handle)}`} target="_blank" rel="noopener noreferrer" className="text-sm text-brand">@{handle}</a>}
                  <span className="text-xs text-muted">{[i.parties?.profession, i.parties?.city].filter(Boolean).join(" · ")}{i.parties?.lead_score ? ` · score ${i.parties.lead_score}` : ""}</span>
                  {i.status === "APPROVED" && <Badge tone="success">mensagem aprovada</Badge>}
                  {i.status === "SENT_MANUALLY" && <Badge tone="success">feito{i.evidence_message_id ? " (vinculado pelo eco)" : ""}</Badge>}
                  {i.status === "SKIPPED" && <Badge tone="warning">pulado: {i.skip_reason}</Badge>}
                </div>
                {open && <p className="mt-1 text-sm text-muted">{st.how}</p>}
                {i.playbook_step === "DM" && open && (
                  <div className="mt-2">
                    {i.suggested_message ? (
                      <form action={saveOutreachMessageAction} className="space-y-2">
                        <input type="hidden" name="id" value={i.id} /><input type="hidden" name="ver" value={ver} />
                        <textarea name="message" defaultValue={i.suggested_message} rows={3} maxLength={500} className={inputClass} aria-label="Mensagem" disabled={!canWrite} />
                        {canWrite && <div className="flex flex-wrap gap-2"><Button variant="secondary" className="px-2 py-1 text-xs">Salvar texto</Button><CopyButton text={i.suggested_message} /></div>}
                      </form>
                    ) : <p className="text-sm text-muted">Redigindo a mensagem…</p>}
                  </div>
                )}
                {open && canWrite && (
                  <div className="mt-2 flex flex-wrap items-start gap-2">
                    <form action={setOutreachStatusAction}><input type="hidden" name="id" value={i.id} /><input type="hidden" name="ver" value={ver} /><input type="hidden" name="status" value="SENT_MANUALLY" /><Button className="px-2 py-1 text-xs">Já fiz</Button></form>
                    {i.playbook_step === "DM" && i.status === "SUGGESTED" && i.suggested_message && (
                      <form action={setOutreachStatusAction}><input type="hidden" name="id" value={i.id} /><input type="hidden" name="ver" value={ver} /><input type="hidden" name="status" value="APPROVED" /><Button variant="secondary" className="px-2 py-1 text-xs">Aprovar mensagem</Button></form>
                    )}
                    <details>
                      <summary className="cursor-pointer rounded-lg px-2 py-1 text-xs text-muted hover:bg-surface-2">Pular…</summary>
                      <form action={setOutreachStatusAction} className="mt-1 flex gap-2">
                        <input type="hidden" name="id" value={i.id} /><input type="hidden" name="ver" value={ver} /><input type="hidden" name="status" value="SKIPPED" />
                        <input name="note" required minLength={3} maxLength={200} className={`${inputClass} w-64`} placeholder="Motivo (ex.: perfil privado, pediu para parar)" />
                        <Button variant="ghost" className="px-2 py-1 text-xs">Pular</Button>
                      </form>
                    </details>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
