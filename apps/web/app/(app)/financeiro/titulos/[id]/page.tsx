import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, PageHeader, Table } from "@/components/ui";
import { Flash, fmtDate } from "@/components/form";
import { approveTitle, cancelTitle, rescheduleAction } from "../../actions";
import { TitleForm } from "../../title-form";

export const metadata = { title: "Título" };

const STATUS: Record<string, [string, "success" | "neutral" | "warning" | "danger"]> = {
  OPEN: ["em aberto", "warning"], PARTIAL: ["parcial", "warning"], SETTLED: ["quitado", "success"], CANCELLED: ["cancelado", "neutral"], RENEGOTIATED: ["renegociado", "neutral"],
};
const ORIGIN: Record<string, [string, (id: string) => string | null]> = {
  MANUAL: ["Lançamento manual", () => null], RECURRING: ["Recorrência", () => "/financeiro/recorrentes"], LOAN: ["Empréstimo", () => "/financeiro/emprestimos"],
  CONTRACT: ["Contrato", () => "/financeiro/contratos"], REIMBURSEMENT: ["Reembolso", (id) => `/financeiro/reembolsos/${id}`],
  ORDER: ["Venda", (id) => `/vender/pedidos/${id}`], PURCHASE_RECEIPT: ["Recebimento de mercadoria", (id) => `/produtos/recebimento/${id}`],
  PAYROLL: ["Folha de pagamento", () => "/equipe"], TAX_PERIOD: ["Imposto", () => "/fiscal/obrigacoes"], COMMISSION_STATEMENT: ["Comissões", () => null],
};
const KIND: Record<string, string> = { PRINCIPAL: "principal", INTEREST: "juros", FINE: "multa", CHARGE: "encargo", ADVANCE: "adiantamento", DISCOUNT: "desconto", FEE: "taxa", WITHHOLDING: "retenção", CREDIT_USE: "uso de crédito" };

export default async function TituloPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("fin.read");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: t } = await supabase.schema("fin").from("titles").select("*").eq("id", id).maybeSingle();
  if (!t) notFound();
  const [{ data: inst }, { data: lines }, { data: parties }, { data: accounts }, { data: ccs }] = await Promise.all([
    supabase.schema("fin").from("title_installments").select("id, n, due_date, amount, amount_settled, status, barcode").eq("title_id", id).order("n"),
    supabase.schema("fin").from("title_lines").select("id, chart_account_id, cost_center_id, amount, memo").eq("title_id", id),
    supabase.schema("crm").from("parties").select("id, display_name, cnpj").is("merged_into_id", null).is("archived_at", null).order("display_name").limit(5000),
    supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC").is("archived_at", null).order("code"),
    supabase.schema("core").from("cost_centers").select("id, code, name").order("code"),
  ]);
  const { data: templates } = await supabase.schema("fin").from("allocation_templates").select("id, name").eq("active", true).order("name");
  const instIds = (inst ?? []).map((i) => i.id);
  const { data: sl } = instIds.length ? await supabase.schema("fin").from("settlement_lines").select("settlement_id, installment_id, kind, amount").in("installment_id", instIds) : { data: [] as { settlement_id: string; installment_id: string | null; kind: string; amount: number }[] };
  const sids = [...new Set((sl ?? []).map((l) => l.settlement_id))];
  const { data: setts } = sids.length ? await supabase.schema("fin").from("settlements").select("id, number, settled_on, method, amount, status, bank_account_id").in("id", sids).order("settled_on") : { data: [] as { id: string; number: string; settled_on: string; method: string; amount: number; status: string; bank_account_id: string }[] };
  const bankIds = [...new Set((setts ?? []).map((s) => s.bank_account_id))];
  const { data: banks } = bankIds.length ? await supabase.schema("fin").from("bank_accounts").select("id, name").in("id", bankIds) : { data: [] as { id: string; name: string }[] };

  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const aname = new Map((accounts ?? []).map((a) => [a.id, `${a.code} · ${a.name}`]));
  const cname = new Map((ccs ?? []).map((c) => [c.id, `${c.code} · ${c.name}`]));
  const bname = new Map((banks ?? []).map((b) => [b.id, b.name]));
  const settled = (inst ?? []).some((i) => Number(i.amount_settled) > 0);
  const canWrite = can(session, "fin.write");
  const canApprove = can(session, "fin.approve");
  const manual = ["MANUAL", "RECURRING", "LOAN"].includes(t.origin_type) && t.accrual_mode === "AUTO";
  const full = !settled && manual && t.status !== "CANCELLED";
  const back = `/financeiro/titulos/${t.id}`;
  const list = t.direction === "PAYABLE" ? "/financeiro/pagar" : "/financeiro/receber";
  const origin = ORIGIN[t.origin_type] ?? [t.origin_type, () => null];
  const originHref = t.origin_id ? origin[1](t.origin_id) : origin[1]("");

  return (
    <>
      <PageHeader title={`${t.number} · ${t.description}`}
        description={`${t.direction === "PAYABLE" ? "Conta a pagar" : "Conta a receber"} · competência ${fmtDate(t.competence_date)} · lançado em ${fmtDate(t.created_at.slice(0, 10))}`}
        actions={<Link href={list} className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← {t.direction === "PAYABLE" ? "Contas a pagar" : "Contas a receber"}</Link>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={STATUS[t.status]?.[1] ?? "neutral"}>{STATUS[t.status]?.[0] ?? t.status}</Badge>
        {t.direction === "PAYABLE" && t.status !== "CANCELLED" && <Badge tone={t.approval_status === "APPROVED" ? "success" : "warning"}>{t.approval_status === "APPROVED" ? "aprovado" : "rascunho"}</Badge>}
        <span className="text-sm text-muted">Origem: {originHref ? <Link href={originHref} className="text-brand">{origin[0]}</Link> : origin[0]}</span>
        <span className="ml-auto flex gap-2">
          {t.direction === "PAYABLE" && t.approval_status === "DRAFT" && t.status !== "CANCELLED" && canApprove && (
            <form action={approveTitle}><input type="hidden" name="title_id" value={t.id} /><input type="hidden" name="back" value={back} /><Button variant="secondary">Aprovar</Button></form>
          )}
          {canApprove && !settled && t.status !== "CANCELLED" && (
            <form action={cancelTitle}><input type="hidden" name="title_id" value={t.id} /><input type="hidden" name="back" value={list} /><Button variant="ghost" className="text-danger">Cancelar título</Button></form>
          )}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Resumo">
          <ul className="space-y-1.5 text-sm">
            <li className="flex justify-between gap-2"><span className="text-muted">Valor total</span><b>{formatBRL(t.total_amount)}</b></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Já {t.direction === "PAYABLE" ? "pago" : "recebido"}</span><span>{formatBRL((inst ?? []).reduce((a, i) => a + Number(i.amount_settled), 0))}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">{t.direction === "PAYABLE" ? "Fornecedor" : "Cliente"}</span><span>{t.party_id ? <Link href={`/cadastros/${t.party_id}`} className="text-brand">{pname.get(t.party_id) ?? "—"}</Link> : "—"}</span></li>
            {t.receiver_party_id && <li className="flex justify-between gap-2"><span className="text-muted">Recebedor</span><span>{pname.get(t.receiver_party_id) ?? "—"}</span></li>}
            <li className="flex justify-between gap-2"><span className="text-muted">Documento</span><span>{[t.document_kind, t.document_number].filter(Boolean).join(" ") || "—"}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Contabilização</span><span>{t.accrual_entry_id ? <Link href="/financeiro/razao" className="text-brand">no razão</Link> : t.accrual_mode === "EXTERNAL" ? "pela origem" : "ao aprovar"}</span></li>
          </ul>
        </Card>
        <Card title="Classificação" className="lg:col-span-2">
          {(lines ?? []).length === 0 ? <p className="text-sm text-muted">{t.chart_account_id ? aname.get(t.chart_account_id) : "Sem classificação (vai para “a classificar”)."}</p> : (
            <ul className="space-y-1 text-sm">{(lines ?? []).map((l) => (
              <li key={l.id} className="flex justify-between gap-2"><span>{aname.get(l.chart_account_id) ?? "conta"}{l.cost_center_id && <span className="text-muted"> · {cname.get(l.cost_center_id)}</span>}{l.memo && <span className="text-xs text-muted"> ({l.memo})</span>}</span><span>{formatBRL(l.amount)}</span></li>
            ))}</ul>
          )}
        </Card>
      </div>

      <h2 className="mt-6 mb-2 text-sm font-semibold">Parcelas</h2>
      <Table head={["#", "Vencimento", "Valor", t.direction === "PAYABLE" ? "Pago" : "Recebido", "Situação", canWrite ? "Mudar vencimento" : ""]}>
        {(inst ?? []).map((i) => (
          <tr key={i.id}>
            <td className="px-3 py-2">{i.n}</td>
            <td className="px-3 py-2 whitespace-nowrap">{fmtDate(i.due_date)}</td>
            <td className="px-3 py-2">{formatBRL(i.amount)}{i.barcode && <span className="block max-w-[16rem] truncate font-mono text-[11px] text-muted" title={i.barcode}>{i.barcode}</span>}</td>
            <td className="px-3 py-2">{formatBRL(i.amount_settled)}</td>
            <td className="px-3 py-2"><Badge tone={STATUS[i.status]?.[1] ?? "neutral"}>{STATUS[i.status]?.[0] ?? i.status}</Badge></td>
            <td className="px-3 py-2">
              {canWrite && (i.status === "OPEN" || i.status === "PARTIAL") && (
                <form action={rescheduleAction} className="flex items-center gap-1">
                  <input type="hidden" name="title_id" value={t.id} /><input type="hidden" name="installment_id" value={i.id} />
                  <input type="date" name="due_date" defaultValue={i.due_date} required className={`${inputClass} w-36 py-1`} aria-label="Novo vencimento" />
                  <Button variant="ghost" className="px-2 py-1 text-xs">Salvar</Button>
                </form>
              )}
            </td>
          </tr>
        ))}
      </Table>

      {(setts ?? []).length > 0 && (
        <>
          <h2 className="mt-6 mb-2 text-sm font-semibold">{t.direction === "PAYABLE" ? "Pagamentos" : "Recebimentos"}</h2>
          <Table head={["Data", "Baixa", "Conta", "Forma", "Composição", "Situação"]}>
            {(setts ?? []).map((s) => (
              <tr key={s.id} className={s.status === "REVERSED" ? "text-muted line-through" : ""}>
                <td className="px-3 py-2">{fmtDate(s.settled_on)}</td><td className="px-3 py-2 text-xs">{s.number}</td><td className="px-3 py-2">{bname.get(s.bank_account_id)}</td>
                <td className="px-3 py-2 text-xs">{s.method}</td>
                <td className="px-3 py-2 text-xs">{(sl ?? []).filter((l) => l.settlement_id === s.id).map((l) => `${KIND[l.kind] ?? l.kind} ${formatBRL(l.amount)}`).join(" · ")}</td>
                <td className="px-3 py-2">{s.status === "REVERSED" ? <Badge>estornada</Badge> : <Badge tone="success">lançada</Badge>}</td>
              </tr>
            ))}
          </Table>
          <p className="mt-1 text-xs text-muted">Para desfazer um pagamento, estorne a baixa em Financeiro › Movimentações.</p>
        </>
      )}

      {canWrite && t.status !== "CANCELLED" && (
        <Card className="mt-6" title="Editar lançamento">
          {/* o mesmo formulário do "Novo lançamento"; o que não pode mais mudar aparece travado, com o motivo */}
          <TitleForm direction={t.direction as "PAYABLE" | "RECEIVABLE"} today={todayIsoSP()}
            lock={full ? null : settled
              ? "Este título já tem pagamento/baixa: aqui só mudam a descrição e o documento (o vencimento das parcelas em aberto muda na tabela de parcelas). Para mudar valores, favorecido ou classificação, estorne a baixa em Movimentações."
              : `Gerado por ${origin[0].toLowerCase()}: valores e classificação se corrigem pela origem. Aqui mudam a descrição, o documento e o vencimento (na tabela de parcelas).`}
            edit={{ id: t.id, store_id: t.store_id, party_id: t.party_id, receiver_party_id: t.receiver_party_id, description: t.description,
                    document_kind: t.document_kind, document_number: t.document_number, competence_date: t.competence_date,
                    chart_account_id: t.chart_account_id, cost_center_id: t.cost_center_id,
                    lines: (lines ?? []).map((l) => ({ chart_account_id: l.chart_account_id, cost_center_id: l.cost_center_id, amount: Number(l.amount) })),
                    installments: (inst ?? []).map((i) => ({ due_date: i.due_date, amount: Number(i.amount), barcode: i.barcode })) }}
            stores={session.stores.map((s) => ({ id: s.id, name: s.name, legal_entity_id: s.legal_entity_id }))}
            parties={(parties ?? []).map((p) => ({ id: p.id, label: p.display_name, hint: p.cnpj ? `CNPJ ${p.cnpj}` : undefined }))}
            accounts={(accounts ?? []).map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))}
            costCenters={(ccs ?? []).map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))}
            templates={(templates ?? []).map((x) => ({ id: x.id, label: x.name }))} />
          {full && <p className="mt-2 text-xs text-muted">Sem pagamento ainda: dá para mudar tudo. Se o título já estava aprovado, a contabilização é refeita com os dados novos.</p>}
        </Card>
      )}
    </>
  );
}
