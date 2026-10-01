"use client";
import { useMemo, useState } from "react";
import { useKeptForm } from "@/components/use-kept-form";
import { Plus, Trash2 } from "lucide-react";
import { Button, Card, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { createEmployeeAction } from "../actions";

interface Opt { id: string; label: string }
const toNum = (s: string) => Number(String(s).replace(/\./g, "").replace(",", ".")) || 0;

/** Admissão: dados pessoais (sensíveis ficam separados), contrato, remuneração, pagamento, dependentes e benefícios iniciais. */
export function AdmissionForm({ entities, stores, today }: { entities: Opt[]; stores: (Opt & { legal_entity_id: string })[]; today: string }) {
  const { state, pending, formProps } = useKeptForm(createEmployeeAction);
  const [f, setF] = useState({
    entity: entities[0]?.id ?? "", store: stores[0]?.id ?? "", name: "", cpf: "", birth: "", phone: "", email: "", pis: "", ctps: "", rg: "", mother: "", marital: "",
    contract: "CLT", job: "", cbo: "", dept: "", hire: today, exp: "45+45", salary: "", unit: "MONTH", regime: "6X1", weekly: "44",
    commissioned: false, trackTime: false, timeBank: false, fgts: true,
    bank: "", agency: "", account: "", pix: "", cep: "", street: "", number: "", district: "", city: "", uf: "SC", vt: "", vr: "",
  });
  const [deps, setDeps] = useState<{ name: string; birth: string; irrf: boolean; fam: boolean }[]>([]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const entityStores = stores.filter((s) => s.legal_entity_id === f.entity);

  const payload = useMemo(() => ({
    legal_entity_id: f.entity, store_id: f.store || undefined, name: f.name, cpf: f.cpf, birth_date: f.birth || undefined, phone: f.phone || undefined, email: f.email || undefined,
    contract_type: f.contract, job_title: f.job, cbo: f.cbo || undefined, department: f.dept || undefined, hire_date: f.hire,
    salary: toNum(f.salary), salary_unit: f.unit, weekly_hours: toNum(f.weekly) || 44, work_regime: f.regime,
    experience_days: f.exp === "45+45" ? [45, 45] : f.exp === "30+60" ? [30, 60] : f.exp === "90" ? [90] : undefined,
    commissioned: f.commissioned, track_time: f.trackTime, time_bank: f.timeBank, fgts: f.contract === "PRO_LABORE" || f.contract === "ESTAGIO" ? false : f.fgts,
    pis: f.pis || undefined, ctps: f.ctps || undefined, rg: f.rg || undefined, mother_name: f.mother || undefined, marital_status: f.marital || undefined,
    bank_code: f.bank || undefined, bank_agency: f.agency || undefined, bank_account: f.account || undefined, pix_key: f.pix || undefined,
    address: Object.fromEntries(Object.entries({ cep: f.cep, street: f.street, number: f.number, district: f.district, city: f.city, uf: f.uf }).filter(([, v]) => v)),
    dependents: deps.filter((d) => d.name.trim().length > 1).map((d) => ({ name: d.name, birth_date: d.birth || undefined, relationship: "FILHO", irrf: d.irrf, family_allowance: d.fam })),
    benefits: [{ code: "VT", value: toNum(f.vt) }, { code: "VR", value: toNum(f.vr) }].filter((b) => b.value > 0),
  }), [f, deps]);

  const ok = f.name.trim().length > 2 && f.cpf.replace(/\D/g, "").length === 11 && f.job.trim().length > 1 && toNum(f.salary) > 0 && !!f.hire && !!f.entity;

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />

      <Card title="Dados pessoais">
        <div className="grid gap-3 sm:grid-cols-6">
          <Field label="Nome completo" className="sm:col-span-3"><input className={inputClass} value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={120} /></Field>
          <Field label="CPF" className="sm:col-span-1"><input className={inputClass} value={f.cpf} onChange={(e) => set("cpf", e.target.value)} inputMode="numeric" placeholder="000.000.000-00" /></Field>
          <Field label="Nascimento" className="sm:col-span-1"><input type="date" className={inputClass} value={f.birth} onChange={(e) => set("birth", e.target.value)} /></Field>
          <Field label="Estado civil" className="sm:col-span-1">
            <select className={inputClass} value={f.marital} onChange={(e) => set("marital", e.target.value)}><option value="">—</option><option>Solteiro(a)</option><option>Casado(a)</option><option>União estável</option><option>Divorciado(a)</option><option>Viúvo(a)</option></select>
          </Field>
          <Field label="WhatsApp" className="sm:col-span-2"><input className={inputClass} value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="(48) 99999-0000" /></Field>
          <Field label="E-mail" className="sm:col-span-2"><input className={inputClass} type="email" value={f.email} onChange={(e) => set("email", e.target.value)} /></Field>
          <Field label="Nome da mãe" className="sm:col-span-2"><input className={inputClass} value={f.mother} onChange={(e) => set("mother", e.target.value)} /></Field>
          <Field label="PIS/NIS" className="sm:col-span-2"><input className={inputClass} value={f.pis} onChange={(e) => set("pis", e.target.value)} /></Field>
          <Field label="CTPS (nº/série)" className="sm:col-span-2"><input className={inputClass} value={f.ctps} onChange={(e) => set("ctps", e.target.value)} /></Field>
          <Field label="RG" className="sm:col-span-2"><input className={inputClass} value={f.rg} onChange={(e) => set("rg", e.target.value)} /></Field>
          <Field label="CEP" className="sm:col-span-1"><input className={inputClass} value={f.cep} onChange={(e) => set("cep", e.target.value)} inputMode="numeric" /></Field>
          <Field label="Logradouro" className="sm:col-span-3"><input className={inputClass} value={f.street} onChange={(e) => set("street", e.target.value)} /></Field>
          <Field label="Nº" className="sm:col-span-1"><input className={inputClass} value={f.number} onChange={(e) => set("number", e.target.value)} /></Field>
          <Field label="Bairro" className="sm:col-span-2"><input className={inputClass} value={f.district} onChange={(e) => set("district", e.target.value)} /></Field>
          <Field label="Cidade" className="sm:col-span-2"><input className={inputClass} value={f.city} onChange={(e) => set("city", e.target.value)} /></Field>
          <Field label="UF" className="sm:col-span-1"><input className={inputClass} value={f.uf} onChange={(e) => set("uf", e.target.value.toUpperCase().slice(0, 2))} /></Field>
        </div>
        <p className="mt-2 text-xs text-muted">CPF, PIS, CTPS, RG e dados bancários ficam em tabela separada, visível só para quem tem permissão de dados sensíveis (LGPD).</p>
      </Card>

      <Card title="Contrato">
        <div className="grid gap-3 sm:grid-cols-6">
          <Field label="Empresa (CNPJ)" className="sm:col-span-2"><select className={inputClass} value={f.entity} onChange={(e) => { set("entity", e.target.value); set("store", stores.find((s) => s.legal_entity_id === e.target.value)?.id ?? ""); }}>{entities.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></Field>
          <Field label="Loja / lotação" className="sm:col-span-2"><select className={inputClass} value={f.store} onChange={(e) => set("store", e.target.value)}><option value="">— sem loja —</option>{entityStores.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
          <Field label="Vínculo" className="sm:col-span-2">
            <select className={inputClass} value={f.contract} onChange={(e) => set("contract", e.target.value)}>
              <option value="CLT">CLT</option><option value="ESTAGIO">Estágio</option><option value="APRENDIZ">Aprendiz</option><option value="INTERMITENTE">Intermitente</option><option value="TEMPORARIO">Temporário</option><option value="PRO_LABORE">Sócio (pró-labore)</option>
            </select>
          </Field>
          <Field label="Cargo / função" className="sm:col-span-2"><input className={inputClass} value={f.job} onChange={(e) => set("job", e.target.value)} placeholder="Consultora de moda" /></Field>
          <Field label="CBO" className="sm:col-span-1"><input className={inputClass} value={f.cbo} onChange={(e) => set("cbo", e.target.value)} placeholder="521110" /></Field>
          <Field label="Departamento" className="sm:col-span-1"><input className={inputClass} value={f.dept} onChange={(e) => set("dept", e.target.value)} /></Field>
          <Field label="Data de admissão" className="sm:col-span-1"><input type="date" className={inputClass} value={f.hire} onChange={(e) => set("hire", e.target.value)} /></Field>
          <Field label="Experiência" className="sm:col-span-1">
            <select className={inputClass} value={f.exp} onChange={(e) => set("exp", e.target.value)}><option value="45+45">45 + 45 dias</option><option value="30+60">30 + 60 dias</option><option value="90">90 dias</option><option value="">Sem experiência</option></select>
          </Field>
          <Field label="Regime de jornada" className="sm:col-span-1">
            <select className={inputClass} value={f.regime} onChange={(e) => set("regime", e.target.value)}><option value="6X1">6×1 (seg–sáb)</option><option value="5X2">5×2 (seg–sex)</option><option value="12X36">12×36</option><option value="INTERMITTENT">Intermitente</option></select>
          </Field>
          <Field label="Horas/semana" className="sm:col-span-1"><input className={inputClass} value={f.weekly} onChange={(e) => set("weekly", e.target.value)} inputMode="decimal" /></Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.commissioned} onChange={(e) => set("commissioned", e.target.checked)} /> Recebe comissão de vendas</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.trackTime} onChange={(e) => set("trackTime", e.target.checked)} /> Ponto controlado (senão, a escala vale como ponto)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.timeBank} onChange={(e) => set("timeBank", e.target.checked)} /> Horas extras vão para o banco de horas</label>
        </div>
      </Card>

      <Card title="Remuneração e pagamento">
        <div className="grid gap-3 sm:grid-cols-6">
          <Field label="Salário (R$)" className="sm:col-span-2"><input className={inputClass} value={f.salary} onChange={(e) => set("salary", e.target.value)} inputMode="decimal" placeholder="2.200,00" /></Field>
          <Field label="Base" className="sm:col-span-1"><select className={inputClass} value={f.unit} onChange={(e) => set("unit", e.target.value)}><option value="MONTH">Mensal</option><option value="HOUR">Por hora</option></select></Field>
          <Field label="Vale-transporte (R$/dia)" className="sm:col-span-1"><input className={inputClass} value={f.vt} onChange={(e) => set("vt", e.target.value)} inputMode="decimal" /></Field>
          <Field label="Vale-refeição (R$/dia)" className="sm:col-span-1"><input className={inputClass} value={f.vr} onChange={(e) => set("vr", e.target.value)} inputMode="decimal" /></Field>
          <div className="hidden sm:block" />
          <Field label="Banco (código)" className="sm:col-span-1"><input className={inputClass} value={f.bank} onChange={(e) => set("bank", e.target.value)} placeholder="077" maxLength={4} /></Field>
          <Field label="Agência" className="sm:col-span-1"><input className={inputClass} value={f.agency} onChange={(e) => set("agency", e.target.value)} /></Field>
          <Field label="Conta" className="sm:col-span-2"><input className={inputClass} value={f.account} onChange={(e) => set("account", e.target.value)} /></Field>
          <Field label="Chave Pix" className="sm:col-span-2"><input className={inputClass} value={f.pix} onChange={(e) => set("pix", e.target.value)} /></Field>
        </div>
        <p className="mt-2 text-xs text-muted">Benefícios adicionais (plano de saúde, seguro) são vinculados na ficha do colaborador. O desconto de 6% do vale-transporte é calculado pela folha.</p>
      </Card>

      <Card title="Dependentes" action={<button type="button" className="inline-flex items-center gap-1 text-xs text-brand" onClick={() => setDeps([...deps, { name: "", birth: "", irrf: true, fam: false }])}><Plus size={14} /> adicionar</button>}>
        {deps.length === 0 ? <p className="text-sm text-muted">Dependentes reduzem o IRRF (R$ 189,59 cada) e dão direito ao salário-família (filhos até 14 anos).</p> : (
          <div className="space-y-2">
            {deps.map((d, i) => (
              <div key={i} className="grid grid-cols-[1fr_9rem_auto_auto_2rem] items-center gap-2">
                <input className={inputClass} placeholder="Nome" value={d.name} onChange={(e) => setDeps(deps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Nome do dependente" />
                <input type="date" className={inputClass} value={d.birth} onChange={(e) => setDeps(deps.map((x, j) => (j === i ? { ...x, birth: e.target.value } : x)))} aria-label="Nascimento" />
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={d.irrf} onChange={(e) => setDeps(deps.map((x, j) => (j === i ? { ...x, irrf: e.target.checked } : x)))} /> IRRF</label>
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={d.fam} onChange={(e) => setDeps(deps.map((x, j) => (j === i ? { ...x, fam: e.target.checked } : x)))} /> Sal.-família</label>
                <button type="button" className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Remover" onClick={() => setDeps(deps.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <Button disabled={pending || !ok}>{pending ? "Admitindo…" : "Admitir colaborador"}</Button>
    </form>
  );
}
