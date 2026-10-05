import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";
import { isoFromNow, str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { ReimbursementForm, type ItemDraft } from "../reimbursement-form";
import { DOC_KIND, STATUS } from "../labels";
import { cancelReimbursementAction, classifyItemAction, decideReimbursementAction, submitReimbursementAction, uploadAttachmentAction } from "../actions";

export const metadata = { title: "Reembolso" };

const fmtDate = (d: string | null) => (d ? d.split("-").reverse().join("/") : "—");
const fmtDoc = (d: string | null) => (!d ? "" : d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4"));

export default async function ReembolsoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await getSession();
  if (!can(session, "fin.read") && !can(session, "fin.reimburse")) redirect("/inicio?erro=sem-permissao");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: r } = await supabase.schema("fin").from("reimbursements").select("*").eq("id", id).maybeSingle();
  if (!r) notFound();
  const { data: items } = await supabase.schema("fin").from("reimbursement_items").select("*").eq("reimbursement_id", id).order("position");
  const { data: person } = await supabase.schema("crm").from("parties").select("display_name").eq("id", r.party_id).maybeSingle();
  const mine = r.requester_member_id === session.memberId;
  const editable = ["DRAFT", "REJECTED"].includes(r.status) && (mine || can(session, "fin.write"));
  const approver = can(session, "fin.approve") && r.status === "SUBMITTED";
  // links temporários (1 h) para ver os comprovantes no bucket privado
  const paths = (items ?? []).map((i) => i.attachment_path).filter(Boolean) as string[];
  const signed = paths.length ? (await supabase.storage.from("fin-docs").createSignedUrls(paths, 3600)).data ?? [] : [];
  const urlOf = new Map(signed.filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl]));
  const [{ data: accounts }, { data: ccs }] = approver || editable && can(session, "fin.read")
    ? await Promise.all([
        supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC").or("group.in.(EXPENSE,COGS,FINANCIAL)").is("archived_at", null).order("code"),
        supabase.schema("core").from("cost_centers").select("id, code, name").is("archived_at", null).order("code"),
      ])
    : [{ data: [] as { id: string; code: string; name: string }[] }, { data: [] as { id: string; code: string; name: string }[] }];
  const accLabel = new Map((accounts ?? []).map((a) => [a.id, `${a.code} · ${a.name}`]));
  const today = isoFromNow(-3).slice(0, 10);
  const drafts: ItemDraft[] = (items ?? []).map((i) => ({
    id: i.id, spent_on: i.spent_on, description: i.description, document_kind: i.document_kind, document_number: i.document_number ?? "", access_key: i.access_key ?? "",
    supplier_doc: i.supplier_doc ?? "", supplier_name: i.supplier_name ?? "", amount: String(i.amount).replace(".", ","), no_document_reason: i.no_document_reason ?? "",
    chart_account_id: i.chart_account_id, cost_center_id: i.cost_center_id,
  }));

  return (
    <>
      <PageHeader title={`Reembolso ${r.number}`} description={`${person?.display_name ?? "—"} · ${r.purpose}`}
        actions={<Link href="/financeiro/reembolsos" className="text-sm text-brand">Voltar aos reembolsos</Link>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={STATUS[r.status]?.tone ?? "neutral"}>{STATUS[r.status]?.label ?? r.status}</Badge>
        <span className="text-lg font-semibold tabular-nums">{formatBRL(Number(r.total))}</span>
        {r.due_date && <span className="text-sm text-muted">pagamento previsto {fmtDate(r.due_date)}</span>}
        {r.title_id && can(session, "fin.read") && <Link href="/financeiro/pagar" className="text-sm text-brand">ver na conta a pagar</Link>}
      </div>
      {r.status === "REJECTED" && r.reject_reason && <p className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">Recusado: {r.reject_reason}. Corrija e envie de novo.</p>}

      <div className="space-y-3">
        {(items ?? []).map((i) => (
          <Card key={i.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="text-sm">
                <p className="font-medium">{fmtDate(i.spent_on)} · {i.description} · <span className="tabular-nums">{formatBRL(Number(i.amount))}</span></p>
                <p className="text-muted">{[i.supplier_name, fmtDoc(i.supplier_doc)].filter(Boolean).join(" · ") || "fornecedor não informado"} · {DOC_KIND[i.document_kind]}{i.document_number ? ` nº ${i.document_number}` : ""}</p>
                {i.access_key && <p className="font-mono text-[11px] text-muted">chave {i.access_key}</p>}
                {i.chart_account_id && <p className="text-xs text-muted">categoria: {accLabel.get(i.chart_account_id) ?? "definida"}</p>}
                {i.no_document_reason && <p className="text-xs text-warning">Sem comprovante: {i.no_document_reason}</p>}
              </div>
              <div className="text-sm">
                {i.attachment_path ? (
                  urlOf.get(i.attachment_path) ? <a href={urlOf.get(i.attachment_path) ?? undefined} target="_blank" rel="noreferrer" className="text-brand">Ver comprovante ({i.attachment_name})</a> : <span className="text-muted">{i.attachment_name}</span>
                ) : <Badge tone={i.no_document_reason ? "neutral" : "warning"}>sem comprovante</Badge>}
              </div>
            </div>
            {editable && (
              <form action={uploadAttachmentAction} className="mt-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="reimbursement_id" value={r.id} /><input type="hidden" name="item_id" value={i.id} />
                <input type="file" name="file" accept="image/*,application/pdf" capture="environment" aria-label={`Comprovante da despesa ${i.position}`} className="text-xs" />
                <Button variant="secondary" className="px-2 py-1 text-xs">{i.attachment_path ? "Trocar comprovante" : "Anexar comprovante"}</Button>
              </form>
            )}
            {approver && (
              <form action={classifyItemAction} className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <input type="hidden" name="reimbursement_id" value={r.id} /><input type="hidden" name="item_id" value={i.id} />
                <select name="account" defaultValue={i.chart_account_id ?? ""} aria-label={`Categoria da despesa ${i.position}`} className={`${inputClass} py-1 text-xs`}><option value="">— categoria (sem: a classificar) —</option>{(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select>
                <select name="cost_center" defaultValue={i.cost_center_id ?? ""} aria-label={`Centro de custo da despesa ${i.position}`} className={`${inputClass} py-1 text-xs`}><option value="">— centro de custo —</option>{(ccs ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select>
                <Button variant="ghost" className="px-2 py-1 text-xs">Classificar</Button>
              </form>
            )}
          </Card>
        ))}
      </div>

      {editable && (
        <div className="mt-4 flex flex-wrap gap-2">
          <form action={submitReimbursementAction}><input type="hidden" name="id" value={r.id} /><Button>Enviar para aprovação</Button></form>
          <form action={cancelReimbursementAction}><input type="hidden" name="id" value={r.id} /><Button variant="ghost">Cancelar reembolso</Button></form>
        </div>
      )}

      {approver && (
        <Card className="mt-4" title="Decisão">
          {mine && !session.isSuperuser ? <p className="text-sm text-muted">Quem pediu não aprova o próprio reembolso.</p> : (
            <div className="grid gap-4 lg:grid-cols-2">
              <form action={decideReimbursementAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="id" value={r.id} /><input type="hidden" name="decision" value="approve" />
                <Field label="Pagar até"><input type="date" name="due_date" min={today} className={inputClass} /></Field>
                <Button>Aprovar e gerar conta a pagar</Button>
              </form>
              <form action={decideReimbursementAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="id" value={r.id} /><input type="hidden" name="decision" value="reject" />
                <Field label="Motivo da recusa"><input name="reason" required minLength={5} className={`${inputClass} w-64`} /></Field>
                <Button variant="danger">Recusar</Button>
              </form>
            </div>
          )}
        </Card>
      )}

      {editable && (
        <Card className="mt-6" title="Editar despesas">
          <ReimbursementForm id={r.id} purpose={r.purpose} items={drafts} today={today} />
        </Card>
      )}
    </>
  );
}
