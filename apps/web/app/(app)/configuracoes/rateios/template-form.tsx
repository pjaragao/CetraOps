"use client";
import { useActionState, useState } from "react";
import { Button, inputClass } from "@/components/ui";
import { createTemplateAction, type State } from "../../financeiro/actions";

const toNum = (s: string) => Number(String(s).replace(",", ".")) || 0;

export function TemplateForm({ costCenters }: { costCenters: { id: string; label: string }[] }) {
  const [state, action, pending] = useActionState<State, FormData>(createTemplateAction, null);
  const [pcts, setPcts] = useState<string[]>(["", "", "", "", "", ""]);
  const sum = pcts.reduce((a, p) => a + toNum(p), 0);
  return (
    <form action={action} className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="text-xs text-muted sm:col-span-1">Nome do modelo<input name="name" required className={inputClass} placeholder="Ex.: Mídia paga 80/20" maxLength={80} /></label>
        <label className="text-xs text-muted sm:col-span-2">Descrição<input name="description" className={inputClass} maxLength={200} /></label>
      </div>
      {pcts.map((p, i) => (
        <div key={i} className="grid grid-cols-[1fr_6rem] gap-2">
          <select name={`cc_${i}`} className={inputClass} aria-label={`Centro de custo ${i + 1}`} defaultValue=""><option value="">— centro de custo {i + 1} —</option>{costCenters.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
          <input name={`pct_${i}`} className={inputClass} inputMode="decimal" placeholder="%" value={p} onChange={(e) => setPcts(pcts.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Percentual ${i + 1}`} />
        </div>
      ))}
      <p className={`text-sm ${Math.abs(sum - 100) < 0.0001 ? "text-success" : "text-muted"}`}>Soma: {sum.toFixed(2).replace(".", ",")}% {Math.abs(sum - 100) < 0.0001 ? "— ok" : "(precisa fechar 100%)"}</p>
      {state && <p className={`rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
      <Button disabled={pending || Math.abs(sum - 100) > 0.0001}>{pending ? "Salvando…" : "Criar modelo"}</Button>
    </form>
  );
}
