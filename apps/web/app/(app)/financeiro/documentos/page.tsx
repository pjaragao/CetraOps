import Link from "next/link";
import { redirect } from "next/navigation";
import { DOC_DESTINATIONS, DOC_KINDS, docAmount, docCounterpart, docMissing, docReady, formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash, fmtDate } from "@/components/form";
import { confirmDocAction, confirmManyDocsAction, discardDocAction } from "./actions";
import { DocUploader } from "./uploader";

export const metadata = { title: "Caixa de documentos" };

type Fields = Record<string, string | number | null>;
type Dup = { tipo?: string; ref?: string; href?: string } | null;
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const brInput = (n: number | null) => (n === null ? "" : n.toFixed(2).replace(".", ","));

/** Vários documentos de uma vez → conta a pagar, reembolso ou recebimento, sempre confirmados aqui. */
export default async function DocumentosPage({ searchParams }: { searchParams: SP }) {
  const session = await getSession();
  const canPay = can(session, "fin.write"), canReimb = can(session, "fin.reimburse") || canPay, canReceive = can(session, "purch.write");
  if (!canPay && !canReimb && !canReceive) redirect("/inicio?erro=sem-permissao");
  const sp = await searchParams;
  const supabase = await createClient();
  const [{ data: pending }, { data: done }] = await Promise.all([
    supabase.schema("fin").from("doc_inbox").select("*").eq("status", "PENDING").order("created_at", { ascending: false }).limit(200),
    supabase.schema("fin").from("doc_inbox").select("id, label, target_label, target_href, decided_at, kind").eq("status", "DONE").order("decided_at", { ascending: false }).limit(str(sp.ver) === "feitos" ? 100 : 10),
  ]);
  const rows = pending ?? [];
  const memberIds = [...new Set(rows.map((r) => r.member_id).filter((m): m is string => Boolean(m) && m !== session.memberId))];
  const { data: members } = memberIds.length ? await supabase.schema("core").from("members").select("id, display_name").in("id", memberIds) : { data: [] as { id: string; display_name: string }[] };
  const who = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const ready = rows.filter((r) => docReady({ kind: r.kind, destination: r.destination, duplicate: r.duplicate, fields: r.fields as Fields })
    && (r.destination !== "PAYABLE" || canPay) && (r.destination !== "RECEIPT" || canReceive) && (r.destination !== "REIMBURSEMENT" || r.member_id === session.memberId));

  const options = (r: (typeof rows)[number]) => (Object.keys(DOC_DESTINATIONS) as (keyof typeof DOC_DESTINATIONS)[]).filter((d) =>
    d === r.destination || (d === "PAYABLE" && canPay && r.kind !== "identidade") || (d === "REIMBURSEMENT" && canReimb && r.member_id === session.memberId && r.kind !== "identidade")
    || (d === "RECEIPT" && canReceive && r.kind === "nfe_xml"));

  return (
    <>
      <PageHeader title="Caixa de documentos"
        description="Solte boletos, Pix, notas, cupons e XML de NF-e de uma vez. Cada um é lido e vai para o lugar certo: conta a pagar, reembolso ou recebimento. Nada é lançado sem você confirmar." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <Card className="mb-4"><DocUploader /></Card>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{rows.length ? `${rows.length} documento(s) na fila` : "Fila vazia"}</h2>
        {ready.length > 0 && (
          <form action={confirmManyDocsAction}>
            {ready.map((r) => <input key={r.id} type="hidden" name="ids" value={r.id} />)}
            <Button>Lançar os {ready.length} prontos</Button>
          </form>
        )}
      </div>

      {rows.length === 0 ? <Empty title="Nenhum documento esperando">O que você soltar acima aparece aqui com o destino sugerido.</Empty> : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const f = (r.fields ?? {}) as Fields;
            const dup = r.duplicate as Dup;
            const amount = docAmount(f);
            const missing = docMissing({ kind: r.kind, destination: r.destination, duplicate: dup, fields: f });
            const checks = Array.isArray(r.checks) ? (r.checks as string[]) : [];
            return (
              <li key={r.id} className="rounded-xl border border-border bg-surface p-3" data-doc={r.label}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{r.label}</p>
                    <p className="text-xs text-muted">
                      {DOC_KINDS[r.kind] ?? r.kind}{r.file_name ? ` · ${r.file_name}` : ""} · {when(r.created_at)}{r.member_id && who.get(r.member_id) ? ` · enviado por ${who.get(r.member_id)}` : ""}
                    </p>
                  </div>
                  <Badge tone={r.destination === "REVIEW" ? "warning" : "info"}>{DOC_DESTINATIONS[r.destination as keyof typeof DOC_DESTINATIONS] ?? r.destination}</Badge>
                </div>
                <p className="mt-1 text-sm">
                  {[docCounterpart(f), amount !== null ? formatBRL(amount) : null, f.vencimento ? `vence ${fmtDate(String(f.vencimento))}` : null, f.data ? `de ${fmtDate(String(f.data))}` : null]
                    .filter(Boolean).join(" · ") || "—"}
                </p>
                {r.destination_reason && <p className="mt-1 text-xs text-muted">{r.destination_reason}</p>}
                {checks.map((c, i) => <p key={i} className="mt-1 text-xs text-warning">{c}</p>)}
                {dup && (
                  <p className="mt-1 text-sm text-danger">
                    Parece duplicado: {dup.tipo}{dup.ref ? ` (${dup.ref})` : ""}{dup.href && <> · <Link href={dup.href} className="underline">ver</Link></>}
                  </p>
                )}
                <form action={confirmDocAction} className="mt-2 grid gap-2 sm:grid-cols-6 sm:items-end">
                  <input type="hidden" name="id" value={r.id} />
                  <Field label="Destino" className="sm:col-span-2">
                    <select name="destination" defaultValue={r.destination === "REVIEW" ? "" : r.destination} className={inputClass} aria-label={`Destino de ${r.label}`}>
                      <option value="">Escolha…</option>
                      {options(r).filter((d) => d !== "REVIEW").map((d) => <option key={d} value={d}>{DOC_DESTINATIONS[d]}</option>)}
                    </select>
                  </Field>
                  <Field label="Descrição" className="sm:col-span-2">
                    <input name="descricao" defaultValue={String(f.descricao ?? "") || r.label} className={inputClass} aria-label={`Descrição de ${r.label}`} />
                  </Field>
                  <Field label="Valor (R$)">
                    <input name="valor" inputMode="decimal" defaultValue={brInput(amount)} className={inputClass} aria-label={`Valor de ${r.label}`} />
                  </Field>
                  {r.kind === "nfe_xml" ? <span className="text-xs text-muted">Vencimentos: os da nota</span> : r.kind === "nota_ou_recibo" ? (
                    <Field label="Data do gasto"><input type="date" name="data" defaultValue={String(f.data ?? "")} className={inputClass} aria-label={`Data de ${r.label}`} /></Field>
                  ) : (
                    <Field label="Vencimento"><input type="date" name="vencimento" defaultValue={String(f.vencimento ?? "")} className={inputClass} aria-label={`Vencimento de ${r.label}`} /></Field>
                  )}
                  <div className="flex flex-wrap items-center gap-2 sm:col-span-6">
                    {dup && <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="force" value="1" /> lançar mesmo assim</label>}
                    <Button>Lançar</Button>
                    {missing.length > 0 && <span className="text-xs text-muted">falta: {missing.join(", ")}</span>}
                  </div>
                </form>
                <form action={discardDocAction} className="mt-1">
                  <input type="hidden" name="id" value={r.id} />
                  <button className="text-xs text-muted hover:text-danger" aria-label={`Descartar ${r.label}`}>Descartar</button>
                </form>
              </li>
            );
          })}
        </ul>
      )}

      {(done ?? []).length > 0 && (
        <Card className="mt-6" title="Lançados recentemente" action={str(sp.ver) === "feitos" ? undefined : <Link href="/financeiro/documentos?ver=feitos" className="text-sm text-brand">ver mais</Link>}>
          <ul className="divide-y divide-border text-sm">
            {(done ?? []).map((d) => (
              <li key={d.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                <span>{d.label}</span>
                <span className="text-muted">{d.target_href ? <Link href={d.target_href} className="text-brand hover:underline">{d.target_label}</Link> : d.target_label}{d.decided_at ? ` · ${when(d.decided_at)}` : ""}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
