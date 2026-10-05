"use client";
import { useMemo, useState } from "react";
import type { CnpjData } from "@sie/domain";
import { EDITABLE_ROLES, PARTY_ROLE_LABEL } from "@sie/domain";
import { useKeptForm } from "@/components/use-kept-form";
import { AddressFields, EMPTY_ADDRESS, type Address } from "@/components/address-fields";
import { Button, Card, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { createPartyAction } from "../actions";

const digits = (s: string) => s.replace(/\D/g, "");

/** Novo cadastro de pessoa ou empresa. CNPJ completo preenche razão social e endereço; CEP preenche o endereço. */
export function PartyForm({ company }: { company: boolean }) {
  const { state, pending, formProps } = useKeptForm(createPartyAction);
  const [f, setF] = useState({ name: "", legal: "", cnpj: "", birth: "", gender: "", ig: "", phone: "", phone2: "", email: "", tags: "", notes: "" });
  const [roles, setRoles] = useState<string[]>([company ? "SUPPLIER" : "CUSTOMER"]);
  const [addr, setAddr] = useState<Address>(EMPTY_ADDRESS);
  const [cnpjMsg, setCnpjMsg] = useState<string | null>(null);
  const [registry, setRegistry] = useState<CnpjData | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function lookupCnpj(raw: string) {
    setCnpjMsg(null);
    if (digits(raw).length !== 14) return;
    setCnpjMsg("Buscando…");
    try {
      const r = await fetch(`/api/cnpj/${digits(raw)}`);
      const j = await r.json();
      if (!r.ok) { setCnpjMsg(String(j.error ?? "Não achei esse CNPJ")); return; }
      setF((p) => ({ ...p, legal: j.legal_name || p.legal, name: p.name || j.trade_name || j.legal_name || "", phone: p.phone || (j.phone ? String(j.phone) : ""), phone2: p.phone2 || (j.phone2 ? String(j.phone2) : ""), email: p.email || j.email || "" }));
      setRegistry((j.data as CnpjData) ?? null);
      setAddr((a) => ({ cep: j.cep ? String(j.cep).replace(/^(\d{5})(\d{3})$/, "$1-$2") : a.cep, street: j.street || a.street, number: j.number || a.number, complement: j.complement || a.complement, district: j.district || a.district, city: j.city || a.city, uf: j.uf || a.uf }));
      const d = j.data as CnpjData | undefined;
      const alerta = d && d.situation && d.situation.toLowerCase() !== "ativa" ? ` ATENÇÃO: situação ${d.situation} na Receita.` : "";
      setCnpjMsg(`Preenchido pela Receita (${d?.sources.join(", ") ?? "consulta"})${d?.cnae_main ? `: ${d.cnae_main.description}` : ""}${d?.simples ? " · Simples Nacional" : ""}${d?.mei ? " · MEI" : ""}. Confira os dados.${alerta}`);
    } catch { setCnpjMsg("Consulta indisponível: preencha à mão"); }
  }

  const payload = useMemo(() => ({
    kind: company ? "COMPANY" : "PERSON", display_name: f.name, legal_name: f.legal || undefined, cnpj: company ? f.cnpj : undefined, birth_date: !company && f.birth ? f.birth : undefined,
    gender: !company && f.gender ? f.gender : undefined, instagram_handle: f.ig || undefined, phones: [f.phone, f.phone2].filter(Boolean), emails: f.email ? [f.email] : [], roles,
    tags: f.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean), notes: f.notes || undefined, address: Object.fromEntries(Object.entries(addr).filter(([, v]) => v)),
    registry: company && registry && digits(f.cnpj) === registry.cnpj ? registry : undefined,
  }), [f, roles, addr, company, registry]);
  const ok = f.name.trim().length > 1 && (!company || digits(f.cnpj).length === 14) && roles.length > 0;

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      <Card title={company ? "Empresa" : "Pessoa"}>
        <div className="grid gap-3 sm:grid-cols-6">
          {company && <Field label="CNPJ" className="sm:col-span-2" hint={cnpjMsg ?? "Digite o CNPJ completo para preencher o resto"}>
            <input className={inputClass} value={f.cnpj} inputMode="numeric" placeholder="00.000.000/0000-00" maxLength={18} onChange={(e) => { set("cnpj", e.target.value); if (digits(e.target.value).length === 14) void lookupCnpj(e.target.value); }} />
          </Field>}
          <Field label={company ? "Nome fantasia" : "Nome completo"} className={company ? "sm:col-span-4" : "sm:col-span-3"}><input className={inputClass} value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={120} /></Field>
          {company && <Field label="Razão social" className="sm:col-span-6"><input className={inputClass} value={f.legal} onChange={(e) => set("legal", e.target.value)} maxLength={160} /></Field>}
          {!company && <>
            <Field label="Nascimento" className="sm:col-span-1"><input type="date" className={inputClass} value={f.birth} onChange={(e) => set("birth", e.target.value)} /></Field>
            <Field label="Gênero" className="sm:col-span-1"><select className={inputClass} value={f.gender} onChange={(e) => set("gender", e.target.value)}><option value="">—</option><option value="F">Feminino</option><option value="M">Masculino</option><option value="O">Outro</option></select></Field>
            <Field label="Instagram" className="sm:col-span-1"><input className={inputClass} value={f.ig} onChange={(e) => set("ig", e.target.value)} placeholder="@usuario" /></Field>
          </>}
          <Field label="WhatsApp / telefone" className="sm:col-span-2"><input className={inputClass} value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="(48) 99999-0000" /></Field>
          <Field label="Outro telefone" className="sm:col-span-2"><input className={inputClass} value={f.phone2} onChange={(e) => set("phone2", e.target.value)} /></Field>
          <Field label="E-mail" className="sm:col-span-2"><input className={inputClass} type="email" value={f.email} onChange={(e) => set("email", e.target.value)} /></Field>
        </div>
        <p className="mt-2 text-xs text-muted">Telefone, e-mail e CNPJ não podem estar em dois cadastros: se já existir, o sistema avisa de quem é.</p>
      </Card>
      <Card title="Endereço"><AddressFields value={addr} onChange={setAddr} /></Card>
      <Card title="Papéis e anotações">
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {EDITABLE_ROLES.map((r) => (
            <label key={r} className="flex items-center gap-1.5"><input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />{PARTY_ROLE_LABEL[r]}</label>
          ))}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Etiquetas" hint="Separadas por vírgula, minúsculas"><input className={inputClass} value={f.tags} onChange={(e) => set("tags", e.target.value)} /></Field>
          <Field label="Observações"><input className={inputClass} value={f.notes} onChange={(e) => set("notes", e.target.value)} maxLength={500} /></Field>
        </div>
      </Card>
      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <Button disabled={pending || !ok}>{pending ? "Salvando…" : company ? "Cadastrar empresa" : "Cadastrar pessoa"}</Button>
    </form>
  );
}
