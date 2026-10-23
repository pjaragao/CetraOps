"use client";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { formatBRL } from "@centralops/domain";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, cn, inputClass } from "@/components/ui";
import type { DfeTriage } from "@/lib/nfe-view";
import { applyDfeDestinationAction } from "../../actions";

type Dest = "REIMBURSED" | "PAYABLE" | "PAID" | "ASSET" | "EXPENSE" | "IGNORED";
interface Opt { id: string; label: string }
const toNum = (s: string) => Number(String(s).replace(/\./g, "").replace(",", ".")) || 0;
const toStr = (n: number) => n.toFixed(2).replace(".", ",");

const CHOICES: { v: Dest; label: string; hint: string }[] = [
  { v: "REIMBURSED", label: "Já foi paga (reembolso)", hint: "Alguém pagou do bolso e pediu reembolso: a nota vira o comprovante, sem conta nova." },
  { v: "PAYABLE", label: "Já tem conta a pagar", hint: "A compra já foi lançada em Contas a pagar (aberta ou paga): a nota vira o documento dela, sem conta nova." },
  { v: "PAID", label: "Já saiu do banco", hint: "O pagamento está no extrato ou em Movimentações: a nota fica ligada a ele (a saída pendente do extrato é conciliada aqui)." },
  { v: "ASSET", label: "Patrimônio", hint: "Bem durável da loja (cabides, araras, manequins, móveis, equipamentos): conta a pagar em rascunho, classificada no ativo." },
  { v: "EXPENSE", label: "Despesa ou consumo", hint: "Embalagens, material de escritório, limpeza, serviços: conta a pagar em rascunho, classificada." },
  { v: "IGNORED", label: "Não gera lançamento", hint: "Nota que não é da empresa ou já tratada por fora (diga o motivo)." },
];

/** Decisão do destino da nota recebida: vem pré-preenchida com a sugestão da IA; quem confirma é a pessoa. */
export function DestinationForm({ id, accessKey, total, triage, assetAccounts, expenseAccounts, reimbursements, hasInstallments, today }: {
  id: string; accessKey: string; total: number; triage: DfeTriage | null; assetAccounts: Opt[]; expenseAccounts: Opt[];
  reimbursements: { id: string; number: string; purpose: string; status: string; total: number; suggested: boolean }[]; hasInstallments: boolean; today: string;
}) {
  const payables = triage?.contas ?? [];
  const payments = [
    ...(triage?.extrato ?? []).map((x) => ({ key: `s:${x.id}`, kind: "extrato" as const, id: x.id, date: x.posted_on, amount: Math.abs(x.amount), text: x.descricao, where: x.banco, conta: "" })),
    ...(triage?.movimentos ?? []).map((x) => ({ key: `m:${x.id}`, kind: "movimento" as const, id: x.id, date: x.occurred_on, amount: Math.abs(x.amount), text: x.descricao, where: x.banco, conta: x.conta })),
  ];
  const link = triage?.vinculo ?? null;
  const { state, pending, formProps } = useKeptForm(applyDfeDestinationAction);
  const suggested = triage?.destino && ["REIMBURSED", "PAYABLE", "PAID", "ASSET", "EXPENSE"].includes(triage.destino) ? (triage.destino as Dest) : null;
  const [dest, setDest] = useState<Dest | null>(suggested);
  const lines0 = triage?.linhas?.length ? triage.linhas.map((l) => ({ account: l.chart_account_id, amount: toStr(l.amount) })) : [{ account: "", amount: toStr(total) }];
  const [lines, setLines] = useState(lines0);
  const [picked, setPicked] = useState<Set<string>>(new Set(reimbursements.filter((r) => r.suggested).map((r) => r.id)));
  const [due, setDue] = useState(today);
  const [titleId, setTitleId] = useState(link?.title_id ?? payables[0]?.id ?? "");
  const [payment, setPayment] = useState(link?.statement_line_id ? `s:${link.statement_line_id}` : link?.cash_transaction_id ? `m:${link.cash_transaction_id}` : payments[0]?.key ?? "");
  const [note, setNote] = useState("");
  const options = dest === "EXPENSE" ? expenseAccounts : dest === "ASSET" ? assetAccounts : [...assetAccounts, ...expenseAccounts];
  const sum = lines.reduce((a, l) => a + toNum(l.amount), 0);
  const sumOk = Math.abs(sum - total) < 0.005;
  const payload = {
    id, key: accessKey, destination: dest, note: note || undefined, due_date: due || undefined,
    lines: lines.filter((l) => l.account && toNum(l.amount) > 0).map((l) => ({ chart_account_id: l.account, amount: toNum(l.amount) })),
    reimbursement_ids: dest === "REIMBURSED" ? [...picked] : undefined,
    title_id: dest === "PAYABLE" ? titleId : undefined,
    statement_line_id: dest === "PAID" && payment.startsWith("s:") ? payment.slice(2) : undefined,
    cash_transaction_id: dest === "PAID" && payment.startsWith("m:") ? payment.slice(2) : undefined,
  };
  const fromStatement = dest === "PAID" && payment.startsWith("s:");
  const ok = !!dest && (dest === "IGNORED" ? note.trim().length >= 5
    : dest === "REIMBURSED" ? picked.size > 0
    : dest === "PAYABLE" ? !!titleId
    : dest === "PAID" ? !!payment && (!fromStatement || (lines.length === 1 && !!lines[0].account))
    : sumOk && lines.every((l) => l.account && toNum(l.amount) > 0));

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      <div className="grid gap-2 sm:grid-cols-2">
        {CHOICES.filter((c) => (c.v !== "PAYABLE" || payables.length > 0) && (c.v !== "PAID" || payments.length > 0)).map((c) => (
          <label key={c.v} className={cn("cursor-pointer rounded-xl border p-3 text-sm", dest === c.v ? "border-brand bg-brand/5" : "border-border hover:bg-surface-2")}>
            <span className="flex items-center gap-2 font-medium">
              <input type="radio" name="destino" checked={dest === c.v} onChange={() => setDest(c.v)} />{c.label}
              {suggested === c.v && <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">sugestão da IA</span>}
            </span>
            <span className="mt-1 block text-xs text-muted">{c.hint}</span>
          </label>
        ))}
      </div>

      {dest === "REIMBURSED" && (
        <fieldset className="rounded-xl border border-border p-3">
          <legend className="px-1 text-xs font-medium text-muted">Reembolsos que pagaram esta nota</legend>
          {reimbursements.length === 0 ? <p className="text-sm text-muted">Nenhum reembolso deste fornecedor nos últimos 6 meses.</p> : (
            <ul className="space-y-1.5 text-sm">{reimbursements.map((r) => (
              <li key={r.id}>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={picked.has(r.id)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} />
                  <a href={`/financeiro/reembolsos/${r.id}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-brand">{r.number}</a> {r.purpose}
                  <span className="ml-auto tabular-nums">{formatBRL(r.total)}</span>
                </label>
              </li>
            ))}</ul>
          )}
          {picked.size > 0 && (() => {
            const s = reimbursements.filter((r) => picked.has(r.id)).reduce((a, r) => a + r.total, 0);
            return Math.abs(s - total) >= 0.01 ? <p className="mt-2 text-xs text-warning">Os reembolsos marcados somam {formatBRL(s)} e a nota {formatBRL(total)}: confira se falta outra nota ou se o recibo inclui mais coisa.</p> : null;
          })()}
          <label className="mt-3 block text-xs text-muted">Classificar os itens do reembolso ainda sem conta em
            <select className={inputClass} value={lines[0]?.account ?? ""} onChange={(e) => setLines([{ account: e.target.value, amount: toStr(total) }])}>
              <option value="">— manter como está —</option>{options.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </label>
        </fieldset>
      )}

      {dest === "PAYABLE" && (
        <fieldset className="rounded-xl border border-border p-3">
          <legend className="px-1 text-xs font-medium text-muted">Conta a pagar desta compra</legend>
          <ul className="space-y-1.5 text-sm">{payables.map((t) => (
            <li key={t.id}><label className="flex items-center gap-2">
              <input type="radio" name="titulo" checked={titleId === t.id} onChange={() => setTitleId(t.id)} />
              <a href={`/financeiro/titulos/${t.id}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-brand">{t.number}</a> {t.description}
              <span className="ml-auto whitespace-nowrap tabular-nums">{formatBRL(t.total)}{t.pago >= t.total - 0.005 ? " · paga" : t.pago > 0 ? ` · pago ${formatBRL(t.pago)}` : ""}</span>
            </label></li>
          ))}</ul>
          {(() => { const t = payables.find((x) => x.id === titleId); return t && Math.abs(t.total - total) >= 0.01 ? <p className="mt-2 text-xs text-warning">A conta é de {formatBRL(t.total)} e a nota de {formatBRL(total)}: confira se é mesmo a mesma compra.</p> : null; })()}
        </fieldset>
      )}

      {dest === "PAID" && (
        <fieldset className="rounded-xl border border-border p-3">
          <legend className="px-1 text-xs font-medium text-muted">Pagamento que quitou esta nota</legend>
          <ul className="space-y-1.5 text-sm">{payments.map((x) => (
            <li key={x.key}><label className="flex items-center gap-2">
              <input type="radio" name="pagamento" checked={payment === x.key} onChange={() => setPayment(x.key)} />
              <span className="text-xs text-muted">{x.date.split("-").reverse().join("/")} · {x.where} · {x.kind === "extrato" ? "extrato, não conciliado" : "movimento lançado"}</span> {x.text}
              <span className="ml-auto whitespace-nowrap tabular-nums">{formatBRL(x.amount)}</span>
            </label>{x.conta && <span className="ml-6 block text-[11px] text-muted">classificado em {x.conta}</span>}</li>
          ))}</ul>
          {fromStatement ? (
            <label className="mt-3 block text-xs text-muted">Conciliar a saída do extrato classificando em
              <select className={inputClass} value={lines[0]?.account ?? ""} onChange={(e) => setLines([{ account: e.target.value, amount: toStr(total) }])}>
                <option value="">Conta…</option>{options.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </label>
          ) : <p className="mt-2 text-xs text-muted">O movimento já está lançado: a nota só fica ligada a ele. Para mudar a classificação, ajuste em Financeiro › Movimentações.</p>}
        </fieldset>
      )}

      {(dest === "ASSET" || dest === "EXPENSE") && (
        <fieldset className="rounded-xl border border-border p-3">
          <legend className="px-1 text-xs font-medium text-muted">Classificação (soma {formatBRL(sum)} de {formatBRL(total)})</legend>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_8rem_2rem] gap-2">
                <select className={inputClass} value={l.account} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, account: e.target.value } : x)))} aria-label={`Conta da linha ${i + 1}`}>
                  <option value="">Conta…</option>{options.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
                <input className={inputClass} inputMode="decimal" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label={`Valor da linha ${i + 1}`} />
                <button type="button" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:bg-surface-2 disabled:opacity-30" aria-label="Tirar linha"><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
            <button type="button" className="inline-flex items-center gap-1 text-brand" onClick={() => setLines([...lines, { account: "", amount: toStr(Math.max(0, total - sum)) }])}><Plus size={13} /> dividir em outra conta</button>
            {!sumOk && <span className="text-danger">A classificação precisa somar o valor da nota.</span>}
          </div>
          {!hasInstallments && (
            <label className="mt-3 block w-48 text-xs text-muted">Vencimento (a nota não traz duplicata)
              <input type="date" className={inputClass} value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
          )}
        </fieldset>
      )}

      {dest === "IGNORED" && (
        <label className="block text-xs text-muted">Por que esta nota não gera lançamento?
          <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Ex.: nota de outra empresa; já lançada à mão em PAG-…" />
        </label>
      )}

      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <Button disabled={pending || !ok}>{pending ? "Confirmando…" : "Confirmar destino"}</Button>
    </form>
  );
}
