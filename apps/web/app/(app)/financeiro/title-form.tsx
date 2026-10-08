"use client";
import { useMemo, useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Plus, Trash2 } from "lucide-react";
import { formatBRL, splitInstallments } from "@centralops/domain";
import { Button, inputClass } from "@/components/ui";
import { SearchSelect } from "@/components/search-select";
import { AiReadButton, type FinanceRead } from "@/components/ai-read-button";
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
  const [extra, setExtra] = useState<Opt[]>([]);   // favorecido achado pela leitura que não está na lista
  const partyOpts = useMemo(() => [...extra.filter((e) => !parties.some((p) => p.id === e.id)), ...parties], [extra, parties]);
  const fromAi = (d: FinanceRead) => {
    const f = d.fields;
    if (f.description) setDescription(String(f.description).slice(0, 200));
    if (typeof f.amount === "number") setAmount(f.amount.toFixed(2).replace(".", ","));
    if (f.due_date) setFirst(String(f.due_date));
    if (f.competence) setCompetence(String(f.competence));
    if (f.barcode) setBarcode(String(f.barcode));
    if (f.document_kind) setDocKind(String(f.document_kind));
    if (f.document_number) setDocNumber(String(f.document_number));
    if (d.party) { setExtra((x) => [...x, d.party!]); setPartyId(d.party.id); }
  };
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
  const partyDefault = partyOpts.find((p) => p.id === partyId)?.hint;   // categoria padrão do favorecido (o banco usa quando a conta fica vazia)
  const canSubmit = !pending && description.trim().length > 1 && total > 0 && !!store && manualOk
    && (mode === "manual" || !!account || (mode === "single" && !!partyDefault)) && (mode !== "template" || !!template);

  return (
    <form {...formProps} className="mt-3 grid gap-3 sm:grid-cols-6">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      <div className="sm:col-span-6"><AiReadButton purpose="titulo" onRead={fromAi} label="Ler boleto, nota ou Pix com IA" /></div>
      <label className="sm:col-span-2 text-xs text-muted">Empresa / loja
        <select className={inputClass} value={storeId} onChange={(e) => setStoreId(e.target.value)}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      </label>
      <label className="sm:col-span-2 text-xs text-muted">{direction === "PAYABLE" ? "Fornecedor / favorecido" : "Cliente / pagador"}
        <SearchSelect options={partyOpts} value={partyId} onChange={setPartyId} emptyLabel="— não informar —" ariaLabel="Fornecedor" />
        {(() => { const h = partyOpts.find((p) => p.id === partyId)?.hint; return h && !account ? <span className="mt-0.5 block text-[11px]">Sem conta escolhida, usa a categoria padrão: {h}</span> : null; })()}
      </label>
      <label className="sm:col-span-2 text-xs text-muted">{direction === "PAYABLE" ? "Recebedor do pagamento (se diferente)" : "Quem paga de fato (se diferente)"}
        <SearchSelect options={partyOpts.filter((p) => p.id !== partyId)} value={receiverId} onChange={setReceiverId} emptyLabel="— o mesmo —" ariaLabel="Recebedor" />
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
            <SearchSelect options={accounts} value={account} onChange={setAccount} placeholder="Conta do plano…" emptyLabel="Conta do plano…" ariaLabel="Conta do plano" />
            {mode === "single" ? (
              <SearchSelect options={costCenters} value={cc} onChange={setCc} placeholder="Centro de custo (opcional)…" emptyLabel="Sem centro de custo" ariaLabel="Centro de custo" />
            ) : (
              <SearchSelect options={templates} value={template} onChange={setTemplate} placeholder="Modelo de rateio…" ariaLabel="Modelo de rateio" />
            )}
          </div>
        )}
        {mode === "manual" && (
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_7rem_2rem] gap-2">
                <SearchSelect options={accounts} value={r.account} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, account: v } : x)))} placeholder="Conta…" ariaLabel="Conta" />
                <SearchSelect options={costCenters} value={r.cc} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, cc: v } : x)))} placeholder="Centro de custo…" emptyLabel="Sem centro de custo" ariaLabel="Centro de custo" />
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
