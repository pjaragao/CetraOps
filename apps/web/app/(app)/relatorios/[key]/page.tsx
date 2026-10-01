import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Button, Empty, LinkButton, PageHeader, Table, inputClass } from "@/components/ui";
import { REPORTS } from "../registry";

const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }) {
  const r = REPORTS[(await params).key];
  return { title: r?.title ?? "Relatório" };
}

export default async function ReportPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: SP }) {
  const { key } = await params;
  const report = REPORTS[key];
  if (!report) notFound();
  const session = await getSession();
  if (!can(session, report.perm)) redirect("/relatorios");
  const sp = await searchParams;
  const to = str(sp.ate) ?? todayIsoSP();
  const from = str(sp.de) ?? addDays(to, -29);
  const option = str(sp.agrupar) ?? report.options?.values[0][0] ?? "";
  const supabase = await createClient();
  const rows = await report.load(supabase, { from, to, option });
  const qs = new URLSearchParams({ de: from, ate: to, ...(report.options ? { agrupar: option } : {}) }).toString();

  const cell = (kind: string | undefined, v: unknown) => {
    if (v === null || v === undefined || v === "") return "—";
    if (kind === "money") return formatBRL(Number(v));
    if (kind === "date") return String(v).slice(0, 10).split("-").reverse().join("/");
    if (typeof v === "boolean") return v ? "sim" : "não";
    return typeof v === "number" ? v.toLocaleString("pt-BR") : String(v);
  };

  return (
    <>
      <PageHeader title={report.title} description={report.description} actions={<LinkButton href={`/relatorios/${key}/csv?${qs}`}>Baixar CSV</LinkButton>} />
      <form className="mb-4 flex flex-wrap items-end gap-2 text-sm" action={`/relatorios/${key}`}>
        <label className="text-xs text-muted">De<input type="date" name="de" defaultValue={from} className={`${inputClass} mt-1`} /></label>
        <label className="text-xs text-muted">Até<input type="date" name="ate" defaultValue={to} className={`${inputClass} mt-1`} /></label>
        {report.options && (
          <label className="text-xs text-muted">{report.options.label}
            <select name="agrupar" defaultValue={option} className={`${inputClass} mt-1`}>{report.options.values.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        )}
        <Button variant="secondary">Atualizar</Button>
        <Link href="/relatorios" className="ml-auto text-xs text-muted underline">Todos os relatórios</Link>
      </form>
      {rows.length === 0 ? <Empty title="Nada neste período">Mude as datas ou o agrupamento.</Empty> : (
        <Table head={report.columns.map((c) => c.header)}>
          {rows.map((r, i) => (
            <tr key={i}>{report.columns.map((c, j) => <td key={j} className="px-3 py-2 whitespace-nowrap tabular-nums">{cell(c.kind, c.get(r))}</td>)}</tr>
          ))}
        </Table>
      )}
    </>
  );
}
