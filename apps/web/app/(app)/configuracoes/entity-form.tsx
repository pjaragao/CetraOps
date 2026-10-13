"use client";
import { useState } from "react";
import { AddressFields, EMPTY_ADDRESS, type Address } from "@/components/address-fields";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";

const digits = (s: string) => s.replace(/\D/g, "");

export interface EntityData {
  id: string; cnpj: string; razao_social: string; nome_fantasia: string | null; ie: string | null; crt: number | null;
  address: Partial<Address> & { ibge?: string } | null;
}

/** CNPJ do grupo. Novo: o CNPJ completo preenche razão social, fantasia e endereço (Receita via BrasilAPI); o CEP também preenche o endereço.
 * Edição (`entity`): o CNPJ fica fixo e o resto pode ser corrigido (IE, regime, endereço e código IBGE, usados na NFC-e). */
export function EntityForm({ action, entity }: { action: (formData: FormData) => void | Promise<void>; entity?: EntityData }) {
  const [f, setF] = useState({ cnpj: entity?.cnpj ?? "", razao: entity?.razao_social ?? "", fantasia: entity?.nome_fantasia ?? "", ie: entity?.ie ?? "", cnae: "", cnaes: "",
    ibge: entity?.address?.ibge ?? "", crt: String(entity?.crt ?? 1) });
  const [addr, setAddr] = useState<Address>({ ...EMPTY_ADDRESS, ...Object.fromEntries(Object.entries(entity?.address ?? {}).filter(([k]) => k in EMPTY_ADDRESS)) });
  const [msg, setMsg] = useState<string | null>(null);

  async function lookup(raw: string) {
    if (digits(raw).length !== 14) return;
    setMsg("Buscando…");
    try {
      const r = await fetch(`/api/cnpj/${digits(raw)}`);
      const j = await r.json();
      if (!r.ok) { setMsg(String(j.error ?? "Não achei esse CNPJ")); return; }
      setF((p) => ({ ...p, razao: j.legal_name || p.razao, fantasia: j.trade_name || p.fantasia, ie: p.ie || j.ie || "", cnae: j.cnae || "", cnaes: Array.isArray(j.cnaes_secondary) ? j.cnaes_secondary.join(",") : "" }));
      setAddr((a) => ({ cep: j.cep ? String(j.cep).replace(/^(\d{5})(\d{3})$/, "$1-$2") : a.cep, street: j.street || a.street, number: j.number || a.number, complement: j.complement || a.complement, district: j.district || a.district, city: j.city || a.city, uf: j.uf || a.uf }));
      setMsg(`Preenchido pela Receita${j.situation ? ` (situação: ${j.situation})` : ""}. Confira.`);
    } catch { setMsg("Consulta indisponível: preencha à mão"); }
  }

  return (
    <form action={action} className="mt-2 space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {entity ? (
          <Field label="CNPJ" hint="O CNPJ não muda; para outro CNPJ, adicione uma nova empresa">
            <input type="hidden" name="id" value={entity.id} />
            <input className={inputClass} value={entity.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")} readOnly disabled />
          </Field>
        ) : (
          <Field label="CNPJ" hint={msg ?? "Digite completo para preencher o resto"}>
            <input name="cnpj" required className={inputClass} value={f.cnpj} inputMode="numeric" maxLength={18} placeholder="00.000.000/0000-00" onChange={(e) => { setF({ ...f, cnpj: e.target.value }); void lookup(e.target.value); }} />
          </Field>
        )}
        <Field label="Inscrição estadual" hint={f.ie && !entity ? "Preenchida pela consulta (CNPJ.ws); confira" : "Só números, como no cadastro da SEFAZ (sai na NFC-e)"}><input name="ie" className={inputClass} value={f.ie} inputMode="numeric" onChange={(e) => setF({ ...f, ie: e.target.value })} /></Field>
        <input type="hidden" name="cnae" value={f.cnae} /><input type="hidden" name="cnaes" value={f.cnaes} />
        <Field label="Razão social"><input name="razao_social" required className={inputClass} value={f.razao} onChange={(e) => setF({ ...f, razao: e.target.value })} /></Field>
        <Field label="Nome fantasia"><input name="nome_fantasia" className={inputClass} value={f.fantasia} onChange={(e) => setF({ ...f, fantasia: e.target.value })} /></Field>
      </div>
      <AddressFields value={addr} onChange={setAddr} namePrefix="addr_" />
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Código IBGE do município" hint="7 dígitos (Florianópolis: 4205407). Usado na NFC-e">
          <input name="addr_ibge" className={inputClass} value={f.ibge} inputMode="numeric" maxLength={7} onChange={(e) => setF({ ...f, ibge: digits(e.target.value) })} />
        </Field>
        <Field label="Regime tributário (CRT)">
          <select name="crt" className={inputClass} value={f.crt} onChange={(e) => setF({ ...f, crt: e.target.value })}>
            <option value="1">Simples Nacional</option>
            <option value="4">Simples Nacional – MEI</option>
            <option value="2">Simples Nacional – excesso de sublimite</option>
            <option value="3">Regime normal (Lucro Presumido/Real)</option>
          </select>
        </Field>
      </div>
      <Button className="w-fit">Salvar</Button>
    </form>
  );
}
