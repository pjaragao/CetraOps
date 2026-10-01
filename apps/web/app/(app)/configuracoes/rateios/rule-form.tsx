"use client";
import { useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { createAllocationRuleAction } from "../../financeiro/plan-actions";

export const METHODS: Record<string, { label: string; hint: string }> = {
  REVENUE_SHARE: { label: "Receita líquida", hint: "Cada destino recebe na proporção da receita líquida do mês." },
  GROSS_MARGIN_SHARE: { label: "Margem bruta", hint: "Proporcional à receita líquida menos o CMV do mês." },
  ORDERS_COUNT: { label: "Número de pedidos", hint: "Proporcional aos pedidos (não cancelados) de cada centro de resultado." },
  HEADCOUNT: { label: "Equipe (colaboradores)", hint: "Proporcional aos colaboradores ativos lotados nas lojas de cada centro." },
  AREA_M2: { label: "Área (m²)", hint: "Proporcional à área das lojas ativas de cada centro." },
  FIXED_PCT: { label: "Percentual fixo", hint: "Você define o percentual de cada destino (soma 100%)." },
};

export function RuleForm({ costCenters }: { costCenters: { id: string; label: string }[] }) {
  const { state, pending, formProps } = useKeptForm(createAllocationRuleAction);
  const [method, setMethod] = useState("REVENUE_SHARE");
  return (
    <form {...formProps} className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-muted">Nome da regra<input name="name" required maxLength={80} className={inputClass} placeholder="Ex.: Corporativo por receita" /></label>
        <label className="text-xs text-muted">Base do rateio
          <select name="method" value={method} onChange={(e) => setMethod(e.target.value)} className={inputClass}>{Object.entries(METHODS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
      </div>
      <p className="text-xs text-muted">{METHODS[method].hint}</p>
      <label className="block text-xs text-muted">Centro de custo de origem (o “pool” que será dividido)
        <select name="source" required defaultValue="" className={inputClass}><option value="" disabled>Escolha…</option>{costCenters.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
      <p className="pt-1 text-xs font-medium text-muted">Destinos</p>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className={`grid gap-2 ${method === "FIXED_PCT" ? "grid-cols-[1fr_6rem]" : "grid-cols-1"}`}>
          <select name={`cc_${i}`} defaultValue="" className={inputClass} aria-label={`Destino ${i + 1}`}><option value="">— destino {i + 1} —</option>{costCenters.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
          {method === "FIXED_PCT" && <input name={`pct_${i}`} inputMode="decimal" placeholder="%" className={inputClass} aria-label={`Percentual ${i + 1}`} />}
        </div>
      ))}
      <label className="block text-xs text-muted">Observações<input name="notes" maxLength={300} className={inputClass} /></label>
      {state && <p role={state.ok ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
      <Button disabled={pending}>{pending ? "Salvando…" : "Criar regra"}</Button>
    </form>
  );
}
