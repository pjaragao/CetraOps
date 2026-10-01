"use client";
import { useState } from "react";
import { AddressFields, EMPTY_ADDRESS, type Address } from "@/components/address-fields";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";

const digits = (s: string) => s.replace(/\D/g, "");

/** Novo CNPJ do grupo: o CNPJ completo preenche razão social, fantasia e endereço (Receita via BrasilAPI); o CEP também preenche o endereço. */
export function EntityForm({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  const [f, setF] = useState({ cnpj: "", razao: "", fantasia: "" });
  const [addr, setAddr] = useState<Address>(EMPTY_ADDRESS);
  const [msg, setMsg] = useState<string | null>(null);

  async function lookup(raw: string) {
    if (digits(raw).length !== 14) return;
    setMsg("Buscando…");
    try {
      const r = await fetch(`/api/cnpj/${digits(raw)}`);
      const j = await r.json();
      if (!r.ok) { setMsg(String(j.error ?? "Não achei esse CNPJ")); return; }
      setF((p) => ({ ...p, razao: j.legal_name || p.razao, fantasia: j.trade_name || p.fantasia }));
      setAddr((a) => ({ cep: j.cep ? String(j.cep).replace(/^(\d{5})(\d{3})$/, "$1-$2") : a.cep, street: j.street || a.street, number: j.number || a.number, complement: j.complement || a.complement, district: j.district || a.district, city: j.city || a.city, uf: j.uf || a.uf }));
      setMsg(`Preenchido pela Receita${j.situation ? ` (situação: ${j.situation})` : ""}. Confira.`);
    } catch { setMsg("Consulta indisponível: preencha à mão"); }
  }

  return (
    <form action={action} className="mt-2 space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="CNPJ" hint={msg ?? "Digite completo para preencher o resto"}>
          <input name="cnpj" required className={inputClass} value={f.cnpj} inputMode="numeric" maxLength={18} placeholder="00.000.000/0000-00" onChange={(e) => { setF({ ...f, cnpj: e.target.value }); void lookup(e.target.value); }} />
        </Field>
        <Field label="Inscrição estadual"><input name="ie" className={inputClass} /></Field>
        <Field label="Razão social"><input name="razao_social" required className={inputClass} value={f.razao} onChange={(e) => setF({ ...f, razao: e.target.value })} /></Field>
        <Field label="Nome fantasia"><input name="nome_fantasia" className={inputClass} value={f.fantasia} onChange={(e) => setF({ ...f, fantasia: e.target.value })} /></Field>
      </div>
      <AddressFields value={addr} onChange={setAddr} namePrefix="addr_" />
      <Button className="w-fit">Salvar</Button>
    </form>
  );
}
