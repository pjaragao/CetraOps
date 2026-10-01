"use client";
import { useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, Card, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { createTerminationAction } from "../../actions";
import { NOTICE_KIND, TERMINATION_KIND } from "../../labels";

const HINT: Record<string, string> = {
  WITHOUT_CAUSE: "Saldo, aviso (indenizado ou trabalhado), 13º e férias proporcionais/vencidas + 1/3, multa de 40% do FGTS e saque do FGTS.",
  RESIGNATION: "Saldo, 13º e férias proporcionais/vencidas + 1/3. Se o aviso não for cumprido, a empresa pode descontar 30 dias. Sem multa nem saque do FGTS.",
  JUST_CAUSE: "Só saldo de salário e férias vencidas + 1/3. Sem 13º proporcional, férias proporcionais, aviso ou multa.",
  MUTUAL_AGREEMENT: "Acordo (art. 484-A): aviso indenizado pela metade, multa de 20% e saque de 80% do FGTS; sem seguro-desemprego.",
  FIXED_TERM_END: "Término do contrato a prazo: saldo, 13º e férias proporcionais + 1/3, sem aviso e sem multa.",
  EXPERIENCE_END: "Término da experiência: mesmas verbas do término de contrato a prazo.",
  DEATH: "Verbas devidas aos dependentes habilitados; o sistema calcula as verbas sem aviso.",
  RETIREMENT: "Saldo, 13º e férias proporcionais/vencidas + 1/3; sem aviso.",
};

export function TerminationForm({ employees, preselected, today }: { employees: { id: string; label: string }[]; preselected?: string; today: string }) {
  const { state, pending, formProps } = useKeptForm(createTerminationAction);
  const [kind, setKind] = useState("WITHOUT_CAUSE");
  const [notice, setNotice] = useState("INDEMNIFIED");
  const usesFine = kind === "WITHOUT_CAUSE" || kind === "MUTUAL_AGREEMENT";
  return (
    <form {...formProps}>
      <Card title="Dados do desligamento">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Colaborador" className="sm:col-span-3"><select name="employee_id" required defaultValue={preselected ?? ""} className={inputClass}><option value="" disabled>Escolha…</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></Field>
          <Field label="Tipo de rescisão"><select name="kind" value={kind} onChange={(e) => { setKind(e.target.value); setNotice(e.target.value === "RESIGNATION" ? "NOT_SERVED" : ["WITHOUT_CAUSE", "MUTUAL_AGREEMENT"].includes(e.target.value) ? "INDEMNIFIED" : "NONE"); }} className={inputClass}>
            {Object.entries(TERMINATION_KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Aviso prévio"><select name="notice_kind" value={notice} onChange={(e) => setNotice(e.target.value)} className={inputClass}>{Object.entries(NOTICE_KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Data do desligamento" hint="Aviso trabalhado: último dia do aviso"><input name="termination_date" type="date" required defaultValue={today} className={inputClass} /></Field>
          <Field label="Dias de aviso (opcional)" hint="Vazio = 30 dias + 3 por ano completo (máx. 90)"><input name="notice_days" type="number" min={0} max={90} className={inputClass} /></Field>
          {usesFine && <Field label="Saldo do FGTS (R$)" hint="Do extrato da Caixa; vazio = estimativa pelos depósitos do sistema"><input name="fgts_balance" inputMode="decimal" className={inputClass} /></Field>}
          <Field label="Motivo / observações" className="sm:col-span-3"><input name="reason" className={inputClass} maxLength={300} /></Field>
        </div>
        <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">{HINT[kind]}</p>
      </Card>
      {state && !state.ok && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <div className="mt-3"><Button disabled={pending}>{pending ? "Calculando…" : "Calcular rescisão"}</Button></div>
      <p className="mt-2 text-xs text-muted">A rescisão é uma prévia para conferência: o contador homologa o TRCT. O pagamento vence em 10 dias corridos (CLT art. 477 §6º).</p>
    </form>
  );
}
