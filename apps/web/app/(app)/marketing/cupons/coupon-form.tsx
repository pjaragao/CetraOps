"use client";
import { useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { saveCouponAction } from "../../vender/actions";
import { PartyPicker, type PartyHit } from "../../vender/pickers";

export function CouponForm({ affiliates }: { affiliates: { id: string; label: string }[] }) {
  const { state, pending, formProps } = useKeptForm(saveCouponAction);
  const [owner, setOwner] = useState<PartyHit | null>(null);
  return (
    <form {...formProps} className="grid gap-3 sm:grid-cols-4">
      <Field label="Código"><input name="code" required maxLength={30} className={`${inputClass} uppercase`} placeholder="BEMVINDA10" /></Field>
      <Field label="Tipo"><select name="kind" className={inputClass}><option value="PERCENT">Percentual (%)</option><option value="AMOUNT">Valor fixo (R$)</option></select></Field>
      <Field label="Valor"><input name="value" required inputMode="decimal" className={inputClass} /></Field>
      <Field label="Pedido mínimo (R$)"><input name="min_order" inputMode="decimal" className={inputClass} /></Field>
      <Field label="Usos no total"><input name="max_uses" type="number" min={1} className={inputClass} placeholder="ilimitado" /></Field>
      <Field label="Usos por cliente"><input name="per_customer_limit" type="number" min={1} className={inputClass} placeholder="ilimitado" /></Field>
      <Field label="Válido até"><input name="valid_to" type="date" className={inputClass} /></Field>
      <Field label="Afiliada / trainer (opcional)"><select name="affiliate_party_id" defaultValue="" className={inputClass}><option value="">—</option>{affiliates.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></Field>
      <div className="sm:col-span-2">
        <span className="text-xs text-muted">Exclusivo de uma cliente (opcional)</span>
        <input type="hidden" name="party_id" value={owner?.id ?? ""} />
        {owner ? (
          <p className="mt-1 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><b>{owner.name}</b><span className="text-muted">{owner.phone}</span>
            <button type="button" className="ml-auto text-xs text-brand" onClick={() => setOwner(null)}>remover</button></p>
        ) : <div className="mt-1"><PartyPicker onPick={setOwner} placeholder="Só ela poderá usar este cupom" /></div>}
      </div>
      <div className="sm:col-span-4">
        {state && <p role={state.ok ? "status" : "alert"} className={`mb-2 rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
        <Button disabled={pending}>{pending ? "Salvando…" : "Criar cupom"}</Button>
      </div>
    </form>
  );
}
