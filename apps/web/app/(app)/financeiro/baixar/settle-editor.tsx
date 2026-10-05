"use client";
import { useMemo, useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import {
  allocateOldestFirst, findExactCombination, formatBRL, kindsFor, lateCharges, netCash, roundCents,
  SETTLEMENT_KIND_LABEL, type Direction, type SettlementKind, type SettlementLineInput,
} from "@centralops/domain";
import { Badge, Button, Card, inputClass } from "@/components/ui";
import { settleAction } from "../actions";

export interface EditorItem {
  id: string; title_number: string; description: string; party_name: string | null; party_id: string | null;
  n: number; due_date: string; balance: number; fee_expected: number; fee_anticipation_expected: number;
  days_overdue: number; legal_entity_id: string;
}
interface Opt { id: string; label: string }
interface Row { on: boolean; principal: string; interest: string; fine: string; discount: string; mdr: string; antic: string }
interface Extra { key: number; kind: SettlementKind; amount: string; account: string; cc: string; credit: string; memo: string }

const toNum = (s: string) => Number(String(s).replace(/\./g, "").replace(",", ".")) || 0;
const fmt = (n: number) => (n === 0 ? "" : n.toFixed(2).replace(".", ","));
const METHODS_OUT = [["PIX", "Pix"], ["TED", "TED"], ["BOLETO", "Boleto"], ["DEBIT_AUTO", "Débito automático"], ["CASH", "Dinheiro"], ["CHECK", "Cheque"], ["OTHER", "Outro"]];
const METHODS_IN = [["PIX", "Pix"], ["CARD_PAYOUT", "Repasse da adquirente"], ["TED", "TED"], ["BOLETO", "Boleto"], ["CASH", "Dinheiro"], ["OTHER", "Outro"]];

function initRow(it: EditorItem, on: boolean, direction: Direction): Row {
  const mdr = direction === "RECEIVABLE" ? Math.max(it.fee_expected - it.fee_anticipation_expected, 0) : 0;
  return { on, principal: fmt(it.balance), interest: "", fine: "", discount: "", mdr: fmt(mdr), antic: fmt(direction === "RECEIVABLE" ? it.fee_anticipation_expected : 0) };
}

/**
 * Baixa com rateio: um movimento no banco quitando várias parcelas, com juros, multa, desconto, taxas, retenções,
 * tarifas, adiantamento e uso de crédito. O total tem que fechar com o valor do extrato/comprovante.
 */
export function SettleEditor(props: {
  direction: Direction; items: EditorItem[]; initialSelected: string[]; banks: (Opt & { legal_entity_id: string })[];
  costCenters: Opt[]; accounts: Opt[]; anticipationAccountId?: string;
  credits: { id: string; party_id: string | null; label: string; remaining: number }[];
  statement?: { id: string; posted_on: string; amount: number; description: string; bank_account_id: string; counterpart: string | null };
  today: string; idempotencyKey: string; defaultBankId?: string;
}) {
  const { direction, items, statement } = props;
  const { state, pending, formProps } = useKeptForm(settleAction);
  const [rows, setRows] = useState<Record<string, Row>>(() =>
    Object.fromEntries(items.map((it) => [it.id, initRow(it, props.initialSelected.includes(it.id), direction)])));
  const [extras, setExtras] = useState<Extra[]>([]);
  const [bankId, setBankId] = useState(statement?.bank_account_id ?? props.defaultBankId ?? props.banks[0]?.id ?? "");
  const [date, setDate] = useState(statement?.posted_on ?? props.today);
  const [method, setMethod] = useState(statement ? "PIX" : direction === "PAYABLE" ? "PIX" : "PIX");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState(statement?.description ?? "");
  const [target, setTarget] = useState(statement ? fmt(Math.abs(statement.amount)) : "");
  const [filter, setFilter] = useState("");
  const [newKind, setNewKind] = useState<SettlementKind>(direction === "PAYABLE" ? "CHARGE" : "WITHHOLDING");
  const [hint, setHint] = useState<string | null>(null);

  const setRow = (id: string, patch: Partial<Row>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));
  const selected = items.filter((i) => rows[i.id]?.on);
  const entities = new Set(selected.map((i) => i.legal_entity_id));
  const entityId = selected[0]?.legal_entity_id;
  const banks = entityId ? props.banks.filter((b) => b.legal_entity_id === entityId) : props.banks;
  const bankValid = banks.some((b) => b.id === bankId);

  const lines = useMemo(() => {
    const out: SettlementLineInput[] = [];
    for (const it of selected) {
      const r = rows[it.id];
      const push = (kind: SettlementKind, v: string, extra: Partial<SettlementLineInput> = {}) => {
        const n = toNum(v);
        if (n > 0) out.push({ kind, amount: roundCents(n), installment_id: it.id, ...extra });
      };
      push("PRINCIPAL", r.principal);
      push("INTEREST", r.interest);
      push("FINE", r.fine);
      push("DISCOUNT", r.discount);
      if (direction === "RECEIVABLE") {
        push("FEE", r.mdr);
        push("FEE", r.antic, props.anticipationAccountId ? { chart_account_id: props.anticipationAccountId } : {});
      }
    }
    for (const x of extras) {
      const n = toNum(x.amount);
      if (n > 0) out.push({ kind: x.kind, amount: roundCents(n), chart_account_id: x.account || undefined, cost_center_id: x.cc || undefined, credit_id: x.credit || undefined, memo: x.memo || undefined });
    }
    return out;
  }, [selected, rows, extras, direction, props.anticipationAccountId]);

  const net = netCash(lines);
  const targetN = target ? toNum(target) : null;
  const diff = targetN === null ? 0 : roundCents(targetN - net);
  const sumBy = (k: SettlementKind) => roundCents(lines.filter((l) => l.kind === k).reduce((a, l) => a + l.amount, 0));
  const rowErrors = selected.filter((it) => toNum(rows[it.id].principal) > it.balance + 0.004).map((it) => it.title_number);
  const partyIds = new Set(selected.map((i) => i.party_id).filter(Boolean));
  const partyId = partyIds.size === 1 ? [...partyIds][0]! : undefined;
  const credits = props.credits.filter((c) => !partyId || c.party_id === partyId);

  const problems: string[] = [];
  if (lines.length === 0) problems.push("Selecione ao menos uma parcela ou inclua um item.");
  if (entities.size > 1) problems.push("As parcelas são de empresas (CNPJs) diferentes: baixe separadamente.");
  if (!bankValid) problems.push("Escolha a conta bancária da mesma empresa das parcelas.");
  if (rowErrors.length) problems.push(`Principal maior que o saldo: ${rowErrors.join(", ")}.`);
  if (net < 0) problems.push("Descontos, taxas e retenções superam o valor a baixar.");
  if (targetN !== null && diff !== 0) problems.push(`Falta ${formatBRL(Math.abs(diff))} ${diff > 0 ? "para chegar ao valor do extrato" : "— o total ultrapassa o valor do extrato"}.`);
  if (statement && !target) problems.push("Informe o valor do extrato.");

  const payload = {
    direction, bank_account_id: bankId, settled_on: date, method, party_id: partyId,
    amount: targetN ?? net, reference: reference || undefined, description: description || undefined,
    statement_line_id: statement?.id, idempotency_key: props.idempotencyKey, lines,
  };

  // ---- Ações auxiliares ----
  const distribute = () => {
    const t = targetN ?? 0;
    if (t <= 0 || selected.length === 0) return setHint("Informe o valor e marque as parcelas.");
    if (direction === "PAYABLE") {
      const extrasNet = netCash(lines.filter((l) => l.kind !== "PRINCIPAL"));
      const { byId, rest } = allocateOldestFirst(t - extrasNet, selected.map((s) => ({ id: s.id, balance: s.balance, due_date: s.due_date })));
      setRows((r) => {
        const n = { ...r };
        for (const it of selected) n[it.id] = { ...n[it.id], principal: fmt(byId[it.id] ?? 0) };
        return n;
      });
      setHint(rest > 0 ? `Sobrou ${formatBRL(rest)}: lance como adiantamento ou ajuste os valores.` : "Valor distribuído pelas parcelas mais antigas.");
    } else {
      setRows((r) => {
        const n = { ...r };
        for (const it of selected) n[it.id] = initRow(it, true, direction);
        return n;
      });
      setHint("Principal e taxas esperadas preenchidos; confira contra o valor líquido do extrato.");
    }
  };

  const suggest = () => {
    const t = targetN ?? 0;
    if (t <= 0) return setHint("Informe o valor do extrato para sugerir a combinação.");
    const pool = items.map((i) => ({ id: i.id, due_date: i.due_date, amount: direction === "RECEIVABLE" ? roundCents(i.balance - i.fee_expected) : i.balance }));
    const ids = findExactCombination(t, pool);
    if (!ids) return setHint("Nenhuma combinação exata de parcelas fecha esse valor — ajuste com juros, taxas ou itens extras.");
    setRows(Object.fromEntries(items.map((it) => [it.id, initRow(it, ids.includes(it.id), direction)])));
    setHint(`Combinação encontrada: ${ids.length} parcela(s) fecham exatamente ${formatBRL(t)}.`);
  };

  const applyLate = (it: EditorItem) => {
    const c = lateCharges(it.balance, it.days_overdue);
    setRow(it.id, { fine: fmt(c.fine), interest: fmt(c.interest) });
  };

  const addExtra = (kind: SettlementKind, amount = "") =>
    setExtras((e) => [...e, { key: Date.now() + e.length, kind, amount, account: "", cc: "", credit: "", memo: "" }]);
  const setExtra = (key: number, patch: Partial<Extra>) => setExtras((e) => e.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const shown = items.filter((i) => rows[i.id].on || !filter || `${i.title_number} ${i.description} ${i.party_name ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  const noteRateio = "Juros, multa e desconto seguem o rateio do título (centros de custo); use “Outros itens” para direcionar a uma conta/centro específico.";

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />

      {statement && (
        <Card title="Linha do extrato">
          <p className="text-sm"><b>{statement.posted_on.split("-").reverse().join("/")}</b> · {statement.description}
            {statement.counterpart && <span className="text-muted"> · {statement.counterpart}</span>}</p>
          <p className={`mt-1 text-xl font-semibold ${statement.amount > 0 ? "text-success" : "text-danger"}`}>{formatBRL(statement.amount)}</p>
        </Card>
      )}

      <Card title="Movimento">
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="text-xs text-muted sm:col-span-2">Conta bancária
            <select className={inputClass} value={bankId} onChange={(e) => setBankId(e.target.value)} disabled={!!statement}>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted">Data da baixa
            <input type="date" className={inputClass} value={date} max={props.today} onChange={(e) => setDate(e.target.value)} disabled={!!statement} />
          </label>
          <label className="text-xs text-muted">Forma
            <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value)}>
              {(direction === "PAYABLE" ? METHODS_OUT : METHODS_IN).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted sm:col-span-2">Descrição
            <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder={direction === "PAYABLE" ? "Ex.: Pix fornecedores out/26" : "Ex.: Repasse Stone 12/10"} />
          </label>
          <label className="text-xs text-muted">Nº do documento / e2eId
            <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
          </label>
          <label className="text-xs text-muted">Valor no {direction === "PAYABLE" ? "comprovante/extrato" : "extrato"} (R$)
            <input className={inputClass} inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} readOnly={!!statement} placeholder="opcional — confere o total" />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={distribute}>Distribuir o valor</Button>
          <Button type="button" variant="secondary" onClick={suggest}><Sparkles size={14} /> Sugerir combinação exata</Button>
        </div>
        {hint && <p className="mt-2 text-sm text-muted" role="status">{hint}</p>}
      </Card>

      <Card title={`Parcelas ${direction === "PAYABLE" ? "a pagar" : "a receber"} (${selected.length} marcada(s))`}
        action={<input className="w-48 rounded-lg border border-border bg-bg px-2 py-1 text-xs" placeholder="Filtrar…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrar parcelas" />}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="w-8 py-1" /><th className="py-1">Vencimento</th><th>Título</th><th className="text-right">Saldo</th>
                <th className="w-28">Principal</th><th className="w-24">Juros</th><th className="w-24">Multa</th><th className="w-24">Desconto</th>
                {direction === "RECEIVABLE" && <><th className="w-24">Taxa (MDR)</th><th className="w-24">Antecipação</th></>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.map((it) => {
                const r = rows[it.id];
                return (
                  <tr key={it.id} className={r.on ? "bg-brand/5" : "text-muted"}>
                    <td className="py-1.5"><input type="checkbox" checked={r.on} onChange={(e) => setRow(it.id, { on: e.target.checked })} aria-label={`Marcar ${it.title_number}`} /></td>
                    <td className={`whitespace-nowrap py-1.5 ${it.days_overdue > 0 ? "text-danger" : ""}`}>
                      {it.due_date.split("-").reverse().join("/")}
                      {it.days_overdue > 0 && r.on && <button type="button" onClick={() => applyLate(it)} className="ml-1 text-xs text-brand underline" title="Multa de 2% + juros de 1% ao mês">multa/juros</button>}
                    </td>
                    <td className="py-1.5"><span className="text-xs">{it.title_number}·{it.n}</span> {it.description}{it.party_name && <span className="block text-xs text-muted">{it.party_name}</span>}</td>
                    <td className="py-1.5 text-right whitespace-nowrap">{formatBRL(it.balance)}</td>
                    {(["principal", "interest", "fine", "discount", ...(direction === "RECEIVABLE" ? ["mdr", "antic"] : [])] as (keyof Row)[]).map((f) => (
                      <td key={f} className="py-1"><input className="w-full rounded border border-border bg-bg px-2 py-1 text-right text-sm disabled:opacity-40" inputMode="decimal"
                        disabled={!r.on} value={r[f] as string} onChange={(e) => setRow(it.id, { [f]: e.target.value } as Partial<Row>)} aria-label={`${f} ${it.title_number}`} /></td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">{noteRateio}</p>
      </Card>

      <Card title="Outros itens do movimento"
        action={
          <div className="flex items-center gap-1">
            <select className="rounded-lg border border-border bg-bg px-2 py-1 text-xs" value={newKind} onChange={(e) => setNewKind(e.target.value as SettlementKind)} aria-label="Tipo de item">
              {kindsFor(direction).filter((k) => k !== "PRINCIPAL").map((k) => <option key={k} value={k}>{SETTLEMENT_KIND_LABEL[k]}</option>)}
            </select>
            <button type="button" className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-surface-2" onClick={() => addExtra(newKind)}><Plus size={13} /> adicionar</button>
          </div>
        }>
        {extras.length === 0 ? (
          <p className="text-sm text-muted">Tarifa do banco, retenção de tributo, adiantamento/sobra, uso de crédito com o fornecedor… Cada item vai para a sua conta e centro de custo.</p>
        ) : (
          <div className="space-y-2">
            {extras.map((x) => (
              <div key={x.key} className="grid gap-2 sm:grid-cols-[9rem_7rem_1fr_1fr_2rem]">
                <div className="flex items-center"><Badge tone={["DISCOUNT", "FEE", "WITHHOLDING", "CREDIT_USE"].includes(x.kind) ? "warning" : "brand"}>{SETTLEMENT_KIND_LABEL[x.kind]}</Badge></div>
                <input className={inputClass} inputMode="decimal" placeholder="0,00" value={x.amount} onChange={(e) => setExtra(x.key, { amount: e.target.value })} aria-label="Valor do item" />
                {x.kind === "CREDIT_USE" ? (
                  <select className={`${inputClass} sm:col-span-2`} value={x.credit} onChange={(e) => setExtra(x.key, { credit: e.target.value, amount: x.amount || fmt(credits.find((c) => c.id === e.target.value)?.remaining ?? 0) })} aria-label="Crédito">
                    <option value="">Crédito a usar…</option>{credits.map((c) => <option key={c.id} value={c.id}>{c.label} — saldo {formatBRL(c.remaining)}</option>)}
                  </select>
                ) : (
                  <>
                    <select className={inputClass} value={x.account} onChange={(e) => setExtra(x.key, { account: e.target.value })} aria-label="Conta">
                      <option value="">Conta padrão do tipo</option>{props.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                    </select>
                    <select className={inputClass} value={x.cc} onChange={(e) => setExtra(x.key, { cc: e.target.value })} aria-label="Centro de custo">
                      <option value="">Centro de custo do título</option>{props.costCenters.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                  </>
                )}
                <button type="button" className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Remover item" onClick={() => setExtras((e) => e.filter((y) => y.key !== x.key))}><Trash2 size={16} /></button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Resumo do movimento">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          {([["PRINCIPAL", "+"], ["INTEREST", "+"], ["FINE", "+"], ["CHARGE", "+"], ["ADVANCE", "+"], ["DISCOUNT", "−"], ["FEE", "−"], ["WITHHOLDING", "−"], ["CREDIT_USE", "−"]] as [SettlementKind, string][])
            .filter(([k]) => sumBy(k) > 0).map(([k, s]) => (
              <div key={k} className="flex justify-between gap-2"><dt className="text-muted">{SETTLEMENT_KIND_LABEL[k]}</dt><dd>{s} {formatBRL(sumBy(k))}</dd></div>
            ))}
        </dl>
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-3">
          <p className="text-sm text-muted">Movimento no banco ({direction === "PAYABLE" ? "saída" : "entrada"})</p>
          <p className="text-2xl font-semibold">{formatBRL(net)}</p>
        </div>
        {targetN !== null && (
          <p className={`mt-1 text-sm ${diff === 0 ? "text-success" : "text-danger"}`}>
            {diff === 0 ? "Fecha com o valor informado." : `Diferença de ${formatBRL(diff)} em relação ao valor informado.`}
            {diff > 0 && (
              <button type="button" className="ml-2 text-brand underline" onClick={() => addExtra("ADVANCE", fmt(diff))}>
                lançar como {direction === "PAYABLE" ? "adiantamento ao fornecedor" : "adiantamento de cliente"}
              </button>
            )}
          </p>
        )}
        {problems.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm text-danger">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {state && !state.ok && <p className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{state.error}</p>}
        <div className="mt-3"><Button disabled={pending || problems.length > 0}>{pending ? "Registrando…" : direction === "PAYABLE" ? "Registrar pagamento" : "Registrar recebimento"}</Button></div>
      </Card>
    </form>
  );
}
