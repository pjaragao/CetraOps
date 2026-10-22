"use client";
import { useMemo, useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Lock, Plus, Trash2 } from "lucide-react";
import { formatBRL, splitInstallments } from "@centralops/domain";
import { Button, inputClass } from "@/components/ui";
import { SearchSelect } from "@/components/search-select";
import { AiReadButton, type FinanceRead } from "@/components/ai-read-button";
import { createTitleAction, updateTitleAction } from "./actions";

interface Opt { id: string; label: string; hint?: string }
type Mode = "single" | "template" | "manual";
type Inst = { due_date: string; amount: string; barcode: string };

/** Título já lançado, para o mesmo formulário abrir em modo edição. */
export interface EditableTitle {
  id: string; store_id: string | null; party_id: string | null; receiver_party_id: string | null; description: string;
  document_kind: string | null; document_number: string | null; competence_date: string;
  chart_account_id: string | null; cost_center_id: string | null;
  lines: { chart_account_id: string; cost_center_id: string | null; amount: number }[];
  installments: { due_date: string; amount: number; barcode: string | null }[];
}

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const toNum = (s: string) => Number(String(s).replace(/\./g, "").replace(",", ".")) || 0;
const toStr = (n: number) => (n ? n.toFixed(2).replace(".", ",") : "");
const generate = (total: number, n: number, first: string, every: number, barcode = ""): Inst[] =>
  total > 0 ? splitInstallments(total, Math.max(1, n)).map((v, i) => ({ due_date: addDays(first, every * i), amount: toStr(v), barcode: i === 0 ? barcode : "" })) : [];

/**
 * Lançamento de conta a pagar/receber — o mesmo formulário cria e edita.
 * Rateio: uma conta + um centro de custo, um modelo de rateio (ex.: mídia paga 80/20) ou divisão manual linha a linha.
 * Parcelas: geradas pelo valor total, quantidade, 1º vencimento e intervalo; depois cada uma pode ser ajustada (data, valor, código de barras).
 * Na edição, `lock` (motivo) trava tudo menos descrição e documento: título com pagamento/baixa ou gerado por outra rotina
 * (o vencimento de parcela em aberto continua mudando na tabela de parcelas). Loja e recebedor não mudam depois de lançado.
 */
export function TitleForm({ direction, stores, parties, accounts, costCenters, templates, today, edit, lock }: {
  direction: "PAYABLE" | "RECEIVABLE";
  stores: { id: string; name: string; legal_entity_id: string }[];
  parties: Opt[]; accounts: Opt[]; costCenters: Opt[]; templates: Opt[]; today: string;
  edit?: EditableTitle; lock?: string | null;
}) {
  const { state, pending, formProps } = useKeptForm(edit ? updateTitleAction : createTitleAction);
  const t = edit;
  const split = !!t && new Set(t.lines.map((l) => `${l.chart_account_id}|${l.cost_center_id ?? ""}`)).size > 1;
  const [storeId, setStoreId] = useState(t?.store_id ?? stores[0]?.id ?? "");
  const [partyId, setPartyId] = useState(t?.party_id ?? "");
  const [receiverId, setReceiverId] = useState(t?.receiver_party_id ?? "");
  const [description, setDescription] = useState(t?.description ?? "");
  const [docKind, setDocKind] = useState(t?.document_kind ?? "");
  const [docNumber, setDocNumber] = useState(t?.document_number ?? "");
  const [competence, setCompetence] = useState(t?.competence_date ?? today);
  const inst0: Inst[] = t ? t.installments.map((i) => ({ due_date: i.due_date, amount: toStr(i.amount), barcode: i.barcode ?? "" })) : [];
  const [amount, setAmount] = useState(t ? toStr(t.installments.reduce((a, i) => a + i.amount, 0)) : "");
  const [n, setN] = useState(t ? Math.max(1, t.installments.length) : 1);
  const [first, setFirst] = useState(inst0[0]?.due_date ?? today);
  const [every, setEvery] = useState(inst0.length > 1 ? Math.max(1, daysBetween(inst0[0].due_date, inst0[1].due_date)) : 30);
  const [inst, setInst] = useState<Inst[]>(inst0);
  const [mode, setMode] = useState<Mode>(split ? "manual" : "single");
  const [account, setAccount] = useState(t ? (t.chart_account_id ?? t.lines[0]?.chart_account_id ?? "") : "");
  const [cc, setCc] = useState(t ? (t.cost_center_id ?? t.lines[0]?.cost_center_id ?? "") : "");
  const [template, setTemplate] = useState("");
  const [extra, setExtra] = useState<Opt[]>([]);   // favorecido achado pela leitura que não está na lista
  const partyOpts = useMemo(() => [...extra.filter((e) => !parties.some((p) => p.id === e.id)), ...parties], [extra, parties]);
  const [rows, setRows] = useState<{ account: string; cc: string; amount: string }[]>(split
    ? t!.lines.map((l) => ({ account: l.chart_account_id, cc: l.cost_center_id ?? "", amount: toStr(l.amount) }))
    : [{ account: "", cc: "", amount: "" }, { account: "", cc: "", amount: "" }]);
  const locked = !!edit && !!lock;

  // criação: as parcelas nascem do gerador; edição: as do banco
  const parts = !edit && inst.length === 0 ? generate(toNum(amount), n, first, every) : inst;
  // o gerador (valor, quantidade, 1º vencimento, intervalo) refaz as parcelas; ajustar uma parcela à mão atualiza o total
  const regen = (patch: Partial<{ amount: string; n: number; first: string; every: number; barcode: string }>) => {
    const a = patch.amount ?? amount, q = patch.n ?? n, f = patch.first ?? first, e = patch.every ?? every;
    if (patch.amount !== undefined) setAmount(a);
    if (patch.n !== undefined) setN(q);
    if (patch.first !== undefined) setFirst(f);
    if (patch.every !== undefined) setEvery(e);
    setInst(generate(toNum(a), q, f, e, patch.barcode ?? inst[0]?.barcode ?? ""));
  };
  const setRow = (i: number, p: Partial<Inst>) => {
    const next = parts.map((x, j) => (j === i ? { ...x, ...p } : x));
    setInst(next);
    if (p.amount !== undefined) setAmount(toStr(next.reduce((a, x) => a + toNum(x.amount), 0)));
    if (p.due_date !== undefined && i === 0) setFirst(p.due_date);
  };

  const fromAi = (d: FinanceRead) => {
    const f = d.fields;
    if (f.description) setDescription(String(f.description).slice(0, 200));
    if (f.competence) setCompetence(String(f.competence));
    if (f.document_kind) setDocKind(String(f.document_kind));
    if (f.document_number) setDocNumber(String(f.document_number));
    if (d.party) { setExtra((x) => [...x, d.party!]); setPartyId(d.party.id); }
    regen({ ...(typeof f.amount === "number" ? { amount: toStr(f.amount) } : {}), ...(f.due_date ? { first: String(f.due_date) } : {}), ...(f.barcode ? { barcode: String(f.barcode) } : {}) });
  };

  const total = parts.reduce((a, p) => a + toNum(p.amount), 0);
  const rowsTotal = rows.reduce((a, r) => a + toNum(r.amount), 0);
  const store = stores.find((s) => s.id === storeId);
  const installments = parts.map((p) => ({ due_date: p.due_date, amount: toNum(p.amount), ...(p.barcode ? { barcode: p.barcode } : {}) }));
  const classification = {
    ...(mode === "single" ? { chart_account_id: account || undefined, cost_center_id: cc || (edit ? "" : undefined) } : {}),
    ...(mode === "template" ? { chart_account_id: account || undefined, allocation_template_id: template || undefined } : {}),
    ...(mode === "manual" ? { lines: rows.filter((r) => r.account && toNum(r.amount) > 0).map((r) => ({ chart_account_id: r.account, cost_center_id: r.cc || undefined, amount: toNum(r.amount) })) } : {}),
  };

  const payload = edit
    ? { id: edit.id, description, document_kind: docKind, document_number: docNumber,
        ...(locked ? {} : { party_id: partyId, competence_date: competence, installments, ...classification }) }
    : {
        direction, legal_entity_id: store?.legal_entity_id, store_id: storeId || undefined, party_id: partyId || undefined,
        receiver_party_id: receiverId && receiverId !== partyId ? receiverId : undefined,
        description, document_kind: docKind || undefined, document_number: docNumber || undefined, competence_date: competence,
        installments, ...classification,
      };

  const manualOk = mode !== "manual" || Math.abs(rowsTotal - total) < 0.005;
  const partyDefault = partyOpts.find((p) => p.id === partyId)?.hint;   // categoria padrão do favorecido (o banco usa quando a conta fica vazia, só na criação)
  const instOk = parts.length > 0 && parts.every((p) => p.due_date && toNum(p.amount) > 0);
  const canSubmit = !pending && description.trim().length > 1 && (locked || (
    total > 0 && instOk && !!store && manualOk
    && (mode === "manual" || !!account || (!edit && mode === "single" && !!partyDefault)) && (mode !== "template" || !!template)));

  return (
    <form {...formProps} className="mt-3 grid gap-3 sm:grid-cols-6">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      {locked && (
        <p className="sm:col-span-6 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning"><Lock size={14} className="mt-0.5 shrink-0" aria-hidden /> {lock}</p>
      )}
      {!locked && <div className="sm:col-span-6"><AiReadButton purpose="titulo" onRead={fromAi} label="Ler boleto, nota ou Pix com IA" /></div>}
      <label className="sm:col-span-2 text-xs text-muted">Empresa / loja
        <select className={inputClass} value={storeId} onChange={(e) => setStoreId(e.target.value)} disabled={!!edit} title={edit ? "A loja não muda depois de lançado" : undefined}>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label className="sm:col-span-2 text-xs text-muted">{direction === "PAYABLE" ? "Fornecedor / favorecido" : "Cliente / pagador"}
        <SearchSelect options={partyOpts} value={partyId} onChange={setPartyId} emptyLabel="— não informar —" ariaLabel="Fornecedor" disabled={locked} />
        {(() => { const h = partyOpts.find((p) => p.id === partyId)?.hint; return h && !account && !edit ? <span className="mt-0.5 block text-[11px]">Sem conta escolhida, usa a categoria padrão: {h}</span> : null; })()}
      </label>
      <label className="sm:col-span-2 text-xs text-muted">{direction === "PAYABLE" ? "Recebedor do pagamento (se diferente)" : "Quem paga de fato (se diferente)"}
        <SearchSelect options={partyOpts.filter((p) => p.id !== partyId)} value={receiverId} onChange={setReceiverId} emptyLabel="— o mesmo —" ariaLabel="Recebedor" disabled={!!edit} />
        <span className="mt-0.5 block text-[11px]">{edit ? "Não muda depois de lançado." : direction === "PAYABLE" ? "Ex.: boleto de um restaurante emitido por um banco ou intermediador: o fornecedor é o restaurante, o recebedor é quem aparece no boleto/extrato." : "Ex.: o cliente é a empresa, mas o dinheiro vem de outra conta."}</span>
      </label>
      <label className="sm:col-span-2 text-xs text-muted">Competência (mês da despesa/receita)
        <input type="date" className={inputClass} value={competence} onChange={(e) => setCompetence(e.target.value)} disabled={locked} />
      </label>

      <label className="sm:col-span-4 text-xs text-muted">Descrição
        <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ex.: Honorários contábeis out/26" maxLength={200} />
      </label>
      <label className="sm:col-span-1 text-xs text-muted">Documento
        <input className={inputClass} value={docKind} onChange={(e) => setDocKind(e.target.value)} placeholder="NF, boleto…" maxLength={40} />
      </label>
      <label className="sm:col-span-1 text-xs text-muted">Número
        <input className={inputClass} value={docNumber} onChange={(e) => setDocNumber(e.target.value)} maxLength={60} />
      </label>

      <label className="sm:col-span-2 text-xs text-muted">Valor total (R$)
        <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => regen({ amount: e.target.value })} placeholder="0,00" disabled={locked} />
      </label>
      <label className="text-xs text-muted">Parcelas
        <input type="number" min={1} max={60} className={inputClass} value={n} onChange={(e) => regen({ n: Math.min(60, Math.max(1, Number(e.target.value) || 1)) })} disabled={locked} />
      </label>
      <label className="sm:col-span-2 text-xs text-muted">1º vencimento
        <input type="date" className={inputClass} value={first} onChange={(e) => regen({ first: e.target.value })} disabled={locked} />
      </label>
      <label className="text-xs text-muted">Intervalo (dias)
        <input type="number" min={1} className={inputClass} value={every} onChange={(e) => regen({ every: Math.max(1, Number(e.target.value) || 30) })} disabled={locked || n < 2} />
      </label>

      {parts.length > 0 && (
        <fieldset className="sm:col-span-6 rounded-lg border border-border p-3" disabled={locked}>
          <legend className="px-1 text-xs font-medium text-muted">Parcelas{!locked && " (ajuste a data, o valor ou o código de barras de cada uma)"}</legend>
          <div className="space-y-2">
            {parts.map((r, i) => (
              <div key={i} className="grid grid-cols-[2.5rem_9.5rem_8rem_1fr] items-center gap-2">
                <span className="text-xs text-muted">{i + 1}ª</span>
                <input type="date" className={inputClass} value={r.due_date} onChange={(e) => setRow(i, { due_date: e.target.value })} aria-label={`Vencimento da parcela ${i + 1}`} />
                <input className={inputClass} inputMode="decimal" value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} aria-label={`Valor da parcela ${i + 1}`} />
                <input className={inputClass} value={r.barcode} onChange={(e) => setRow(i, { barcode: e.target.value })} placeholder="Linha digitável / código de barras (opcional)" aria-label={`Código de barras da parcela ${i + 1}`} />
              </div>
            ))}
          </div>
          {parts.length > 1 && <p className="mt-2 text-right text-xs text-muted">Total {formatBRL(total)}</p>}
        </fieldset>
      )}

      <fieldset className="sm:col-span-6 rounded-lg border border-border p-3" disabled={locked}>
        <legend className="px-1 text-xs font-medium text-muted">Classificação e rateio por centro de custo</legend>
        <div className="mb-2 flex flex-wrap gap-3 text-sm">
          {([["single", "Uma conta e um centro de custo"], ["template", "Modelo de rateio"], ["manual", "Dividir manualmente"]] as [Mode, string][]).map(([v, l]) => (
            <label key={v} className="flex items-center gap-1.5"><input type="radio" name="mode" checked={mode === v} onChange={() => setMode(v)} /> {l}</label>
          ))}
        </div>
        {mode !== "manual" && (
          <div className="grid gap-2 sm:grid-cols-2">
            <SearchSelect options={accounts} value={account} onChange={setAccount} placeholder="Conta do plano…" emptyLabel="Conta do plano…" ariaLabel="Conta do plano" disabled={locked} />
            {mode === "single" ? (
              <SearchSelect options={costCenters} value={cc} onChange={setCc} placeholder="Centro de custo (opcional)…" emptyLabel="Sem centro de custo" ariaLabel="Centro de custo" disabled={locked} />
            ) : (
              <SearchSelect options={templates} value={template} onChange={setTemplate} placeholder="Modelo de rateio…" ariaLabel="Modelo de rateio" disabled={locked} />
            )}
          </div>
        )}
        {mode === "manual" && (
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_7rem_2rem] gap-2">
                <SearchSelect options={accounts} value={r.account} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, account: v } : x)))} placeholder="Conta…" ariaLabel="Conta" disabled={locked} />
                <SearchSelect options={costCenters} value={r.cc} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, cc: v } : x)))} placeholder="Centro de custo…" emptyLabel="Sem centro de custo" ariaLabel="Centro de custo" disabled={locked} />
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

      {state && !state.ok && <p className="sm:col-span-6 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <div className="sm:col-span-6"><Button disabled={!canSubmit}>{pending ? (edit ? "Salvando…" : "Lançando…") : edit ? "Salvar alterações" : "Lançar"}</Button></div>
    </form>
  );
}
