import { Lock } from "lucide-react";
import { todayIsoSP } from "@/lib/context";
import { Button, inputClass } from "@/components/ui";
import { createBankAccountAction } from "../../financeiro/actions";
import { updateBankAccountAction } from "./actions";

export const KIND_LABEL: Record<string, string> = { CHECKING: "Conta corrente", CASH_DRAWER: "Caixa (gaveta)", ACQUIRER_BALANCE: "Saldo na adquirente", INVESTMENT: "Aplicação" };

interface Opt { id: string; label: string }
export interface BankAccountValues {
  id: string; name: string; kind: string; legal_entity_id: string; chart_account_id: string | null; bank_code: string | null; agency: string | null;
  number: string | null; pix_keys: string[] | null; store_id: string | null; opening_balance: number; opening_date: string | null; active: boolean;
}

/** Rótulo com cadeado e o motivo quando o campo não muda mais. */
function L({ label, why, className, children }: { label: string; why?: string | false; className?: string; children: React.ReactNode }) {
  return (
    <label className={`text-xs text-muted ${className ?? ""}`}>
      <span className="inline-flex items-center gap-1">{why && <Lock size={10} aria-hidden />}{label}</span>
      {children}
      {why && <span className="mt-0.5 block text-[11px]">{why}</span>}
    </label>
  );
}

/**
 * Conta bancária — o mesmo formulário cria e edita. Depois de criada, tipo, empresa e saldo de abertura não mudam;
 * a conta do plano só muda enquanto não houver movimento (é por ela que as baixas já contabilizaram).
 */
export function BankAccountForm({ account: b, hasMoves = false, entities, accounts, stores }: {
  account?: BankAccountValues; hasMoves?: boolean; entities: Opt[]; accounts: Opt[]; stores: Opt[];
}) {
  const fixed = b ? "Não muda depois de criada" : false;
  return (
    <form action={b ? updateBankAccountAction : createBankAccountAction} className="grid gap-3 sm:grid-cols-6">
      {b && <input type="hidden" name="id" value={b.id} />}
      <L label="Nome" className="sm:col-span-2"><input name="name" required minLength={2} maxLength={80} defaultValue={b?.name} placeholder="Ex.: BTG Pactual Empresas" className={inputClass} /></L>
      <L label="Tipo" why={fixed}>
        <select name="kind" defaultValue={b?.kind ?? "CHECKING"} disabled={!!b} className={inputClass}>{Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </L>
      <L label="Empresa (CNPJ)" why={fixed} className="sm:col-span-2">
        <select name="entity" required defaultValue={b?.legal_entity_id} disabled={!!b} className={inputClass}>{entities.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
      </L>
      <L label="Conta do plano" why={hasMoves && "Já tem movimentos: não muda"}>
        <select name={b ? "chart_account_id" : "account"} required={!b} defaultValue={b?.chart_account_id ?? ""} disabled={hasMoves} className={inputClass}>
          <option value="">…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </L>
      <L label="Banco (código)"><input name="bank_code" defaultValue={b?.bank_code ?? ""} placeholder="077, 208, 323" maxLength={4} className={inputClass} /></L>
      <L label="Agência"><input name="agency" defaultValue={b?.agency ?? ""} maxLength={10} className={inputClass} /></L>
      <L label="Conta"><input name="number" defaultValue={b?.number ?? ""} maxLength={20} className={inputClass} /></L>
      <L label="Loja (caixa)">
        <select name={b ? "store_id" : "store"} defaultValue={b?.store_id ?? ""} className={inputClass}><option value="">—</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
      </L>
      <L label="Chaves Pix (separe por vírgula)" className="sm:col-span-2"><input name="pix_keys" defaultValue={(b?.pix_keys ?? []).join(", ")} className={inputClass} /></L>
      <L label="Saldo de abertura (R$)" why={fixed}>
        <input name="opening" inputMode="decimal" placeholder="0,00" disabled={!!b} defaultValue={b ? b.opening_balance.toFixed(2).replace(".", ",") : undefined} className={inputClass} />
      </L>
      <L label="Data do saldo" why={fixed}><input name="opening_date" type="date" disabled={!!b} defaultValue={b ? (b.opening_date ?? "") : todayIsoSP()} className={inputClass} /></L>
      {b && <label className="flex items-center gap-2 self-end pb-2 text-sm sm:col-span-3"><input type="checkbox" name="active" defaultChecked={b.active} /> Conta ativa (para desativar, o saldo precisa estar zerado)</label>}
      <div className={`self-end ${b ? "sm:col-span-3 sm:text-right" : "sm:col-span-6"}`}><Button>{b ? "Salvar conta" : "Criar conta"}</Button></div>
      {!b && <p className="text-xs text-muted sm:col-span-6">O saldo de abertura entra na conta e deve ser lançado no razão pelo contador (lançamento manual) contra o capital ou o saldo anterior. Tipo, empresa e saldo de abertura não mudam depois de criada.</p>}
    </form>
  );
}
