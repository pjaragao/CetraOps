"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { X } from "lucide-react";
import { validCpf } from "@centralops/domain";
import { lookupCep } from "@/components/address-fields";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { quickCreateCustomer } from "../actions";
import type { PartyHit } from "../pickers";

const digits = (s: string) => s.replace(/\D/g, "");
const maskCpf = (s: string) => digits(s).slice(0, 11).replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2");
const maskPhone = (s: string) => digits(s).slice(0, 11).replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d{1,4})$/, "$1-$2");
const maskCep = (s: string) => { const d = digits(s).slice(0, 8); return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d; };
const EMPTY = { name: "", phone: "", cpf: "", birth: "", email: "", cep: "", street: "", number: "", complement: "", district: "", city: "", uf: "" };

/** Janela de cadastro rápido de cliente, sem sair da venda. O CEP preenche o endereço; a pessoa só confirma número e complemento. */
export function QuickCustomerDialog({ onCreated, onClose }: { onCreated: (p: PartyHit) => void; onClose: () => void }) {
  const [f, setF] = useState(EMPTY);
  const [cepMsg, setCepMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const numberRef = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof EMPTY, v: string) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cpfBad = digits(f.cpf).length > 0 && !validCpf(digits(f.cpf));
  const emailBad = f.email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim());
  const ok = f.name.trim().length > 1 && digits(f.phone).length >= 10 && !cpfBad && !emailBad;

  async function onCep(v: string) {
    const m = maskCep(v);
    set("cep", m);
    setCepMsg(null);
    if (digits(m).length !== 8) return;
    setCepMsg("Buscando…");
    const r = await lookupCep(m);
    if (r.data) {
      setF((p) => ({ ...p, cep: m, street: r.data?.street ?? "", district: r.data?.district ?? "", city: r.data?.city ?? "", uf: (r.data?.uf ?? "").toUpperCase() }));
      setCepMsg(null);
      numberRef.current?.focus();
    } else setCepMsg(r.error ?? "CEP não encontrado");
  }

  const save = () => start(async () => {
    setError(null);
    const address = Object.fromEntries(Object.entries({ cep: f.cep, street: f.street, number: f.number, complement: f.complement, district: f.district, city: f.city, uf: f.uf }).filter(([, v]) => v.trim()));
    const r = await quickCreateCustomer({
      name: f.name, phone: f.phone, cpf: digits(f.cpf).length === 11 ? digits(f.cpf) : undefined, birth_date: f.birth || undefined,
      email: f.email.trim() || undefined, address,
    });
    if (!r.ok) { setError(r.error); return; }
    onCreated(r.party);
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Cadastrar cliente">
      <form onSubmit={(e) => { e.preventDefault(); if (ok && !pending) save(); }} className="max-h-full w-full max-w-lg overflow-auto rounded-t-2xl bg-surface p-4 shadow-xl sm:rounded-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Cadastrar cliente</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-surface-2" aria-label="Fechar"><X size={18} /></button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nome *" className="sm:col-span-2"><input autoFocus className={inputClass} value={f.name} onChange={(e) => set("name", e.target.value)} autoComplete="off" /></Field>
          <Field label="Celular (WhatsApp) *"><input className={inputClass} inputMode="tel" placeholder="(00) 00000-0000" value={f.phone} onChange={(e) => set("phone", maskPhone(e.target.value))} /></Field>
          <Field label="CPF" hint={cpfBad ? "CPF inválido" : undefined}><input className={inputClass} inputMode="numeric" placeholder="000.000.000-00" value={f.cpf} onChange={(e) => set("cpf", maskCpf(e.target.value))} aria-invalid={cpfBad} /></Field>
          <Field label="Data de nascimento"><input type="date" className={inputClass} value={f.birth} max={new Date().toISOString().slice(0, 10)} onChange={(e) => set("birth", e.target.value)} /></Field>
          <Field label="E-mail" hint={emailBad ? "E-mail inválido" : undefined}><input type="email" className={inputClass} value={f.email} onChange={(e) => set("email", e.target.value)} autoComplete="off" /></Field>
          <Field label="CEP" hint={cepMsg ?? "Preenche o endereço"}><input className={inputClass} inputMode="numeric" placeholder="00000-000" maxLength={9} value={f.cep} onChange={(e) => void onCep(e.target.value)} /></Field>
          {f.street && (
            <>
              <p className="self-end pb-2 text-xs text-muted">{f.street}{f.district ? `, ${f.district}` : ""} · {f.city}/{f.uf}</p>
              <Field label="Número"><input ref={numberRef} className={inputClass} value={f.number} onChange={(e) => set("number", e.target.value)} /></Field>
              <Field label="Complemento"><input className={inputClass} value={f.complement} onChange={(e) => set("complement", e.target.value)} /></Field>
            </>
          )}
        </div>
        {error && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={!ok || pending}>{pending ? "Salvando…" : "Cadastrar e usar na venda"}</Button>
        </div>
      </form>
    </div>
  );
}
