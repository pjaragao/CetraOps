import { DISPATCH_FILTERS, VARIABLE_SOURCES, renderTemplate, suggestVariables, templateParts, templatePlaceholders, type TemplateComponent } from "@centralops/domain";
import { Button, Card, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { saveDispatchAction } from "./actions";

interface Tpl { id: string; name: string; channel_account_id: string; components: unknown }

/**
 * Escolha do template + variáveis + quando/quem recebe. Usado no assistente (passo 4) e na aba Canais da campanha ativa
 * (aí só lembretes, já agendados ao salvar). O template é escolhido por GET (?tpl=) para a página montar os campos das variáveis.
 */
export function DispatchForm({ campaignId, templates, accounts, tplId, offerMode, hasEnd, hasMain, onPage, getParams }: {
  campaignId: string; templates: Tpl[]; accounts: Map<string, string>; tplId: string; offerMode: string; hasEnd: boolean; hasMain: boolean; onPage: boolean; getParams: Record<string, string>;
}) {
  const tpl = templates.find((t) => t.id === tplId);
  const body = tpl ? templateParts(tpl.components as unknown as TemplateComponent[]).body : "";
  const nVars = tpl ? templatePlaceholders(body).length : 0;
  const sugg = suggestVariables(nVars, offerMode, hasEnd);
  const filters = Object.entries(DISPATCH_FILTERS).filter(([k]) => !onPage || k !== "ALL");
  return (
    <Card title={onPage ? "Agendar lembrete" : "Adicionar disparo ou lembrete"}>
      <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
        {Object.entries(getParams).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <Field label="Template aprovado"><select name="tpl" defaultValue={tplId} className={inputClass}><option value="">Escolha…</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name} · {accounts.get(t.channel_account_id)}</option>)}</select></Field>
        <Button variant="secondary">Usar</Button>
      </form>
      {tpl && (
        <form action={saveDispatchAction} className="space-y-3">
          <input type="hidden" name="id" value={campaignId} /><input type="hidden" name="template_id" value={tpl.id} /><input type="hidden" name="channel_account_id" value={tpl.channel_account_id} /><input type="hidden" name="var_count" value={nVars} />
          {onPage && <><input type="hidden" name="back" value="page" /><input type="hidden" name="activate" value="1" /></>}
          <p className="max-w-md whitespace-pre-line rounded-2xl rounded-tl-sm bg-surface-2 px-3 py-2 text-sm">{renderTemplate(body, sugg.map((v) => (v.source === "TEXT" ? "…" : VARIABLE_SOURCES[v.source]?.sample ?? "…")))}</p>
          {nVars > 0 && (
            <fieldset className="grid gap-3 sm:grid-cols-2"><legend className="mb-1 text-xs font-medium text-muted">Variáveis</legend>
              {Array.from({ length: nVars }, (_, i) => (
                <div key={i} className="flex gap-2"><span className="self-center text-xs text-muted">{`{{${i + 1}}}`}</span>
                  <select name={`var_${i}_source`} defaultValue={sugg[i].source} className={inputClass} aria-label={`Variável ${i + 1}`}>{Object.entries(VARIABLE_SOURCES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
                  <input name={`var_${i}_text`} defaultValue={sugg[i].text ?? ""} placeholder="se texto fixo" maxLength={200} className={inputClass} aria-label={`Texto da variável ${i + 1}`} />
                </div>
              ))}
            </fieldset>
          )}
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Quem recebe"><select name="filter" defaultValue={onPage || hasMain ? "NOT_BOUGHT" : "ALL"} className={inputClass}>{filters.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Enviar em" hint="Lembrete: 24 h ou mais após o principal"><input name="scheduled_at" type="datetime-local" required={onPage} className={inputClass} /></Field>
            <Field label="Intervalo entre marketing (dias)"><input name="frequency_cap_days" type="number" min={0} max={90} defaultValue={7} className={inputClass} /></Field>
            <Field label="Limite por dia"><input name="daily_limit" type="number" min={1} max={10000} defaultValue={250} className={inputClass} /></Field>
          </div>
          <Button>{onPage ? "Agendar lembrete" : "Salvar disparo"}</Button>
        </form>
      )}
    </Card>
  );
}
