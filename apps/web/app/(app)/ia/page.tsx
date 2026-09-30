import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, cn, Empty, inputClass, PageHeader, Stat } from "@/components/ui";
import { Flash } from "@/components/form";
import { decideSuggestionAction, runDetectorsAction } from "./actions";

export const metadata = { title: "Central de sugestões" };

const VIEWS = [{ key: "abertas", label: "Abertas" }, { key: "resolvidas", label: "Resolvidas" }, { key: "ignoradas", label: "Ignoradas" }, { key: "todas", label: "Todas" }];
const SEVERITY: Record<string, { label: string; tone: "danger" | "warning" | "neutral"; order: number }> = { HIGH: { label: "urgente", tone: "danger", order: 0 }, MEDIUM: { label: "atenção", tone: "warning", order: 1 }, LOW: { label: "info", tone: "neutral", order: 2 } };
const KIND: Record<string, string> = { ANOMALY: "Anomalia", REORDER: "Reposição", NBA: "Próxima ação", CATEGORIZATION: "Classificação", RECON_MATCH: "Conciliação", SKU_MATCH: "Produto da nota", REACTIVATION: "Reativação", ALLOCATION: "Rateio" };
const STATUS_LABEL: Record<string, string> = { ACCEPTED: "resolvida", DISMISSED: "ignorada", AUTO_APPLIED: "encerrada sozinha" };
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

interface Payload { title?: string; detail?: string; href?: string; severity?: string; rule?: string }

export default async function CentralPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("ai.read");
  const sp = await searchParams;
  const canWrite = can(session, "ai.write");
  const ver = VIEWS.some((v) => v.key === str(sp.ver)) ? str(sp.ver)! : "abertas";
  const supabase = await createClient();
  let q = supabase.schema("ai").from("suggestions").select("id, kind, payload, status, created_at, decided_at, decision_note, decided_by").limit(200);
  q = ver === "abertas" ? q.eq("status", "OPEN").order("created_at", { ascending: false }) : ver === "resolvidas" ? q.in("status", ["ACCEPTED", "AUTO_APPLIED"]).order("decided_at", { ascending: false }) : ver === "ignoradas" ? q.eq("status", "DISMISSED").order("decided_at", { ascending: false }) : q.order("created_at", { ascending: false });
  const [{ data: items }, { data: open }, { data: members }] = await Promise.all([
    q,
    supabase.schema("ai").from("suggestions").select("payload").eq("status", "OPEN").limit(500),
    supabase.schema("core").from("members").select("id, display_name"),
  ]);
  const who = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const count = (sev: string) => (open ?? []).filter((o) => ((o.payload as Payload).severity ?? "MEDIUM") === sev).length;
  const sorted = [...(items ?? [])].sort((a, b) => (ver === "abertas" ? (SEVERITY[(a.payload as Payload).severity ?? "MEDIUM"]?.order ?? 1) - (SEVERITY[(b.payload as Payload).severity ?? "MEDIUM"]?.order ?? 1) : 0));

  return (
    <>
      <PageHeader title="Central de sugestões" description="O que merece a sua atenção, apontado todo dia de manhã por regras simples e explicáveis. Resolva ou ignore (com o motivo): o que você decidiu não volta."
        actions={canWrite ? <form action={runDetectorsAction}><Button variant="secondary">Verificar agora</Button></form> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label="Urgentes" value={count("HIGH")} tone={count("HIGH") > 0 ? "danger" : "success"} />
        <Stat label="Pedem atenção" value={count("MEDIUM")} tone={count("MEDIUM") > 0 ? "warning" : undefined} />
        <Stat label="Abertas no total" value={(open ?? []).length} />
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {VIEWS.map((v) => <Link key={v.key} href={`/ia?ver=${v.key}`} className={cn("rounded-full border px-3 py-1 text-sm", ver === v.key ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2")}>{v.label}</Link>)}
      </div>

      {sorted.length === 0 ? <Empty title={ver === "abertas" ? "Tudo em ordem" : "Nada por aqui"}>{ver === "abertas" ? "Nenhum ponto de atenção aberto. A verificação roda todo dia às 6h." : undefined}</Empty> : (
        <ul className="space-y-2">
          {sorted.map((s) => {
            const p = s.payload as Payload;
            const sev = SEVERITY[p.severity ?? "MEDIUM"] ?? SEVERITY.MEDIUM;
            return (
              <li key={s.id} className="rounded-xl border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {s.status === "OPEN" ? <Badge tone={sev.tone}>{sev.label}</Badge> : <Badge tone="neutral">{STATUS_LABEL[s.status]}</Badge>}
                  <Badge tone="info">{KIND[s.kind] ?? s.kind}</Badge>
                  <p className="font-medium">{p.title}</p>
                  <span className="ml-auto text-xs text-muted">{when(s.created_at)}</span>
                </div>
                {p.detail && <p className="mt-1 text-sm text-muted">{p.detail}</p>}
                {s.status !== "OPEN" && <p className="mt-1 text-xs text-muted">{s.decided_by ? `${who.get(s.decided_by) ?? "—"} · ` : ""}{s.decided_at ? when(s.decided_at) : ""}{s.decision_note ? ` · ${s.decision_note}` : ""}</p>}
                <div className="mt-2 flex flex-wrap items-start gap-2">
                  {p.href && <Link href={p.href} className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-surface-2">Ver e resolver</Link>}
                  {s.status === "OPEN" && canWrite && (
                    <>
                      <form action={decideSuggestionAction} className="flex items-center gap-1">
                        <input type="hidden" name="id" value={s.id} /><input type="hidden" name="status" value="ACCEPTED" /><input type="hidden" name="ver" value={ver} />
                        <input name="note" placeholder="Nota (opcional)" maxLength={200} className={`${inputClass} w-40 py-1 text-xs`} aria-label="Nota" />
                        <Button variant="secondary" className="px-2 py-1 text-xs">Resolvi</Button>
                      </form>
                      <details>
                        <summary className="cursor-pointer rounded-lg px-2 py-1 text-xs text-muted hover:bg-surface-2">Ignorar…</summary>
                        <form action={decideSuggestionAction} className="mt-1 flex gap-1">
                          <input type="hidden" name="id" value={s.id} /><input type="hidden" name="status" value="DISMISSED" /><input type="hidden" name="ver" value={ver} />
                          <input name="note" required minLength={3} maxLength={200} placeholder="Por que ignorar?" className={`${inputClass} w-52 py-1 text-xs`} aria-label="Motivo" />
                          <Button variant="ghost" className="px-2 py-1 text-xs">Ignorar</Button>
                        </form>
                      </details>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
