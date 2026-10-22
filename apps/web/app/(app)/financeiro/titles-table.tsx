"use client";
import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { Badge, Button, Table } from "@/components/ui";
import { approveManyTitlesAction, approveTitle, cancelTitle } from "./actions";

export interface TitleRow {
  installment_id: string; title_id: string; title_number: string; description: string; party_name: string | null; receiver_name?: string | null;
  n: number; due_date: string; balance: number; amount: number; fee_expected: number; approval_status: string; days_overdue: number;
  status: string; settled_on?: string | null; origin_type?: string | null;
}

const STATUS: Record<string, [string, "success" | "neutral" | "warning"]> = { SETTLED: ["quitada", "success"], CANCELLED: ["cancelada", "neutral"], PARTIAL: ["parcial", "warning"] };

/** Lista de parcelas com seleção múltipla: várias contas num único pagamento/recebimento, ou aprovar vários rascunhos de uma vez. */
export function TitlesTable({ direction, rows, canWrite, canApprove, back, paged }: {
  direction: "PAYABLE" | "RECEIVABLE"; rows: TitleRow[]; canWrite: boolean; canApprove: boolean; back: string; paged?: boolean;
}) {
  const isOpen = (r: TitleRow) => r.status === "OPEN" || r.status === "PARTIAL";
  const payable = (r: TitleRow) => canWrite && isOpen(r) && (direction === "RECEIVABLE" || r.approval_status === "APPROVED");
  const approvable = (r: TitleRow) => direction === "PAYABLE" && canApprove && isOpen(r) && r.approval_status === "DRAFT";
  const tags = (r: TitleRow) => [payable(r) && "baixar", approvable(r) && "aprovar"].filter(Boolean).join(" ");

  return (
    <Table
      head={["Vencimento", "Título", "Descrição", "Parcela", "Valor / saldo", direction === "RECEIVABLE" ? "Taxa esperada" : "Situação", ""]}
      totals={direction === "RECEIVABLE" ? [5] : undefined}
      totalLabel={paged ? "Total da página" : undefined}
      bulk={[
        { label: direction === "PAYABLE" ? "Pagar em um movimento" : "Receber em um movimento", tag: "baixar", tone: "primary", href: `/financeiro/baixar?dir=${direction}&ids={ids}` },
        { label: "Aprovar", tag: "aprovar", action: approveManyTitlesAction, hidden: { back } },
      ]}>
      {rows.map((r) => (
        <tr key={r.installment_id} data-select={tags(r) ? r.installment_id : undefined} data-tags={tags(r)}>
          <td className={`px-3 py-2 whitespace-nowrap ${isOpen(r) && r.days_overdue > 0 ? "font-medium text-danger" : ""}`}>
            {r.due_date.split("-").reverse().join("/")}{isOpen(r) && r.days_overdue > 0 && <span className="ml-1 text-xs">({r.days_overdue}d)</span>}
          </td>
          <td className="px-3 py-2 text-xs"><Link href={`/financeiro/titulos/${r.title_id}`} className="text-brand hover:underline">{r.title_number}</Link></td>
          <td className="px-3 py-2">{r.description}{r.party_name && <span className="block text-xs text-muted">{r.party_name}{r.receiver_name ? ` · recebe: ${r.receiver_name}` : ""}</span>}</td>
          <td className="px-3 py-2">{r.n}</td>
          <td className="px-3 py-2 font-medium whitespace-nowrap">
            {formatBRL(isOpen(r) ? r.balance : r.amount)}{r.status === "PARTIAL" && <span className="block text-xs font-normal text-muted">de {formatBRL(r.amount)}</span>}
          </td>
          <td className="px-3 py-2">
            {!isOpen(r) ? <Badge tone={STATUS[r.status]?.[1] ?? "neutral"}>{STATUS[r.status]?.[0] ?? r.status}{r.settled_on ? ` em ${r.settled_on.split("-").reverse().join("/")}` : ""}</Badge>
              : direction === "RECEIVABLE" ? formatBRL(r.fee_expected)
              : <Badge tone={r.approval_status === "APPROVED" ? "success" : "warning"}>{r.approval_status === "APPROVED" ? "aprovado" : "rascunho"}</Badge>}
          </td>
          <td className="px-3 py-2">
            <div className="flex gap-1">
              {approvable(r) && (
                <form action={approveTitle}><input type="hidden" name="title_id" value={r.title_id} /><Button variant="secondary" className="px-2 py-1 text-xs">Aprovar</Button></form>
              )}
              {payable(r) && (
                <Link className="inline-flex items-center rounded-lg border border-border bg-surface px-2 py-1 text-xs font-medium hover:bg-surface-2"
                  href={`/financeiro/baixar?dir=${direction}&ids=${r.installment_id}`}>{direction === "PAYABLE" ? "Pagar" : "Receber"}</Link>
              )}
              {canApprove && r.status === "OPEN" && (
                <form action={cancelTitle} onSubmit={(e) => { if (!confirm("Cancelar este título? A competência será estornada.")) e.preventDefault(); }}>
                  <input type="hidden" name="title_id" value={r.title_id} /><input type="hidden" name="back" value={back} />
                  <Button variant="ghost" className="px-2 py-1 text-xs text-danger">Cancelar</Button>
                </form>
              )}
            </div>
          </td>
        </tr>
      ))}
    </Table>
  );
}
