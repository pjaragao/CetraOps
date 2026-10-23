"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Plus, Sparkles, X } from "lucide-react";
import {
  describeSpec, FILTER_OP_LABEL, filterOpsFor, opNeedsValue, opTakesList, REPORT_LIMITS,
  type ReportDataset, type ReportField, type ReportFilterOp, type ReportSpec,
} from "@centralops/domain";
import { Badge, Button, Card, cn, inputClass, Table } from "@/components/ui";
import { Field } from "@/components/form";
import { formatReportCell } from "@/lib/report-format";
import type { ReportResult } from "@/lib/reports";
import { draftReportAction, previewReportAction, saveReportAction } from "./actions";

interface UiFilter { field: string; op: ReportFilterOp; text: string }
interface Initial { id?: string; title?: string; description?: string | null; prompt?: string | null; spec?: ReportSpec }

/** Campo sem largura fixa (o padrão ocupa a linha toda): para filtros e opções lado a lado. */
const inlineInput = inputClass.replace("w-full", "");

const EXAMPLES = [
  "Receita, peças e margem por categoria no mês passado",
  "Clientes que não compram há mais de 90 dias e já gastaram mais de R$ 500, com o Instagram",
  "Vendas por hora do dia e dia da semana nos últimos 90 dias",
  "Contas a pagar em aberto por fornecedor, das que vencem neste mês",
  "Peças sem estoque disponível por produto e tamanho",
  "Conversão das conversas por atendente e canal",
];

const toUi = (spec?: ReportSpec): UiFilter[] =>
  (spec?.filters ?? []).map((f) => ({ field: f.field, op: f.op, text: opTakesList(f.op) ? (f.values ?? []).join(", ") : (f.value ?? "") }));

/** Construtor de relatórios: descreve para a IA ou monta à mão, confere na prévia e salva para a equipe. */
export function ReportBuilder({ catalog, initial, canUseAi, defaultFrom, defaultTo }: {
  catalog: ReportDataset[]; initial?: Initial; canUseAi: boolean; defaultFrom: string; defaultTo: string;
}) {
  const [dataset, setDataset] = useState(initial?.spec?.dataset ?? catalog[0]?.key ?? "");
  const [dims, setDims] = useState<string[]>(initial?.spec?.dimensions ?? []);
  const [meas, setMeas] = useState<string[]>(initial?.spec?.measures ?? []);
  const [filters, setFilters] = useState<UiFilter[]>(toUi(initial?.spec));
  const [sortField, setSortField] = useState(initial?.spec?.sort?.field ?? "");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initial?.spec?.sort?.dir ?? "desc");
  const [limit, setLimit] = useState(String(initial?.spec?.limit ?? REPORT_LIMITS.defaultRows));
  const [usePeriod, setUsePeriod] = useState(initial?.spec?.use_period !== false);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [prompt, setPrompt] = useState("");
  const [usedPrompt, setUsedPrompt] = useState(initial?.prompt ?? "");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);

  const [ai, setAi] = useState<{ busy: boolean; explanation?: string; problems?: string[]; error?: string }>({ busy: false });
  const [shown, setShown] = useState<{ key: string; result?: ReportResult; problems?: string[]; error?: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const seq = useRef(0);

  const ds = catalog.find((d) => d.key === dataset);
  const fieldOf = (k: string): ReportField | undefined => ds?.fields.find((f) => f.key === k);

  const spec: ReportSpec | null = useMemo(() => {
    if (!ds || dims.length + meas.length === 0) return null;
    return {
      dataset, dimensions: dims, measures: meas,
      filters: filters.filter((f) => fieldOf(f.field)).map((f) => (
        !opNeedsValue(f.op) ? { field: f.field, op: f.op }
          : opTakesList(f.op) ? { field: f.field, op: f.op, values: f.text.split(/[;,]/).map((x) => x.trim()).filter(Boolean) }
          : { field: f.field, op: f.op, value: f.text.trim() })),
      sort: sortField && [...dims, ...meas].includes(sortField) ? { field: sortField, dir: sortDir } : null,
      limit: Math.max(1, Math.min(Number(limit) || REPORT_LIMITS.defaultRows, REPORT_LIMITS.maxRows)),
      ...(ds.has_period && !usePeriod ? { use_period: false } : {}),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, dims, meas, filters, sortField, sortDir, limit, usePeriod, ds]);

  // prévia automática (espera a pessoa parar de mexer)
  const previewKey = JSON.stringify([spec, from, to]);
  useEffect(() => {
    if (!spec) return;
    const id = ++seq.current;
    const t = setTimeout(async () => {
      const r = await previewReportAction(spec, from, to).catch((e: Error) => ({ error: e.message }) as Awaited<ReturnType<typeof previewReportAction>>);
      if (id === seq.current) setShown({ key: previewKey, ...r });
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);
  const preview = { busy: Boolean(spec) && shown?.key !== previewKey, ...(shown ?? {}) };

  function apply(s: ReportSpec) {
    setDataset(s.dataset); setDims(s.dimensions); setMeas(s.measures); setFilters(toUi(s));
    setSortField(s.sort?.field ?? ""); setSortDir(s.sort?.dir ?? "desc"); setLimit(String(s.limit ?? REPORT_LIMITS.defaultRows)); setUsePeriod(s.use_period !== false);
  }

  async function askAi() {
    setAi({ busy: true });
    const r = await draftReportAction(prompt, spec).catch((e: Error) => ({ error: e.message, draft: undefined }));
    if (r.error || !r.draft) { setAi({ busy: false, error: r.error ?? "A IA não respondeu." }); return; }
    const d = r.draft;
    if (d.spec) apply(d.spec);
    if (d.period) { setFrom(d.period.from); setTo(d.period.to); }
    if (d.title && (!title || !initial?.id)) setTitle(d.title);
    if (d.description && (!description || !initial?.id)) setDescription(d.description);
    setUsedPrompt(usedPrompt && spec ? `${usedPrompt}\n${prompt}` : prompt);
    setPrompt("");
    setAi({ busy: false, explanation: d.explanation, problems: d.spec ? d.problems : [...d.problems, "Não deu para montar um relatório com esse pedido."] });
  }

  const toggle = (list: string[], set: (v: string[]) => void, key: string, max: number) =>
    set(list.includes(key) ? list.filter((k) => k !== key) : list.length >= max ? list : [...list, key]);

  function changeDataset(key: string) {
    setDataset(key); setDims([]); setMeas([]); setFilters([]); setSortField("");
  }

  function save() {
    setSaveError(null);
    if (!spec) { setSaveError("Escolha ao menos um campo para agrupar ou um valor."); return; }
    startSaving(async () => {
      const r = await saveReportAction({ id: initial?.id, title: title.trim() || (ds ? describeSpec(spec, ds) : ""), description, prompt: usedPrompt, spec });
      if (r?.error) setSaveError(r.error);
    });
  }

  const byArea = [...new Set(catalog.map((d) => d.area))];
  const chip = (on: boolean) => cn("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm transition",
    on ? "border-brand bg-brand/10 font-medium text-brand" : "border-border text-muted hover:border-brand/50 hover:text-text");
  const res = preview.result;

  return (
    <div className="space-y-4">
      {canUseAi && (
        <Card title={spec ? "Ajustar com IA" : "Descreva o relatório"}>
          <p className="mb-2 text-sm text-muted">
            {spec ? "Peça uma mudança (ex.: “separe por mês”, “só o Instagram”, “mostre só as 10 maiores”) e a IA ajusta a montagem abaixo."
                  : "Diga em português o que você quer ver. A IA escolhe a fonte de dados, os campos e os filtros; você confere na prévia antes de salvar."}
          </p>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} maxLength={2000} className={inputClass}
            placeholder="Ex.: clientes VIP que não compram há 60 dias, com o gasto total"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && prompt.trim()) { e.preventDefault(); void askAi(); } }} aria-label="Pedido para a IA" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => void askAi()} disabled={ai.busy || prompt.trim().length < 4}>
              <Sparkles size={15} aria-hidden /> {ai.busy ? "Montando…" : spec ? "Ajustar com IA" : "Montar com IA"}
            </Button>
            {!spec && EXAMPLES.map((ex) => (
              <button key={ex} type="button" onClick={() => setPrompt(ex)} className="rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted hover:text-text">{ex}</button>
            ))}
          </div>
          {ai.error && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{ai.error}</p>}
          {ai.explanation && (
            <div role="status" className="mt-3 rounded-lg bg-info/10 px-3 py-2 text-sm text-info">
              <p>{ai.explanation}</p>
              {!!ai.problems?.length && <ul className="mt-1 list-disc pl-5 text-xs">{ai.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
            </div>
          )}
        </Card>
      )}

      <Card title="Montagem">
        <div className="space-y-4">
          <Field label="Fonte de dados">
            <select value={dataset} onChange={(e) => changeDataset(e.target.value)} className={`${inputClass} mt-1 block sm:max-w-md`}>
              {byArea.map((a) => (
                <optgroup key={a} label={a}>{catalog.filter((d) => d.area === a).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</optgroup>
              ))}
            </select>
            {ds && <span className="mt-1 block text-xs">{ds.description}</span>}
          </Field>

          {ds && (
            <>
              <fieldset>
                <legend className="mb-1.5 text-xs text-muted">Agrupar por <span className="opacity-70">(até {REPORT_LIMITS.dimensions}; a ordem dos cliques é a ordem das colunas)</span></legend>
                <div className="flex flex-wrap gap-1.5">
                  {ds.fields.filter((f) => f.role === "dimension").map((f) => {
                    const i = dims.indexOf(f.key);
                    return (
                      <button key={f.key} type="button" aria-pressed={i >= 0} title={f.description ?? undefined} onClick={() => toggle(dims, setDims, f.key, REPORT_LIMITS.dimensions)} className={chip(i >= 0)}>
                        {i >= 0 && <span className="text-[10px]">{i + 1}</span>}{f.label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-1.5 text-xs text-muted">Valores</legend>
                <div className="flex flex-wrap gap-1.5">
                  {ds.fields.filter((f) => f.role === "measure").map((f) => (
                    <button key={f.key} type="button" aria-pressed={meas.includes(f.key)} title={f.description ?? undefined} onClick={() => toggle(meas, setMeas, f.key, REPORT_LIMITS.measures)} className={chip(meas.includes(f.key))}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-1.5 text-xs text-muted">Filtros</legend>
                <div className="space-y-2">
                  {filters.map((f, i) => {
                    const fd = fieldOf(f.field);
                    const ops = fd ? filterOpsFor(fd.type) : [];
                    const set = (patch: Partial<UiFilter>) => setFilters(filters.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                    return (
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        <select aria-label="Campo do filtro" value={f.field} className={`${inlineInput} w-auto max-w-full`}
                          onChange={(e) => { const nf = fieldOf(e.target.value); set({ field: e.target.value, op: nf && !filterOpsFor(nf.type).includes(f.op) ? filterOpsFor(nf.type)[0] : f.op, text: "" }); }}>
                          <optgroup label="Campos">{ds.fields.filter((x) => x.role === "dimension").map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</optgroup>
                          <optgroup label="Valores (por grupo)">{ds.fields.filter((x) => x.role === "measure").map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</optgroup>
                        </select>
                        <select aria-label="Condição" value={f.op} onChange={(e) => set({ op: e.target.value as ReportFilterOp })} className={`${inlineInput} w-auto max-w-full`}>
                          {ops.map((o) => <option key={o} value={o}>{FILTER_OP_LABEL[o]}</option>)}
                        </select>
                        {opNeedsValue(f.op) && (fd?.type === "boolean" ? (
                          <select aria-label="Valor do filtro" value={f.text} onChange={(e) => set({ text: e.target.value })} className={`${inlineInput} w-auto max-w-full`}>
                            <option value="">—</option><option value="true">sim</option><option value="false">não</option>
                          </select>
                        ) : (
                          <input aria-label="Valor do filtro" value={f.text} onChange={(e) => set({ text: e.target.value })} className={`${inlineInput} w-56 max-w-full`}
                            type={opTakesList(f.op) ? "text" : fd?.type === "date" ? "date" : fd?.type === "month" ? "month" : ["number", "money", "percent"].includes(fd?.type ?? "") ? "number" : "text"}
                            step="any" placeholder={opTakesList(f.op) ? "valores separados por vírgula" : ""} />
                        ))}
                        <button type="button" onClick={() => setFilters(filters.filter((_, j) => j !== i))} aria-label="Tirar filtro" className="rounded p-1 text-muted hover:text-danger"><X size={16} /></button>
                      </div>
                    );
                  })}
                  {filters.length < REPORT_LIMITS.filters && (
                    <button type="button" onClick={() => { const first = ds.fields.find((x) => x.role === "dimension")!; setFilters([...filters, { field: first.key, op: filterOpsFor(first.type)[0], text: "" }]); }}
                      className="inline-flex items-center gap-1 text-sm font-medium text-brand"><Plus size={14} aria-hidden /> Adicionar filtro</button>
                  )}
                </div>
              </fieldset>

              <div className="flex flex-wrap items-end gap-3">
                <Field label="Ordenar por">
                  <select value={sortField} onChange={(e) => setSortField(e.target.value)} className={`${inlineInput} mt-1 block w-auto max-w-full`}>
                    <option value="">Padrão (data em ordem ou maior valor primeiro)</option>
                    {[...dims, ...meas].map((k) => <option key={k} value={k}>{fieldOf(k)?.label ?? k}</option>)}
                  </select>
                </Field>
                {sortField && (
                  <Field label="Sentido">
                    <select value={sortDir} onChange={(e) => setSortDir(e.target.value as "asc" | "desc")} className={`${inlineInput} mt-1 block w-auto max-w-full`}>
                      <option value="desc">Maior primeiro (Z→A)</option><option value="asc">Menor primeiro (A→Z)</option>
                    </select>
                  </Field>
                )}
                <Field label="Máximo de linhas">
                  <input type="number" min={1} max={REPORT_LIMITS.maxRows} value={limit} onChange={(e) => setLimit(e.target.value)} className={`${inlineInput} mt-1 block w-28`} />
                </Field>
                {ds.has_period && (
                  <label className="mb-2 flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={usePeriod} onChange={(e) => setUsePeriod(e.target.checked)} />
                    Filtrar pelo período escolhido na tela ({ds.date_label})
                  </label>
                )}
              </div>
            </>
          )}
        </div>
      </Card>

      <Card title="Prévia" action={preview.busy ? <span className="text-xs text-muted">atualizando…</span> : null}>
        {ds?.has_period && usePeriod && (
          <div className="mb-3 flex flex-wrap items-end gap-2 text-sm">
            <label className="text-xs text-muted">De<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${inputClass} mt-1`} /></label>
            <label className="text-xs text-muted">Até<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${inputClass} mt-1`} /></label>
            <span className="self-center text-xs text-muted">Só para a prévia: quem abrir o relatório escolhe o período.</span>
          </div>
        )}
        {!spec ? <p className="text-sm text-muted">Escolha ao menos um campo em “Agrupar por” ou em “Valores”.</p>
          : preview.error ? <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{preview.error}</p>
          : res && res.rows.length === 0 ? <p className="text-sm text-muted">Nenhuma linha com essa montagem{res.period ? " neste período" : ""}.</p>
          : res ? (
            <div className={cn(preview.busy && "opacity-60")}>
              <Table head={res.columns.map((c) => c.label)}>
                {res.rows.map((r, i) => <tr key={i}>{res.columns.map((c) => <td key={c.key} className="px-3 py-2 whitespace-nowrap tabular-nums">{formatReportCell(c.type, r[c.key])}</td>)}</tr>)}
              </Table>
              {res.truncated && <p className="mt-2 text-xs text-muted">A prévia mostra até 200 linhas; o relatório salvo usa o máximo escolhido.</p>}
            </div>
          ) : <p className="text-sm text-muted">Carregando…</p>}
        {!!preview.problems?.length && <ul className="mt-2 list-disc pl-5 text-xs text-warning">{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      </Card>

      <Card title="Salvar">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nome do relatório">
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className={`${inputClass} mt-1`} placeholder={spec && ds ? describeSpec(spec, ds) : "Ex.: Clientes VIP sem comprar"} />
          </Field>
          <Field label="Para que serve (aparece na lista)">
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={600} className={`${inputClass} mt-1`} />
          </Field>
        </div>
        {saveError && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{saveError}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" onClick={save} disabled={saving || !spec}>{saving ? "Salvando…" : initial?.id ? "Salvar alterações" : "Salvar relatório"}</Button>
          <Link href={initial?.id ? `/relatorios/${initial.id}` : "/relatorios"} className="text-sm text-muted underline">Cancelar</Link>
          {usedPrompt && <Badge tone="info" className="ml-auto"><Sparkles size={11} className="mr-1" aria-hidden />montado com IA</Badge>}
        </div>
        <p className="mt-2 text-xs text-muted">O relatório salvo aparece na lista de Relatórios para quem tem acesso a {ds ? `“${ds.area}”` : "esses dados"}. Só você (ou o admin) pode alterar ou excluir.</p>
      </Card>
    </div>
  );
}
