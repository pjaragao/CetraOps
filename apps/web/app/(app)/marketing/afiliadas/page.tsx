import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Stat, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { approveStatementAction, ensureAffiliateLinksAction, generateStatementsAction, saveAffiliateAction, setAffiliateStatusAction } from "./actions";

export const metadata = { title: "Afiliados" };

const STATUS: Record<string, { label: string; tone: "success" | "warning" | "neutral" }> = { ACTIVE: { label: "ativa", tone: "success" }, PAUSED: { label: "pausada", tone: "warning" }, ENDED: { label: "encerrada", tone: "neutral" } };
const MODE: Record<string, string> = { STORE_CREDIT: "Vale-troca", PIX: "Pix" };
const monthLabel = (ym: string) => new Date(`${ym}-15T12:00:00-03:00`).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", month: "long", year: "numeric" });
const shiftMonth = (ym: string, d: number) => { const [y, m] = ym.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1 + d, 1)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`; };

export default async function AfiliadosPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const canWrite = can(session, "crm.write"), canFin = can(session, "fin.read"), canApprove = can(session, "fin.approve"), canGenerate = can(session, "fin.write");
  const mes = /^\d{4}-\d{2}$/.test(str(sp.mes) ?? "") ? str(sp.mes)! : todayIsoSP().slice(0, 7);
  const supabase = await createClient();
  const aff = supabase.schema("aff");
  const [{ data: affiliates }, statements] = await Promise.all([
    aff.from("affiliates").select("id, party_id, student_discount_pct, commission_pct, payout_mode, status, notes, coupon_id").order("created_at"),
    canFin ? aff.from("statements").select("id, affiliate_id, orders_count, sales_amount, returns_amount, commission_pct, commission, payout_mode, status, payable_title_ids").eq("competence", `${mes}-01`) : Promise.resolve({ data: [] }),
  ]);
  const partyIds = (affiliates ?? []).map((a) => a.party_id);
  const [{ data: people }, { data: coupons }, { data: links }] = await Promise.all([
    partyIds.length ? supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
    (affiliates ?? []).length ? supabase.schema("sales").from("coupons").select("id, code").in("id", (affiliates ?? []).map((a) => a.coupon_id)) : Promise.resolve({ data: [] as { id: string; code: string }[] }),
    partyIds.length ? supabase.schema("mkt").from("tracking_links").select("id, code, affiliate_party_id").in("affiliate_party_id", partyIds).eq("kind", "TRAINER").is("campaign_id", null) : Promise.resolve({ data: [] }),
  ]);
  const nameOf = new Map((people ?? []).map((x) => [x.id, x.display_name]));
  const codeOf = new Map((coupons ?? []).map((x) => [x.id, x.code]));
  const linkOf = new Map((links ?? []).map((l) => [l.affiliate_party_id, l]));
  const editing = (affiliates ?? []).find((a) => a.id === str(sp.editar));
  const stmts = statements.data ?? [];
  const titleIds = stmts.flatMap((s) => s.payable_title_ids ?? []);
  const { data: titles } = titleIds.length ? await supabase.schema("fin").from("titles").select("id, number, status").in("id", titleIds) : { data: [] };
  const titleById = new Map((titles ?? []).map((t) => [t.id, t]));
  const byAff = new Map(stmts.map((s) => [s.affiliate_id, s]));
  const pending = stmts.filter((s) => s.status === "DRAFT").reduce((a, s) => a + Number(s.commission), 0);
  const total = stmts.reduce((a, s) => a + Number(s.commission), 0);
  const sales = stmts.reduce((a, s) => a + Number(s.sales_amount) - Number(s.returns_amount), 0);

  return (
    <>
      <PageHeader title="Afiliados (trainers parceiros)" description="Cada trainer tem um cupom com desconto para a aluna e ganha comissão sobre as vendas feitas com ele, paga em vale-troca ou por Pix."
        actions={canWrite && (affiliates ?? []).some((a) => a.status === "ACTIVE" && !linkOf.get(a.party_id)) ? <form action={ensureAffiliateLinksAction}><Button variant="secondary">Criar links/QR que faltam</Button></form> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <p className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">Atenção: confira no contrato com a academia parceira se a loja pode dirigir funcionários dela. Confirme com o jurídico antes de cadastrar trainers que trabalham na academia.</p>

      {canFin && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Stat label={`Vendas com cupom · ${monthLabel(mes)}`} value={formatBRL(sales)} hint="Itens menos desconto e devoluções" />
          <Stat label="Comissão do mês" value={formatBRL(total)} hint={`${stmts.length} extrato(s)`} />
          <Stat label="A aprovar" value={formatBRL(pending)} tone={pending > 0 ? "warning" : undefined} hint="Extratos em rascunho" />
        </div>
      )}

      {(affiliates ?? []).length === 0 ? <Empty title="Nenhuma afiliada ainda">Cadastre a primeira trainer abaixo: o cupom e o link/QR são criados juntos.</Empty> : (
        <Table head={["Afiliada", "Cupom", "Link & QR", "Desconto", "Comissão", "Pagamento", "Situação", canFin ? `Comissão ${mes}` : "", ""]}>
          {(affiliates ?? []).map((a) => {
            const st = STATUS[a.status] ?? STATUS.ACTIVE;
            const s = byAff.get(a.id);
            const l = linkOf.get(a.party_id);
            return (
              <tr key={a.id}>
                <td className="px-3 py-2 font-medium"><Link href={`/clientes/${a.party_id}`} className="hover:underline">{nameOf.get(a.party_id)}</Link></td>
                <td className="px-3 py-2 font-mono text-xs">{codeOf.get(a.coupon_id)}</td>
                <td className="px-3 py-2 text-xs">{l ? <span className="font-mono">/r/{l.code} <a className="ml-1 text-brand hover:underline" href={`/marketing/links/${l.id}/qr`} target="_blank" rel="noreferrer">QR</a></span> : <span className="text-muted">—</span>}</td>
                <td className="px-3 py-2 tabular-nums">{Number(a.student_discount_pct)}%</td>
                <td className="px-3 py-2 tabular-nums">{Number(a.commission_pct)}%</td>
                <td className="px-3 py-2 text-xs">{MODE[a.payout_mode]}</td>
                <td className="px-3 py-2"><Badge tone={st.tone}>{st.label}</Badge></td>
                {canFin && <td className="px-3 py-2 tabular-nums">{s ? formatBRL(Number(s.commission)) : "—"}</td>}
                <td className="px-3 py-2">
                  {canWrite && (
                    <div className="flex flex-wrap gap-1">
                      <Link className="rounded-lg px-2 py-1 text-xs hover:bg-surface-2" href={`/marketing/afiliadas?editar=${a.id}`}>Editar</Link>
                      <form action={setAffiliateStatusAction}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="status" value={a.status === "ACTIVE" ? "PAUSED" : "ACTIVE"} /><Button variant="ghost" className="px-2 py-1 text-xs">{a.status === "ACTIVE" ? "Pausar" : "Reativar"}</Button></form>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}

      {canWrite && (
        <Card className="mt-4" title={editing ? `Editar ${nameOf.get(editing.party_id)}` : "Nova afiliada"}>
          <form key={editing?.id ?? "nova"} action={saveAffiliateAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
            {editing ? <><input type="hidden" name="id" value={editing.id} /><input type="hidden" name="party_id" value={editing.party_id} /></> : (
              <Field label="Pessoa" hint="Nome ou telefone (precisa estar em Clientes)" className="lg:col-span-2"><input name="party" required minLength={2} className={inputClass} placeholder="Ana Souza" /></Field>
            )}
            <Field label="Cupom" hint="Letras e números, sem espaço"><input name="coupon_code" required maxLength={20} defaultValue={editing ? codeOf.get(editing.coupon_id) : undefined} className={`${inputClass} uppercase`} placeholder="ANA10" spellCheck={false} /></Field>
            <Field label="Desconto da aluna (%)"><input name="discount" inputMode="decimal" defaultValue={editing ? String(Number(editing.student_discount_pct)) : "10"} className={inputClass} /></Field>
            <Field label="Comissão (%)"><input name="commission" inputMode="decimal" defaultValue={editing ? String(Number(editing.commission_pct)) : "8"} className={inputClass} /></Field>
            <Field label="Pagamento"><select name="payout_mode" defaultValue={editing?.payout_mode ?? "STORE_CREDIT"} className={inputClass}><option value="STORE_CREDIT">Vale-troca</option><option value="PIX">Pix</option></select></Field>
            <Field label="Observações" className="sm:col-span-2 lg:col-span-5"><input name="notes" defaultValue={editing?.notes ?? ""} maxLength={300} className={inputClass} /></Field>
            <div className="flex gap-2"><Button>{editing ? "Salvar" : "Cadastrar"}</Button>{editing && <Link href="/marketing/afiliadas" className="self-center text-xs text-brand">Cancelar</Link>}</div>
          </form>
        </Card>
      )}

      {canFin && (
        <Card className="mt-4" title={`Extratos de comissão · ${monthLabel(mes)}`} action={
          <span className="flex items-center gap-1 text-sm">
            <Link className="rounded-lg px-2 py-1 hover:bg-surface-2" href={`/marketing/afiliadas?mes=${shiftMonth(mes, -1)}`} aria-label="Mês anterior">←</Link>
            <Link className="rounded-lg px-2 py-1 hover:bg-surface-2" href={`/marketing/afiliadas?mes=${shiftMonth(mes, 1)}`} aria-label="Próximo mês">→</Link>
            {canGenerate && <form action={generateStatementsAction}><input type="hidden" name="mes" value={mes} /><Button variant="secondary" className="px-2 py-1 text-xs">Calcular extratos do mês</Button></form>}
          </span>}>
          {stmts.length === 0 ? <Empty title="Nenhum extrato neste mês">Use “Calcular extratos do mês” para somar as vendas feitas com os cupons.</Empty> : (
            <Table head={["Afiliada", "Pedidos", "Vendas", "Devoluções", "Comissão", "Situação", ""]}>
              {stmts.map((s) => {
                const a = (affiliates ?? []).find((x) => x.id === s.affiliate_id);
                const tts = (s.payable_title_ids ?? []).map((id) => titleById.get(id)).filter(Boolean);
                const paid = s.status === "PAID" || (tts.length > 0 && tts.every((t) => t?.status === "SETTLED"));
                return (
                  <tr key={s.id}>
                    <td className="px-3 py-2 font-medium">{a ? nameOf.get(a.party_id) : ""}</td>
                    <td className="px-3 py-2 tabular-nums">{s.orders_count}</td>
                    <td className="px-3 py-2 tabular-nums">{formatBRL(Number(s.sales_amount))}</td>
                    <td className="px-3 py-2 tabular-nums">{Number(s.returns_amount) > 0 ? formatBRL(Number(s.returns_amount)) : "—"}</td>
                    <td className="px-3 py-2 tabular-nums font-medium">{formatBRL(Number(s.commission))} <span className="text-[11px] font-normal text-muted">({Number(s.commission_pct)}%)</span></td>
                    <td className="px-3 py-2">
                      {paid ? <Badge tone="success">pago{s.payout_mode === "STORE_CREDIT" ? " em vale" : ""}</Badge> : s.status === "APPROVED" ? <Badge tone="warning">aprovado, a pagar{tts[0] ? ` (${tts[0].number})` : ""}</Badge> : <Badge>rascunho</Badge>}
                    </td>
                    <td className="px-3 py-2">
                      {s.status === "DRAFT" && canApprove && Number(s.commission) > 0 && (
                        <form action={approveStatementAction}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="mes" value={mes} /><Button variant="secondary" className="px-2 py-1 text-xs">Aprovar</Button></form>
                      )}
                      {s.status === "APPROVED" && tts[0] && <Link className="text-xs text-brand" href="/financeiro/pagar">Abrir no Financeiro</Link>}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
