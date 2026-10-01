"use client";
import { useState } from "react";
import { inputClass } from "@/components/ui";
import { Field } from "@/components/form";

export interface Address { cep: string; street: string; number: string; complement: string; district: string; city: string; uf: string }
export const EMPTY_ADDRESS: Address = { cep: "", street: "", number: "", complement: "", district: "", city: "", uf: "" };
const digits = (s: string) => s.replace(/\D/g, "");
const maskCep = (s: string) => { const d = digits(s).slice(0, 8); return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d; };

/** Busca o endereço pelo CEP (rota /api/cep). Devolve null se não achar; `error` explica. */
export async function lookupCep(cep: string): Promise<{ data: Partial<Address> | null; error?: string }> {
  if (digits(cep).length !== 8) return { data: null };
  try {
    const r = await fetch(`/api/cep/${digits(cep)}`);
    const j = await r.json();
    return r.ok ? { data: j as Partial<Address> } : { data: null, error: String(j.error ?? "CEP não encontrado") };
  } catch {
    return { data: null, error: "Consulta de CEP indisponível: preencha à mão" };
  }
}

/**
 * Campos de endereço com preenchimento automático pelo CEP. Controlado (value/onChange) para formulários com estado;
 * com `name` prefixado ("addr_cep", "addr_street"…) também funciona em formulários simples de Server Action.
 */
export function AddressFields({ value, onChange, namePrefix }: { value: Address; onChange: (a: Address) => void; namePrefix?: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = (k: keyof Address) => (namePrefix ? `${namePrefix}${k}` : undefined);
  const set = (k: keyof Address, v: string) => onChange({ ...value, [k]: v });

  async function find(raw: string) {
    setMsg(null);
    if (digits(raw).length !== 8) return;
    setBusy(true);
    const r = await lookupCep(raw);
    setBusy(false);
    if (r.data) onChange({ ...value, cep: maskCep(raw), street: r.data.street ?? "", district: r.data.district ?? "", city: r.data.city ?? "", uf: (r.data.uf ?? "").toUpperCase() });
    else if (r.error) setMsg(r.error);
  }

  return (
    <div className="grid gap-3 sm:grid-cols-6">
      <Field label="CEP" className="sm:col-span-1" hint={busy ? "Buscando…" : msg ?? "Preenche o endereço"}>
        <input className={inputClass} name={n("cep")} value={value.cep} inputMode="numeric" autoComplete="postal-code" placeholder="00000-000" maxLength={9}
          onChange={(e) => { const m = maskCep(e.target.value); set("cep", m); if (digits(m).length === 8) void find(m); }} />
      </Field>
      <Field label="Logradouro" className="sm:col-span-3"><input className={inputClass} name={n("street")} value={value.street} onChange={(e) => set("street", e.target.value)} autoComplete="address-line1" /></Field>
      <Field label="Número" className="sm:col-span-1"><input className={inputClass} name={n("number")} value={value.number} onChange={(e) => set("number", e.target.value)} /></Field>
      <Field label="Complemento" className="sm:col-span-1"><input className={inputClass} name={n("complement")} value={value.complement} onChange={(e) => set("complement", e.target.value)} /></Field>
      <Field label="Bairro" className="sm:col-span-2"><input className={inputClass} name={n("district")} value={value.district} onChange={(e) => set("district", e.target.value)} /></Field>
      <Field label="Cidade" className="sm:col-span-3"><input className={inputClass} name={n("city")} value={value.city} onChange={(e) => set("city", e.target.value)} /></Field>
      <Field label="UF" className="sm:col-span-1"><input className={inputClass} name={n("uf")} value={value.uf} maxLength={2} onChange={(e) => set("uf", e.target.value.toUpperCase().slice(0, 2))} /></Field>
    </div>
  );
}
