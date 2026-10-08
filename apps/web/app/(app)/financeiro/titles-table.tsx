"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { formatBRL } from "@centralops/domain";
import { Badge, Button } from "@/components/ui";
import { approveTitle, cancelTitle } from "./actions";

export interface TitleRow {
  installment_id: string; title_id: string; title_number: string; description: string; party_name: string | null; receiver_name?: string | null;
  n: number; due_date: string; balance: number; amount: number; fee_expected: number; approval_status: string; days_overdue: number;
  status: string; settled_on?: string | null; origin_type?: string | null;
}

const STATUS: Record<string, [string, "success" | "neutral" | "warning"]> = { SETTLED: ["quitada", "success"], CANCELLED: ["cancelada", "neutral"], PARTIAL: ["parcial", "warning"] };

/** Lista de parcelas em aberto com seleção múltipla: várias contas, um único pagamento/recebimento. */
export function TitlesTable({ direction, rows, canWrite, canApprove, back }: {
  direction: "PAYABLE" | "RECEIVABLE"; rows: TitleRow[]; canWrite: boolean; canApprove: boolean; back: string;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const isOpen = (r: TitleRow) => r.status === "OPEN" || r.status === "PARTIAL";
  const selectable = (r: TitleRow) => canWrite && isOpen(r) && (direction === "RECEIVABLE" || r.approval_status === "APPROVED");
  const total = useMemo(() => rows.filter((r) => sel.has(r.installment_id)).reduce((a, r) => a + r.balance, 0), [rows, sel]);
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allIds = rows.filter(selectable).map((r) => r.installment_id);

  return (
    <div>
      {canWrite && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-sm">
          <span className="text-muted">{sel.size === 0 ? "Marque as parcelas para pagar/receber em um único movimento" : `${sel.size} selecionada(s) · ${formatBRL(total)}`}</span>
          <div className="ml-auto flex gap-2">
            {sel.size > 0 && <Button variant="ghost" onClick={() => setSel(new Set())}>Limpar</Button>}
            <Link
              aria-disabled={sel.size === 0}
              href={sel.size === 0 ? "#" : `/financeiro/baixar?dir=${direction}&ids=${[...sel].join(",")}`}
              className={`inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium ${sel.size === 0 ? "pointer-events-none bg-surface-2 text-muted" : "bg-brand text-brand-contrast hover:opacity-90"}`}
            >
              {direction === "PAYABLE" ? "Pagar selecionadas" : "Receber selecionadas"}
            </Link>
          </div>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className="w-8 px-3 py-2">
                {canWrite && (
                  <input type="checkbox" aria-label="Selecionar todas" checked={allIds.length > 0 && allIds.every((i) => sel.has(i))}
                    onChange={(e) => setSel(e.target.checked ? new Set(allIds) : new Set())} />
                )}
              </th>
              {["Vencimento", "Título", "Descrição", "Parcela", "Valor / saldo", direction === "RECEIVABLE" ? "Taxa esperada" : "Situação", ""].map((h, i) => <th key={i} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.installment_id} className={sel.has(r.installment_id) ? "bg-brand/5" : ""}>
                <td className="px-3 py-2">{selectable(r) && <input type="checkbox" aria-label={`Selecionar ${r.title_number}`} checked={sel.has(r.installment_id)} onChange={() => toggle(r.installment_id)} />}</td>
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
                    {direction === "PAYABLE" && isOpen(r) && r.approval_status === "DRAFT" && canApprove && (
                      <form action={approveTitle}><input type="hidden" name="title_id" value={r.title_id} /><Button variant="secondary" className="px-2 py-1 text-xs">Aprovar</Button></form>
                    )}
                    {selectable(r) && (
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
          </tbody>
        </table>
      </div>
    </div>
  );
}
