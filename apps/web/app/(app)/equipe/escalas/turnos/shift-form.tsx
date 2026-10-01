"use client";
import Link from "next/link";
import { useState } from "react";
import { fmtHours, netMinutes, spanMinutes } from "@sie/domain";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { saveShiftAction } from "../../actions";

interface Shift { id: string; code: string; name: string; start_time: string; end_time: string; break_minutes: number; color: string; store_id: string | null }

/** Turno: o intervalo já vem no mínimo da regra e a jornada líquida aparece enquanto se edita. */
export function ShiftForm({ editing, stores, minBreak, breakOverMin, breakRuleOn, back }: {
  editing?: Shift; stores: { id: string; name: string }[]; minBreak: number; breakOverMin: number; breakRuleOn: boolean; back: string;
}) {
  const [start, setStart] = useState(editing?.start_time.slice(0, 5) ?? "");
  const [end, setEnd] = useState(editing?.end_time.slice(0, 5) ?? "");
  const [brk, setBrk] = useState(String(editing?.break_minutes ?? minBreak));
  const b = Number(brk) || 0;
  const span = start && end && start !== end ? spanMinutes(start, end) : 0;
  const net = netMinutes(start, end, b);
  const short = breakRuleOn && span > breakOverMin && b < minBreak;

  return (
    <form action={saveShiftAction} className="grid gap-3 sm:grid-cols-4 lg:grid-cols-8 lg:items-end">
      {editing && <input type="hidden" name="id" value={editing.id} />}<input type="hidden" name="back" value={back} />
      <Field label="Sigla"><input name="code" required maxLength={4} defaultValue={editing?.code} className={`${inputClass} uppercase`} placeholder="AB" /></Field>
      <div className="sm:col-span-2"><Field label="Nome"><input name="name" maxLength={60} defaultValue={editing?.name} className={inputClass} placeholder="Abertura" /></Field></div>
      <Field label="Início"><input name="start_time" type="time" required value={start} onChange={(e) => setStart(e.target.value)} className={inputClass} /></Field>
      <Field label="Fim"><input name="end_time" type="time" required value={end} onChange={(e) => setEnd(e.target.value)} className={inputClass} /></Field>
      <Field label="Intervalo (min)" hint={breakRuleOn ? `Mínimo da regra: ${minBreak} min` : "Regra do intervalo desligada"}>
        <input name="break_minutes" type="number" min={0} max={240} required value={brk} onChange={(e) => setBrk(e.target.value)} className={inputClass} />
      </Field>
      <Field label="Cor"><input name="color" type="color" defaultValue={editing?.color ?? "#8a7fb0"} className="h-9 w-full rounded-lg border border-border bg-surface" /></Field>
      <Field label="Loja"><select name="store_id" defaultValue={editing?.store_id ?? ""} className={inputClass}><option value="">Todas</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-4 lg:col-span-8">
        <Button>{editing ? "Salvar turno" : "Criar turno"}</Button>
        {editing && <Link href={back} className="text-xs text-brand">Cancelar</Link>}
        <span className="rounded-lg bg-surface-2 px-3 py-1.5 text-sm" aria-live="polite">
          Total trabalhado: <b>{net > 0 ? fmtHours(net) : "—"}</b>{span > 0 && <span className="text-muted"> (presença {fmtHours(span)} − intervalo {b} min)</span>}
        </span>
        {short && <span className="text-xs text-danger" role="alert">Abaixo do intervalo mínimo ({minBreak} min) para jornada acima de {fmtHours(breakOverMin)}: o sistema vai recusar.</span>}
        <span className="text-xs text-muted">Passa da meia-noite? Informe o fim menor que o início (ex.: 22:00–02:00).</span>
      </div>
    </form>
  );
}
