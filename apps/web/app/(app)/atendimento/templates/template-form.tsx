"use client";
import { useState } from "react";
import { renderTemplate, templatePlaceholders, validateTemplateDraft } from "@centralops/domain";
import { useKeptForm } from "@/components/use-kept-form";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { saveTemplateAction } from "./actions";

export interface TemplateInitial { id: string; channel_account_id: string; name: string; category: string; language: string; header: string; body: string; footer: string; buttons: string[]; examples: string[] }

/** Rascunho de template com conferência na hora (as mesmas regras do banco) e prévia do balão da cliente. */
export function TemplateForm({ accounts, initial }: { accounts: { id: string; label: string }[]; initial?: TemplateInitial }) {
  const { state, pending, formProps } = useKeptForm(saveTemplateAction);
  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState(initial?.category ?? "UTILITY");
  const [header, setHeader] = useState(initial?.header ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [footer, setFooter] = useState(initial?.footer ?? "");
  const [buttons, setButtons] = useState((initial?.buttons ?? []).join("\n"));
  const [examples, setExamples] = useState((initial?.examples ?? []).join("\n"));

  const ex = examples.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const btns = buttons.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const vars = templatePlaceholders(body).length;
  const problems = body || name ? validateTemplateDraft({ name, category, body, header, footer, buttons: btns, examples: ex }) : [];

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <form {...formProps} className="grid gap-3 sm:grid-cols-2">
        {initial && <input type="hidden" name="id" value={initial.id} />}
        <Field label="Número de WhatsApp">
          <select name="channel_account_id" defaultValue={initial?.channel_account_id ?? accounts[0]?.id} className={inputClass} required>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </Field>
        <Field label="Categoria" hint="Utilidade: avisos de pedido/retirada. Marketing: promoções (exige consentimento da cliente).">
          <select name="category" value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass}>
            <option value="UTILITY">Utilidade</option><option value="MARKETING">Marketing</option>
          </select>
        </Field>
        <Field label="Nome" hint="Só minúsculas, números e _ (ex.: pedido_pronto)">
          <input name="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} className={inputClass} spellCheck={false} />
        </Field>
        <Field label="Idioma"><input name="language" defaultValue={initial?.language ?? "pt_BR"} className={inputClass} spellCheck={false} /></Field>
        <Field label="Cabeçalho (opcional)" className="sm:col-span-2"><input name="header" value={header} onChange={(e) => setHeader(e.target.value)} maxLength={60} className={inputClass} /></Field>
        <Field label="Texto da mensagem" hint="Use {{1}}, {{2}}… para o que muda em cada envio (nome, nº do pedido…). Não comece nem termine com variável." className="sm:col-span-2">
          <textarea name="body" value={body} onChange={(e) => setBody(e.target.value)} required rows={5} maxLength={1024} className={inputClass} />
        </Field>
        <Field label={`Exemplos das variáveis (${vars}) — um por linha`} hint="A Meta exige um exemplo de cada variável para aprovar" className="sm:col-span-2">
          <textarea name="examples" value={examples} onChange={(e) => setExamples(e.target.value)} rows={Math.max(2, vars)} className={inputClass} disabled={vars === 0} placeholder={vars === 0 ? "O texto não tem variáveis" : "Ana\nVEN-2026-000123"} />
        </Field>
        <Field label="Rodapé (opcional)"><input name="footer" value={footer} onChange={(e) => setFooter(e.target.value)} maxLength={60} className={inputClass} /></Field>
        <Field label="Botões de resposta rápida (um por linha, até 3)"><textarea name="buttons" value={buttons} onChange={(e) => setButtons(e.target.value)} rows={3} className={inputClass} /></Field>
        <div className="sm:col-span-2">
          {problems.length > 0 && <ul className="mb-2 list-disc rounded-lg bg-warning/10 py-2 pl-6 pr-3 text-xs text-warning">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          {state && <p role={state.ok ? "status" : "alert"} className={`mb-2 rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{state.ok ? state.message : state.error}</p>}
          <Button disabled={pending || problems.length > 0}>{pending ? "Salvando…" : initial ? "Atualizar rascunho" : "Salvar rascunho"}</Button>
        </div>
      </form>

      <aside aria-label="Prévia" className="rounded-xl border border-border bg-surface-2 p-4">
        <p className="mb-2 text-xs font-medium text-muted">Como a cliente vê</p>
        <div className="max-w-[17rem] rounded-2xl rounded-tl-sm bg-surface px-3 py-2 text-sm shadow-sm">
          {header && <p className="mb-1 font-semibold">{header}</p>}
          <p className="whitespace-pre-line">{body ? renderTemplate(body, ex) : <span className="text-muted">O texto aparece aqui.</span>}</p>
          {footer && <p className="mt-1 text-[11px] text-muted">{footer}</p>}
        </div>
        {btns.length > 0 && <div className="mt-1 flex max-w-[17rem] flex-col gap-1">{btns.slice(0, 3).map((b) => <span key={b} className="rounded-xl bg-surface px-3 py-1.5 text-center text-sm text-brand shadow-sm">{b}</span>)}</div>}
      </aside>
    </div>
  );
}
