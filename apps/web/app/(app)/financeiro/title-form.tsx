"use client";
import { useMemo, useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Plus, Trash2 } from "lucide-react";
import { formatBRL, splitInstallments } from "@sie/domain";
import { Button, inputClass } from "@/components/ui";
import { createTitleAction } from "./actions";

interface Opt { id: string; label: string; hint?: string }
type Mode = "single" | "template" | "manual";

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const toNum = (s: string) => Number(String(s).replace(/\./g, "").replace(",", ".")) || 0;

/**
 * Lançamento de conta a pagar/receber com rateio na criação: uma conta + um centro de custo,
 * um modelo de rateio (ex.: mídia paga 80/20) ou divisão manual linha a linha.
 */
export function TitleForm({ direction, stores, parties, accounts, costCenters, templates, today }: {
  direction: "PAYABLE" | "RECEIVABLE";
  stores: { id: string; name: string; legal_entity_id: string }[];
  parties: Opt[]; accounts: Opt[]; costCenters: Opt[]; templates: Opt[]; today: string;
}) {
  const { state, pending, formProps } = useKeptForm(createTitleAction);
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const [partyId, setPartyId] = useState("");
  const [receiverId, setReceiverId] = useState("");
  const [description, setDescription] = useState("");
  const [docKind, setDocKind] = useState("");
  const [docNumber, setDocNumber] = useState("");
  const [competence, setCompetence] = useState(today);
  const [amount, setAmount] = useState("");
  const [n, setN] = useState(1);
  const [first, setFirst] = useState(today);
  const [every, setEvery] = useState(30);
  const [barcode, setBarcode] = useState("");
  const [mode, setMode] = useState<Mode>("single");
  const [account, setAccount] = useState("");
  const [cc, setCc] = useState("");
  const [template, setTemplate] = useState("");
  const [rows, setRows] = useState<{ account: string; cc: string; amount: string }[]>([{ account: "", cc: "", amount: "" }, { account: "", cc: "", amount: "" }]);

  const total = toNum(amount);
  const parts = useMemo(() => (total > 0 ? splitInstallments(total, Math.max(1, n)).map((v, i) => ({ due_date: addDays(first, every * i), amount: v, barcode: i === 0 && barcode ? barcode : undefined })) : []), [total, n, first, every, barcode]);
  const rowsTotal = rows.reduce((a, r) => a + toNum(r.amount), 0);
  const store = stores.find((s) => s.id === storeId);

  const payload = {
    direction,
    legal_entity_id: store?.legal_entity_id,
    store_id: storeId || undefined,
    party_id: partyId || undefined,
    receiver_party_id: receiverId && receiverId !== partyId ? receiverId : undefined,
    description,
    document_kind: docKind || undefined,
    document_number: docNumber || undefined,
    competence_date: competence,
    installments: parts,
    ...(mode === "single" ? { chart_account_id: account || undefined, cost_center_id: cc || undefined } : {}),
    ...(mode === "template" ? { chart_account_id: account || undefined, allocation_template_id: template || undefined } : {}),
    ...(mode === "manual" ? { lines: rows.filter((r) => r.account && toNum(r.amount) > 0).map((r) => ({ chart_account_id: r.account, cost_center_id: r.cc || undefined, amount: toNum(r.amount) })) } : {}),
  };

  const manualOk = mode !== "manual" || Math.abs(rowsTotal - total) < 0.005;
  const partyDefault = parties.find((p) => p.id === partyId)?.hint;   // categoria padrão do favorecido (o banco usa quando a conta fica vazia)
  const canSubmit = !pending && description.trim().length > 1 && total > 0 && !!store && manualOk
    && (mode === "manual" || !!account || (mode === "single" && !!partyDefault)) && (mode !== "template" || !!template);

  return (
    <form {...formProps} className="mt-3 grid gap-3 sm:grid-cols-6">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      <label className="sm:col-span-2 text-xs text-muted">Empresa / loja
        <select className={inputClass} value={storeId} onChange={(e) => setStoreId(e.target.value)}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      </label>
      <label className="sm:col-span-2 text-xs text-muted">{direction === "PAYABLE" ? "Fornecedor / favorecido" : "Cliente / pagador"}
        <select className={inputClass} value={partyId} onChange={(e) => setPartyId(e.target.value)}>
          <option value="">— não informar —</option>
          {parties.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {(() => { const h = parties.find((p) => p.id === partyId)?.hint; return h && !account ? <span className="mt-0.5 block text-[11px]">Sem conta escolhida, usa a categoria padrão: {h}</span> : null; })()}
      </label>
      <label className="sm:col-span-2 text-xs text-muted">{direction === "PAYABLE" ? "Recebedor do pagamento (se diferente)" : "Quem paga de fato (se diferente)"}
        <select className={inputClass} value={receiverId} onChange={(e) => setReceiverId(e.target.value)}>
          <option value="">— o mesmo —</option>
          {parties.filter((p) => p.id !== partyId).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <span className="mt-0.5 block text-[11px]">{direction === "PAYABLE" ? "Ex.: boleto de um restaurante emitido por um banco ou intermediador: o fornecedor é o restaurante, o recebedor é quem aparece no boleto/extrato." : "Ex.: o cliente é a empresa, mas o dinheiro vem de outra conta."}</span>
      </label>
      <label className="sm:col-span-2 text-xs text-muted">Competência (mês da despesa/receita)
        <input type="date" className={inputClass} value={competence} onChange={(e) => setCompetence(e.target.value)} />
      </label>

      <label className="sm:col-span-4 text-xs text-muted">Descrição
        <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ex.: Honorários contábeis out/26" maxLength={200} />
      </label>
      <label className="sm:col-span-1 text-xs text-muted">Documento
        <input className={inputClass} value={docKind} onChange={(e) => setDocKind(e.target.value)} placeholder="NF, boleto…" />
      </label>
      <label className="sm:col-span-1 text-xs text-muted">Número
        <input className={inputClass} value={docNumber} onChange={(e) => setDocNumber(e.target.value)} />
      </label>

      <label className="sm:col-span-2 text-xs text-muted">Valor total (R$)
        <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" />
      </label>
      <label className="text-xs text-muted">Parcelas
        <input type="number" min={1} max={60} className={inputClass} value={n} onChange={(e) => setN(Math.max(1, Number(e.target.value) || 1))} />
      </label>
      <label className="sm:col-span-2 text-xs text-muted">1º vencimento
        <input type="date" className={inputClass} value={first} onChange={(e) => setFirst(e.target.value)} />
      </label>
      <label className="text-xs text-muted">Intervalo (dias)
        <input type="number" min={1} className={inputClass} value={every} onChange={(e) => setEvery(Math.max(1, Number(e.target.value) || 30))} />
      </label>
      <label className="sm:col-span-6 text-xs text-muted">Linha digitável / código de barras (opcional)
        <input className={inputClass} value={barcode} onChange={(e) => setBarcode(e.target.value)} />
      </label>

      <fieldset className="sm:col-span-6 rounded-lg border border-border p-3">
        <legend className="px-1 text-xs font-medium text-muted">Classificação e rateio por centro de custo</legend>
        <div className="mb-2 flex flex-wrap gap-3 text-sm">
          {([["single", "Uma conta e um centro de custo"], ["template", "Modelo de rateio"], ["manual", "Dividir manualmente"]] as [Mode, string][]).map(([v, l]) => (
            <label key={v} className="flex items-center gap-1.5"><input type="radio" name="mode" checked={mode === v} onChange={() => setMode(v)} /> {l}</label>
          ))}
        </div>
        {mode !== "manual" && (
          <div className="grid gap-2 sm:grid-cols-2">
            <select className={inputClass} value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Conta do plano">
              <option value="">Conta do plano…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            {mode === "single" ? (
              <select className={inputClass} value={cc} onChange={(e) => setCc(e.target.value)} aria-label="Centro de custo">
                <option value="">Centro de custo (opcional)…</option>{costCenters.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            ) : (
              <select className={inputClass} value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Modelo de rateio">
                <option value="">Modelo de rateio…</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            )}
          </div>
        )}
        {mode === "manual" && (
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_7rem_2rem] gap-2">
                <select className={inputClass} value={r.account} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, account: e.target.value } : x)))} aria-label="Conta">
                  <option value="">Conta…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
                <select className={inputClass} value={r.cc} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, cc: e.target.value } : x)))} aria-label="Centro de custo">
                  <option value="">Centro de custo…</option>{costCenters.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
                <input className={inputClass} inputMode="decimal" placeholder="0,00" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label="Valor" />
                <button type="button" className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Remover linha" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
              </div>
            ))}
            <div className="flex items-center justify-between text-xs">
              <button type="button" className="inline-flex items-center gap-1 text-brand" onClick={() => setRows([...rows, { account: "", cc: "", amount: "" }])}><Plus size={14} /> linha</button>
              <span className={manualOk ? "text-muted" : "text-danger"}>Soma {formatBRL(rowsTotal)} de {formatBRL(total)}</span>
            </div>
          </div>
        )}
      </fieldset>

      {parts.length > 1 && (
        <p className="sm:col-span-6 text-xs text-muted">Parcelas: {parts.map((p) => `${p.due_date.split("-").reverse().join("/")} ${formatBRL(p.amount)}`).join(" · ")}</p>
      )}
      {state && !state.ok && <p className="sm:col-span-6 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <div className="sm:col-span-6"><Button disabled={!canSubmit}>{pending ? "Lançando…" : "Lançar"}</Button></div>
    </form>
  );
}
