"use client";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { formatBRL } from "@centralops/domain";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { SearchSelect, type SearchOption } from "@/components/search-select";
import { updateTitleAction } from "../../actions";

const toNum = (s: string) => Number(String(s).replace(/\./g, "").replace(",", ".")) || 0;

export interface EditableTitle {
  id: string; description: string; document_kind: string | null; document_number: string | null; party_id: string | null; competence_date: string;
  chart_account_id: string | null; cost_center_id: string | null; split: boolean;
  installments: { due_date: string; amount: number; barcode: string | null }[];
}

/**
 * Edição do título. `full` = sem baixa e lançado à mão: muda favorecido, competência, classificação e parcelas.
 * Senão só descrição e documento (o vencimento de cada parcela muda na tabela de parcelas).
 */
export function TitleEditForm({ title, full, parties, accounts, costCenters }: {
  title: EditableTitle; full: boolean; parties: SearchOption[]; accounts: SearchOption[]; costCenters: SearchOption[];
}) {
  const { state, pending, formProps } = useKeptForm(updateTitleAction);
  const [description, setDescription] = useState(title.description);
  const [docKind, setDocKind] = useState(title.document_kind ?? "");
  const [docNumber, setDocNumber] = useState(title.document_number ?? "");
  const [party, setParty] = useState(title.party_id ?? "");
  const [competence, setCompetence] = useState(title.competence_date);
  const [account, setAccount] = useState(title.chart_account_id ?? "");
  const [cc, setCc] = useState(title.cost_center_id ?? "");
  const [inst, setInst] = useState(title.installments.map((i) => ({ due_date: i.due_date, amount: i.amount.toFixed(2).replace(".", ","), barcode: i.barcode ?? "" })));
  const total = inst.reduce((a, i) => a + toNum(i.amount), 0);

  const payload = {
    id: title.id, description, document_kind: docKind, document_number: docNumber,
    ...(full ? {
      party_id: party, competence_date: competence,
      ...(!title.split || account !== (title.chart_account_id ?? "") || cc !== (title.cost_center_id ?? "") ? { chart_account_id: account, cost_center_id: cc } : {}),
      installments: inst.map((i) => ({ due_date: i.due_date, amount: toNum(i.amount), ...(i.barcode ? { barcode: i.barcode } : {}) })),
    } : {}),
  };

  return (
    <form {...formProps} className="grid gap-3 sm:grid-cols-6">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      <label className="text-xs text-muted sm:col-span-4">Descrição<input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} /></label>
      <label className="text-xs text-muted">Documento<input className={inputClass} value={docKind} onChange={(e) => setDocKind(e.target.value)} placeholder="NF, boleto…" maxLength={40} /></label>
      <label className="text-xs text-muted">Número<input className={inputClass} value={docNumber} onChange={(e) => setDocNumber(e.target.value)} maxLength={60} /></label>
      {full && (
        <>
          <label className="text-xs text-muted sm:col-span-3">Favorecido<SearchSelect options={parties} value={party} onChange={setParty} emptyLabel="— não informar —" ariaLabel="Favorecido" /></label>
          <label className="text-xs text-muted sm:col-span-3">Competência<input type="date" className={inputClass} value={competence} onChange={(e) => setCompetence(e.target.value)} /></label>
          <label className="text-xs text-muted sm:col-span-3">Conta do plano<SearchSelect options={accounts} value={account} onChange={setAccount} emptyLabel={title.split ? "(manter a divisão atual)" : "Conta do plano…"} ariaLabel="Conta" /></label>
          <label className="text-xs text-muted sm:col-span-3">Centro de custo<SearchSelect options={costCenters} value={cc} onChange={setCc} emptyLabel="Sem centro de custo" ariaLabel="Centro de custo" /></label>
          {title.split && <p className="text-xs text-muted sm:col-span-6">Este título está dividido entre várias contas/centros de custo. Escolher uma conta aqui troca a divisão por uma conta só.</p>}
          <fieldset className="rounded-lg border border-border p-3 sm:col-span-6">
            <legend className="px-1 text-xs font-medium text-muted">Parcelas</legend>
            <div className="space-y-2">
              {inst.map((r, i) => (
                <div key={i} className="grid grid-cols-[2.5rem_9rem_8rem_1fr_2rem] items-center gap-2">
                  <span className="text-xs text-muted">{i + 1}ª</span>
                  <input type="date" className={inputClass} value={r.due_date} onChange={(e) => setInst(inst.map((x, j) => (j === i ? { ...x, due_date: e.target.value } : x)))} aria-label="Vencimento" />
                  <input className={inputClass} inputMode="decimal" value={r.amount} onChange={(e) => setInst(inst.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label="Valor" />
                  <input className={inputClass} value={r.barcode} onChange={(e) => setInst(inst.map((x, j) => (j === i ? { ...x, barcode: e.target.value } : x)))} placeholder="Linha digitável (opcional)" aria-label="Código de barras" />
                  <button type="button" disabled={inst.length === 1} className="rounded p-1 text-muted hover:bg-surface-2 disabled:opacity-30" aria-label="Remover parcela" onClick={() => setInst(inst.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between text-xs">
              <button type="button" className="inline-flex items-center gap-1 text-brand" onClick={() => setInst([...inst, { due_date: inst.at(-1)?.due_date ?? competence, amount: "", barcode: "" }])}><Plus size={14} /> parcela</button>
              <span className="text-muted">Total {formatBRL(total)}</span>
            </div>
          </fieldset>
        </>
      )}
      {state && !state.ok && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger sm:col-span-6">{state.error}</p>}
      <div className="sm:col-span-6"><Button disabled={pending || description.trim().length < 2 || (full && total <= 0)}>{pending ? "Salvando…" : "Salvar alterações"}</Button></div>
    </form>
  );
}
