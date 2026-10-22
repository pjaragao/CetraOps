"use client";
import { useRef, useState, useTransition } from "react";
import { Camera, Lock, Undo2, X } from "lucide-react";
import type { CnpjData } from "@centralops/domain";
import { EDITABLE_ROLES, PARTY_ROLE_LABEL, validCpf } from "@centralops/domain";
import type { ReadDocument } from "@/lib/central/codes";
import { useKeptForm } from "@/components/use-kept-form";
import { AddressFields, EMPTY_ADDRESS, type Address } from "@/components/address-fields";
import { Button, Card, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { createPartyAction, revealCpfAction, updatePartyAction } from "../actions";

const digits = (s: string) => s.replace(/\D/g, "");

const CONTACT_LABEL: Record<string, string> = { PHONE: "Telefone", WHATSAPP: "WhatsApp", EMAIL: "E-mail", INSTAGRAM: "Instagram", TELEGRAM: "Telegram", TIKTOK: "TikTok" };
const fmtCnpj = (c: string) => c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

/** Cadastro já existente, para o mesmo formulário abrir em modo edição. */
export interface PartyEdit {
  id: string; display_name: string; legal_name: string | null; cnpj: string | null; ie: string | null; birth_date: string | null; gender: string | null;
  instagram_handle: string | null; tags: string[]; notes: string; roles: string[];
  cpfMasked: string | null; canSensitive: boolean;
  contacts: { id: string; type: string; value_display: string; is_primary: boolean }[];
  /** endereço principal (os outros ficam na lista da ficha) */
  address: (Address & { id: string; label: string | null }) | null;
}

/**
 * Cadastro de pessoa ou empresa — o mesmo formulário cria e edita. CNPJ completo preenche razão social e endereço; CEP preenche o endereço;
 * a foto do RG/CNH/CIN (ou do comprovante de endereço) preenche nome, CPF, nascimento e endereço pela leitura da Central — a pessoa confere antes de salvar.
 * Na edição: os contatos atuais aparecem com "remover" e os campos de telefone/e-mail acrescentam; o endereço é o principal;
 * o CPF já gravado só troca com a permissão de dados sensíveis; papéis que vêm de outra rotina (colaboradora, banco…) ficam travados.
 */
export function PartyForm({ company, canReadDocs = false, edit, readOnly = false }: { company: boolean; canReadDocs?: boolean; edit?: PartyEdit; readOnly?: boolean }) {
  const { state, pending, formProps } = useKeptForm(edit ? updatePartyAction : createPartyAction);
  const e0 = edit;
  const [f, setF] = useState({
    name: e0?.display_name ?? "", legal: e0?.legal_name ?? "", cnpj: e0?.cnpj ? fmtCnpj(e0.cnpj) : "", ie: e0?.ie ?? "", cpf: "", birth: e0?.birth_date ?? "", gender: e0?.gender ?? "",
    ig: e0?.instagram_handle ? `@${e0.instagram_handle}` : "", phone: "", phone2: "", email: "", tags: (e0?.tags ?? []).join(", "), notes: e0?.notes ?? "",
  });
  const [docMsg, setDocMsg] = useState<string | null>(null);
  const docInput = useRef<HTMLInputElement>(null);
  const fixedRoles = (e0?.roles ?? []).filter((r) => !(EDITABLE_ROLES as readonly string[]).includes(r));   // colaboradora, banco…: vêm de outra rotina
  const roles0 = e0 ? e0.roles.filter((r) => (EDITABLE_ROLES as readonly string[]).includes(r)) : [company ? "SUPPLIER" : "CUSTOMER"];
  const [roles, setRoles] = useState<string[]>(roles0);
  const [addr, setAddr] = useState<Address>(e0?.address ? { cep: e0.address.cep, street: e0.address.street, number: e0.address.number, complement: e0.address.complement, district: e0.address.district, city: e0.address.city, uf: e0.address.uf } : EMPTY_ADDRESS);
  const [removed, setRemoved] = useState<Set<string>>(new Set());   // contatos atuais marcados para sair
  const [phoneType, setPhoneType] = useState("WHATSAPP");
  const [primary, setPrimary] = useState(false);
  const [cpfShown, setCpfShown] = useState<string | null>(null);
  const [revealing, startReveal] = useTransition();
  const cpfLocked = !!e0?.cpfMasked && !e0.canSensitive;
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
      const regs = ((j.data as CnpjData | undefined)?.state_registrations ?? []).filter((r) => r.active);   // IE ativa, da UF do endereço primeiro
      const ie = (regs.find((r) => r.uf === j.uf) ?? regs[0])?.ie;
      if (ie) setF((p) => ({ ...p, ie: p.ie || ie }));
      setAddr((a) => ({ cep: j.cep ? String(j.cep).replace(/^(\d{5})(\d{3})$/, "$1-$2") : a.cep, street: j.street || a.street, number: j.number || a.number, complement: j.complement || a.complement, district: j.district || a.district, city: j.city || a.city, uf: j.uf || a.uf }));
      const d = j.data as CnpjData | undefined;
      const alerta = d && d.situation && d.situation.toLowerCase() !== "ativa" ? ` ATENÇÃO: situação ${d.situation} na Receita.` : "";
      setCnpjMsg(`Preenchido pela Receita (${d?.sources.join(", ") ?? "consulta"})${d?.cnae_main ? `: ${d.cnae_main.description}` : ""}${d?.simples ? " · Simples Nacional" : ""}${d?.mei ? " · MEI" : ""}. Confira os dados.${alerta}`);
    } catch { setCnpjMsg("Consulta indisponível: preencha à mão"); }
  }

  async function readDocument(file: File | undefined) {
    if (!file) return;
    setDocMsg("Lendo o documento…");
    const form = new FormData();
    form.set("file", file);
    try {
      const r = await fetch("/api/central/ler", { method: "POST", body: form });
      const j = (await r.json()) as { document?: ReadDocument; error?: string };
      const d = j.document;
      if (!d) { setDocMsg(j.error ?? "Não consegui ler o documento."); return; }
      const v = (k: string) => (typeof d.fields[k] === "string" ? (d.fields[k] as string) : "");
      if (d.kind === "identidade") {
        setF((p) => ({ ...p, name: v("nome") || p.name, cpf: v("cpf") ? v("cpf").replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : p.cpf, birth: v("data_nascimento") || p.birth }));
        setDocMsg(`Preenchido pela leitura do ${v("documento_tipo") || "documento"}. Confira antes de salvar.${d.checks.length ? ` ${d.checks.join(" ")}` : ""}`);
      } else if (d.kind === "comprovante_endereco") {
        setAddr((a) => ({ cep: v("cep") ? v("cep").replace(/^(\d{5})(\d{3})$/, "$1-$2") : a.cep, street: v("logradouro") || a.street, number: v("numero") || a.number, complement: v("complemento") || a.complement,
                          district: v("bairro") || a.district, city: v("cidade") || a.city, uf: v("uf") || a.uf }));
        setDocMsg("Endereço preenchido pelo comprovante. Confira antes de salvar.");
      } else setDocMsg("Isto não parece um documento de identidade nem um comprovante de endereço.");
    } catch { setDocMsg("Leitura indisponível: preencha à mão."); }
    finally { if (docInput.current) docInput.current.value = ""; }
  }

  const cpfDigits = digits(f.cpf);
  const cpfBad = !company && cpfDigits.length > 0 && !validCpf(cpfDigits);

  const roleChanged = !e0 || roles.length !== roles0.length || roles.some((r) => !roles0.includes(r));
  const newContacts = [
    ...[f.phone, ...(e0 ? [] : [f.phone2])].filter((v) => v.trim()).map((value) => ({ type: e0 ? phoneType : "WHATSAPP", value, primary: !!e0 && primary })),
    ...(f.email.trim() ? [{ type: "EMAIL", value: f.email.trim(), primary: !!e0 && primary }] : []),
  ];
  const payload = e0 ? {
    id: e0.id, kind: company ? "COMPANY" : "PERSON", display_name: f.name, legal_name: company ? f.legal : undefined, cnpj: company && digits(f.cnpj) ? digits(f.cnpj) : undefined,
    ie: company ? f.ie.trim() : undefined, birth_date: company ? undefined : f.birth, gender: company ? undefined : f.gender,
    instagram_handle: f.ig, tags: f.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean), notes: f.notes,
    roles: roleChanged ? roles : undefined, cpf: !company && !cpfLocked && digits(f.cpf).length === 11 ? digits(f.cpf) : undefined,
    add_contacts: newContacts, remove_contacts: [...removed],
    address: Object.values(addr).some(Boolean) ? { ...addr, id: e0.address?.id, label: e0.address?.label ?? undefined } : undefined,
    registry: company && registry && digits(f.cnpj) === registry.cnpj ? registry : undefined,
  } : {
    kind: company ? "COMPANY" : "PERSON", display_name: f.name, legal_name: f.legal || undefined, cnpj: company ? f.cnpj : undefined, birth_date: !company && f.birth ? f.birth : undefined,
    gender: !company && f.gender ? f.gender : undefined, instagram_handle: f.ig || undefined, phones: [f.phone, f.phone2].filter(Boolean), emails: f.email ? [f.email] : [], roles,
    tags: f.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean), notes: f.notes || undefined, address: Object.fromEntries(Object.entries(addr).filter(([, v]) => v)),
    registry: company && registry && digits(f.cnpj) === registry.cnpj ? registry : undefined,
    cpf: !company && digits(f.cpf).length === 11 ? digits(f.cpf) : undefined,
    ie: company && f.ie.trim() ? f.ie.trim() : undefined,
  };
  const ok = f.name.trim().length > 1 && (!company || digits(f.cnpj).length === 14 || (!!e0 && !e0.cnpj && !f.cnpj.trim())) && (roles.length > 0 || fixedRoles.length > 0) && !cpfBad;
  const reveal = () => startReveal(async () => {
    const fd = new FormData();
    fd.set("id", e0!.id);
    const r = await revealCpfAction(null, fd);
    setCpfShown(r?.ok ? r.message ?? null : r?.error ?? "Não consegui abrir o CPF");
  });

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      <fieldset disabled={readOnly} className="space-y-4">
      <Card title={company ? "Empresa" : "Pessoa"} action={!company && canReadDocs ? (
        <>
          <Button type="button" variant="secondary" onClick={() => docInput.current?.click()} title="Foto ou PDF do RG, CNH, CIN ou comprovante de endereço">
            <Camera size={15} /> Preencher com foto do documento
          </Button>
          <input ref={docInput} type="file" accept="image/*,application/pdf" className="hidden" aria-label="Foto do documento" onChange={(e) => void readDocument(e.target.files?.[0])} />
        </>
      ) : undefined}>
        {docMsg && <p className="mb-3 rounded-lg bg-info/10 px-3 py-2 text-xs text-info" role="status">{docMsg} A imagem não é guardada.</p>}
        <div className="grid gap-3 sm:grid-cols-6">
          {company && <Field label="CNPJ" className="sm:col-span-2" hint={cnpjMsg ?? (e0 ? "Trocar o CNPJ busca os dados da Receita de novo" : "Digite o CNPJ completo para preencher o resto")}>
            <input className={inputClass} value={f.cnpj} inputMode="numeric" placeholder="00.000.000/0000-00" maxLength={18} onChange={(e) => { set("cnpj", e.target.value); if (digits(e.target.value).length === 14 && digits(e.target.value) !== (e0?.cnpj ?? "")) void lookupCnpj(e.target.value); }} />
          </Field>}
          <Field label={company ? "Nome fantasia" : "Nome completo"} className={company ? "sm:col-span-4" : "sm:col-span-3"}><input className={inputClass} value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={120} /></Field>
          {company && <>
            <Field label="Razão social" className="sm:col-span-4"><input className={inputClass} value={f.legal} onChange={(e) => set("legal", e.target.value)} maxLength={160} /></Field>
            <Field label="Inscrição estadual" className="sm:col-span-2" hint="Só números, ou ISENTO"><input className={inputClass} value={f.ie} onChange={(e) => set("ie", e.target.value)} maxLength={20} /></Field>
          </>}
          {!company && <>
            <Field label={e0?.cpfMasked ? "Trocar CPF" : "CPF"} className="sm:col-span-2" hint={cpfBad ? "CPF inválido: confira os dígitos"
              : cpfLocked ? `Atual ${e0!.cpfMasked}. Trocar um CPF já cadastrado exige a permissão de dados sensíveis`
              : e0?.cpfMasked ? `Atual ${cpfShown ?? e0.cpfMasked}. Deixe em branco para manter`
              : "Opcional. Fica criptografado; aparece só o final"}>
              <span className="flex items-center gap-1">
                {cpfLocked && <Lock size={12} className="shrink-0 text-muted" aria-hidden />}
                <input className={inputClass} value={f.cpf} inputMode="numeric" placeholder="000.000.000-00" maxLength={14} autoComplete="off" disabled={cpfLocked} onChange={(e) => set("cpf", e.target.value)} aria-invalid={cpfBad} />
              </span>
              {e0?.cpfMasked && e0.canSensitive && !cpfShown && <button type="button" onClick={reveal} disabled={revealing} className="mt-0.5 text-[11px] text-brand">{revealing ? "Abrindo…" : "Ver CPF completo (fica registrado)"}</button>}
            </Field>
            <Field label="Nascimento" className="sm:col-span-1"><input type="date" className={inputClass} value={f.birth} onChange={(e) => set("birth", e.target.value)} /></Field>
            <Field label="Gênero" className="sm:col-span-1"><select className={inputClass} value={f.gender} onChange={(e) => set("gender", e.target.value)}><option value="">—</option><option value="F">Feminino</option><option value="M">Masculino</option><option value="O">Outro</option></select></Field>
            <Field label="Instagram" className="sm:col-span-1"><input className={inputClass} value={f.ig} onChange={(e) => set("ig", e.target.value)} placeholder="@usuario" /></Field>
          </>}
          {e0 && (
            <div className="sm:col-span-6">
              <p className="mb-1 text-xs text-muted">Contatos</p>
              {e0.contacts.length === 0 ? <p className="text-sm text-muted">Nenhum contato ainda.</p> : (
                <ul className="flex flex-wrap gap-2">{e0.contacts.map((c) => {
                  const out = removed.has(c.id);
                  return (
                    <li key={c.id} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm ${out ? "border-danger/40 text-muted line-through" : "border-border"}`}>
                      <span className="text-xs text-muted">{CONTACT_LABEL[c.type] ?? c.type}</span> {c.value_display}{c.is_primary && !out && <span className="text-[10px] font-medium text-brand">principal</span>}
                      <button type="button" onClick={() => setRemoved((r) => { const n = new Set(r); if (out) n.delete(c.id); else n.add(c.id); return n; })}
                        aria-label={out ? `Manter ${c.value_display}` : `Remover ${c.value_display}`} className="text-muted hover:text-danger">{out ? <Undo2 size={13} /> : <X size={13} />}</button>
                    </li>
                  );
                })}</ul>
              )}
              {removed.size > 0 && <p className="mt-1 text-[11px] text-danger">{removed.size} contato(s) sai(em) ao salvar.</p>}
            </div>
          )}
          {e0 ? (
            <>
              <Field label="Acrescentar telefone" className="sm:col-span-3">
                <span className="flex gap-2">
                  <select className={`${inputClass} w-32`} value={phoneType} onChange={(e) => setPhoneType(e.target.value)} aria-label="Tipo do telefone"><option value="WHATSAPP">WhatsApp</option><option value="PHONE">Telefone</option></select>
                  <input className={inputClass} value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="(48) 99999-0000" aria-label="Acrescentar telefone" />
                </span>
              </Field>
              <Field label="Acrescentar e-mail" className="sm:col-span-2"><input className={inputClass} type="email" value={f.email} onChange={(e) => set("email", e.target.value)} /></Field>
              <label className="flex items-center gap-1.5 self-end pb-2 text-xs sm:col-span-1"><input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} /> como principal</label>
            </>
          ) : (
            <>
              <Field label="WhatsApp / telefone" className="sm:col-span-2"><input className={inputClass} value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="(48) 99999-0000" /></Field>
              <Field label="Outro telefone" className="sm:col-span-2"><input className={inputClass} value={f.phone2} onChange={(e) => set("phone2", e.target.value)} /></Field>
              <Field label="E-mail" className="sm:col-span-2"><input className={inputClass} type="email" value={f.email} onChange={(e) => set("email", e.target.value)} /></Field>
            </>
          )}
        </div>
        <p className="mt-2 text-xs text-muted">Telefone, e-mail e CNPJ não podem estar em dois cadastros: se já existir, o sistema avisa de quem é.</p>
      </Card>
      <Card title={e0 ? "Endereço principal" : "Endereço"}><AddressFields value={addr} onChange={setAddr} /></Card>
      <Card title="Papéis e anotações">
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {EDITABLE_ROLES.map((r) => (
            <label key={r} className="flex items-center gap-1.5"><input type="checkbox" name="roles" value={r} checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />{PARTY_ROLE_LABEL[r]}</label>
          ))}
          {fixedRoles.map((r) => (
            <label key={r} className="flex items-center gap-1.5 text-muted" title="Vem de outra rotina (admissão, cadastro do banco/adquirente): não muda aqui"><input type="checkbox" checked disabled /><Lock size={11} aria-hidden />{PARTY_ROLE_LABEL[r] ?? r}</label>
          ))}
        </div>
        {roles.includes("SHAREHOLDER") && <p className="mt-2 text-xs text-muted">Sócio(a) da empresa é o vínculo societário (pró-labore, distribuição de lucros). Não dá acesso ao sistema: o acesso fica no quadro “Acesso ao sistema”.</p>}
        {fixedRoles.includes("EMPLOYEE") && <p className="mt-2 text-xs text-muted">Colaboradora (RH) vem da admissão e não se altera aqui.</p>}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Etiquetas" hint="Separadas por vírgula, minúsculas"><input className={inputClass} value={f.tags} onChange={(e) => set("tags", e.target.value)} /></Field>
          <Field label="Observações"><input className={inputClass} value={f.notes} onChange={(e) => set("notes", e.target.value)} maxLength={500} /></Field>
        </div>
      </Card>
      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      </fieldset>
      {!readOnly && <Button disabled={pending || !ok}>{pending ? "Salvando…" : e0 ? "Salvar cadastro" : company ? "Cadastrar empresa" : "Cadastrar pessoa"}</Button>}
    </form>
  );
}
