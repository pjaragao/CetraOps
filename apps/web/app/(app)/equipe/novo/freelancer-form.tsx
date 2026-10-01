"use client";
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, Card, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { engageFreelancerAction } from "../actions";

interface Opt { id: string; label: string }
const toNum = (s: string) => Number(String(s).replace(/\./g, "").replace(",", ".")) || 0;

/** Freelancer PJ/MEI: sem vínculo, sem folha e sem encargos de CLT. Cada contratação vira uma conta a pagar (rascunho). */
export function FreelancerForm({ entities, stores }: { entities: Opt[]; stores: (Opt & { legal_entity_id: string })[] }) {
  const { state, pending, formProps } = useKeptForm(engageFreelancerAction);
  const [f, setF] = useState({ entity: entities[0]?.id ?? "", store: "", kind: "MEI", name: "", cnpj: "", service: "", amount: "", due: "", doc: "NF_MEI", phone: "", email: "" });
  const [dates, setDates] = useState<string[]>([""]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const entityStores = stores.filter((s) => s.legal_entity_id === f.entity);
  const days = dates.filter(Boolean);

  const payload = useMemo(() => ({
    legal_entity_id: f.entity, store_id: f.store || undefined, kind: f.kind, name: f.name, cnpj: f.cnpj, service: f.service, work_dates: days, amount: toNum(f.amount),
    due_date: f.due || undefined, document_kind: f.doc, phone: f.phone || undefined, email: f.email || undefined,
  }), [f, days]);
  const ok = f.name.trim().length > 2 && f.cnpj.replace(/\D/g, "").length === 14 && f.service.trim().length > 2 && toNum(f.amount) > 0 && days.length > 0 && !!f.entity;

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      <Card title="Quando usar">
        <p className="text-sm">Para <b>datas especiais e reforços pontuais</b> (Drop, inauguração, fotos, promotora). O freelancer <b>não é colaborador</b>: não entra na folha, não tem FGTS, INSS patronal, férias nem 13º. Ele emite nota (PJ) ou nota de MEI e você paga como conta a pagar. Se a pessoa for chamada toda semana, com horário fixo e ordens do dia a dia, vira vínculo de fato: nesse caso contrate como <b>Intermitente</b> (CLT).</p>
      </Card>
      <Card title="Prestador">
        <div className="grid gap-3 sm:grid-cols-6">
          <Field label="Tipo" className="sm:col-span-1"><select className={inputClass} value={f.kind} onChange={(e) => { set("kind", e.target.value); set("doc", e.target.value === "MEI" ? "NF_MEI" : "NFSE"); }}><option value="MEI">MEI</option><option value="PJ">PJ (outra empresa)</option></select></Field>
          <Field label="Nome / razão social" className="sm:col-span-3"><input className={inputClass} value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={120} /></Field>
          <Field label="CNPJ" className="sm:col-span-2"><input className={inputClass} value={f.cnpj} onChange={(e) => set("cnpj", e.target.value)} inputMode="numeric" placeholder="00.000.000/0000-00" /></Field>
          <Field label="WhatsApp" className="sm:col-span-2"><input className={inputClass} value={f.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
          <Field label="E-mail" className="sm:col-span-2"><input className={inputClass} type="email" value={f.email} onChange={(e) => set("email", e.target.value)} /></Field>
        </div>
      </Card>
      <Card title="Serviço e pagamento">
        <div className="grid gap-3 sm:grid-cols-6">
          <Field label="Empresa que paga" className="sm:col-span-2"><select className={inputClass} value={f.entity} onChange={(e) => { set("entity", e.target.value); set("store", ""); }}>{entities.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></Field>
          <Field label="Loja (centro de custo)" className="sm:col-span-2"><select className={inputClass} value={f.store} onChange={(e) => set("store", e.target.value)}><option value="">—</option>{entityStores.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
          <Field label="Comprovante" className="sm:col-span-2"><select className={inputClass} value={f.doc} onChange={(e) => set("doc", e.target.value)}><option value="NF_MEI">Nota do MEI</option><option value="NFSE">Nota de serviço (PJ)</option><option value="RECIBO">Recibo</option></select></Field>
          <Field label="Serviço" className="sm:col-span-4"><input className={inputClass} value={f.service} onChange={(e) => set("service", e.target.value)} placeholder="Reforço no atendimento do Drop 02" /></Field>
          <Field label="Valor combinado (R$)" className="sm:col-span-1"><input className={inputClass} value={f.amount} onChange={(e) => set("amount", e.target.value)} inputMode="decimal" placeholder="600,00" /></Field>
          <Field label="Vencimento" className="sm:col-span-1" hint="Vazio = 5 dias após o último dia"><input type="date" className={inputClass} value={f.due} onChange={(e) => set("due", e.target.value)} /></Field>
        </div>
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium text-muted">Dias de trabalho ({days.length})</p>
          <div className="flex flex-wrap items-center gap-2">
            {dates.map((d, i) => (
              <span key={i} className="flex items-center gap-1">
                <input type="date" className={`${inputClass} w-40`} value={d} onChange={(e) => setDates(dates.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Dia ${i + 1}`} />
                {dates.length > 1 && <button type="button" className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Remover dia" onClick={() => setDates(dates.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}
              </span>
            ))}
            <button type="button" className="inline-flex items-center gap-1 text-xs text-brand" onClick={() => setDates([...dates, ""])}><Plus size={14} /> outro dia</button>
          </div>
        </div>
      </Card>
      {state && !state.ok && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p>}
      <Button disabled={pending || !ok}>{pending ? "Salvando…" : "Cadastrar e gerar conta a pagar"}</Button>
    </form>
  );
}
