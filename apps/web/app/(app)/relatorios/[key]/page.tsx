import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Button, Empty, LinkButton, PageHeader, Table, inputClass } from "@/components/ui";
import { Flash } from "@/components/form";
import { loadCatalog, loadSaved, runReport, type ReportResult } from "@/lib/reports";
import { formatReportCell } from "@/lib/report-format";
import { REPORTS } from "../registry";
import { archiveReportAction } from "../actions";
import { ConfirmButton } from "../confirm-button";

const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const r = REPORTS[key];
  if (r) return { title: r.title };
  const saved = await loadSaved(await createClient(), key);
  return { title: saved?.title ?? "Relatório" };
}

export default async function ReportPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: SP }) {
  const { key } = await params;
  const report = REPORTS[key];
  const supabase = await createClient();
  const saved = report ? null : await loadSaved(supabase, key);
  if (!report && !saved) notFound();
  const session = await getSession();
  if (report && !can(session, report.perm)) redirect("/relatorios");
  const sp = await searchParams;
  const to = str(sp.ate) ?? todayIsoSP();
  const from = str(sp.de) ?? addDays(to, -29);
  const option = str(sp.agrupar) ?? report?.options?.values[0][0] ?? "";

  // relatório pronto: consulta própria; relatório da equipe: motor de relatórios (na loja escolhida no topo)
  let head: string[], body: string[][], error: string | null = null, truncated = false, hasPeriod = true, periodNote: string | null = null;
  if (report) {
    const rows = await report.load(supabase, { from, to, option });
    head = report.columns.map((c) => c.header);
    body = rows.map((r) => report.columns.map((c) => cell(c.kind, c.get(r))));
  } else {
    const ds = (await loadCatalog(supabase)).find((d) => d.key === saved!.dataset);
    hasPeriod = Boolean(ds?.has_period) && saved!.spec.use_period !== false;
    let result: ReportResult | null = null;
    try { result = await runReport(supabase, saved!.spec, { from, to, store: session.storeId }); } catch (e) { error = (e as Error).message; }
    head = result?.columns.map((c) => c.label) ?? [];
    body = result?.rows.map((r) => result!.columns.map((c) => formatReportCell(c.type, r[c.key]))) ?? [];
    truncated = Boolean(result?.truncated);
    if (result?.period && result.date_label) periodNote = `O período filtra a ${result.date_label}.`;
    if (ds && !ds.has_period) periodNote = "Foto de agora: este relatório não usa período.";
    else if (saved!.spec.use_period === false) periodNote = "Este relatório não usa o período (mostra todas as datas).";
  }
  const qs = new URLSearchParams({ de: from, ate: to, ...(report?.options ? { agrupar: option } : {}) }).toString();
  const mine = saved && (saved.created_by === session.memberId || can(session, "core.admin"));

  return (
    <>
      <PageHeader
        title={report?.title ?? saved!.title}
        description={report?.description ?? saved!.description ?? undefined}
        actions={(
          <>
            {mine && <LinkButton href={`/relatorios/${key}/editar`}><Pencil size={14} aria-hidden /> Editar</LinkButton>}
            {!error && <LinkButton href={`/relatorios/${key}/csv?${qs}`}>Baixar CSV</LinkButton>}
          </>
        )}
      />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <form className="mb-4 flex flex-wrap items-end gap-2 text-sm" action={`/relatorios/${key}`}>
        {hasPeriod && (
          <>
            <label className="text-xs text-muted">De<input type="date" name="de" defaultValue={from} className={`${inputClass} mt-1`} /></label>
            <label className="text-xs text-muted">Até<input type="date" name="ate" defaultValue={to} className={`${inputClass} mt-1`} /></label>
          </>
        )}
        {report?.options && (
          <label className="text-xs text-muted">{report.options.label}
            <select name="agrupar" defaultValue={option} className={`${inputClass} mt-1`}>{report.options.values.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        )}
        <Button variant="secondary">Atualizar</Button>
        {periodNote && <span className="self-center text-xs text-muted">{periodNote}</span>}
        <Link href="/relatorios" className="ml-auto text-xs text-muted underline">Voltar aos relatórios</Link>
      </form>
      {error ? (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">Não consegui rodar este relatório: {error}{mine ? " Abra em Editar para ajustar." : ""}</p>
      ) : body.length === 0 ? <Empty title="Nada neste período">Mude as datas{report?.options ? " ou o agrupamento" : ""}.</Empty> : (
        <>
          <Table head={head}>
            {body.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className="px-3 py-2 whitespace-nowrap tabular-nums">{v}</td>)}</tr>)}
          </Table>
          {truncated && <p className="mt-2 text-xs text-warning">Mostrando as primeiras {body.length} linhas (limite do relatório). Filtre mais ou aumente o limite em Editar.</p>}
        </>
      )}
      {saved?.prompt && <p className="mt-4 text-xs text-muted">Pedido feito à IA: “{saved.prompt}”</p>}
      {mine && (
        <form action={archiveReportAction} className="mt-6">
          <input type="hidden" name="id" value={saved!.id} />
          <ConfirmButton question="Excluir este relatório para toda a equipe?"><Trash2 size={14} aria-hidden /> Excluir relatório</ConfirmButton>
        </form>
      )}
    </>
  );
}

function cell(kind: string | undefined, v: unknown) {
  if (v === null || v === undefined || v === "") return "—";
  if (kind === "money") return formatBRL(Number(v));
  if (kind === "date") return String(v).slice(0, 10).split("-").reverse().join("/");
  if (typeof v === "boolean") return v ? "sim" : "não";
  return typeof v === "number" ? v.toLocaleString("pt-BR") : String(v);
}
