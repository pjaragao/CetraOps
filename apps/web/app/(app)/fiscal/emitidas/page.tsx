import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { periodBounds, str, type SP } from "@/lib/context";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge, Button, Card, Empty, PageHeader, Stat, Table } from "@/components/ui";
import { Flash, fmtDate } from "@/components/form";
import { requestEmissionAction } from "./actions";
import { CancelForm } from "./cancel-form";

export const metadata = { title: "Notas emitidas" };

const STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  AUTHORIZED: { label: "autorizada", tone: "success" }, PROCESSING: { label: "processando", tone: "warning" }, REJECTED: { label: "rejeitada", tone: "danger" },
  DENIED: { label: "denegada", tone: "danger" }, CANCELLED: { label: "cancelada", tone: "neutral" }, DRAFT: { label: "rascunho", tone: "neutral" },
  NUMBER_VOIDED: { label: "inutilizada", tone: "neutral" }, CONTINGENCY_PENDING: { label: "contingência", tone: "warning" },
};
const FILTERS = [["", "Todas"], ["AUTHORIZED", "Autorizadas"], ["REJECTED", "Rejeitadas"], ["PROCESSING", "Processando"], ["CANCELLED", "Canceladas"]] as const;
const vnf = (t: unknown) => Number((t as Record<string, number> | null)?.vNF ?? 0);

export default async function NotasEmitidasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fiscal.read");
  const sp = await searchParams;
  const canWrite = can(session, "fiscal.write");
  const { fromTs, toTs } = periodBounds(str(sp.periodo));
  const status = str(sp.status) ?? "";
  const supabase = await createClient();

  let q = supabase.schema("fiscal").from("documents")
    .select("id, model, series, number, access_key, status, issue_at, created_at, sefaz_code, sefaz_msg, danfe_path, totals, order_id, events")
    .eq("direction", "OUT").gte("created_at", fromTs).lte("created_at", toTs).order("created_at", { ascending: false }).limit(300);
  if (status) q = q.eq("status", status);
  const [{ data: docs }, { data: pending }] = await Promise.all([q, supabase.schema("fiscal").from("v_uninvoiced_orders").select("order_id, number, channel, total, created_at").order("created_at", { ascending: false }).limit(50)]);

  const oids = [...new Set((docs ?? []).map((d) => d.order_id).filter(Boolean) as string[])];
  const { data: orders } = oids.length ? await supabase.schema("sales").from("orders").select("id, number").in("id", oids) : { data: [] as { id: string; number: string }[] };
  const onum = new Map((orders ?? []).map((o) => [o.id, o.number]));

  const all = docs ?? [];
  const count = (s: string) => all.filter((d) => d.status === s).length;
  const authorizedTotal = all.filter((d) => d.status === "AUTHORIZED").reduce((s, d) => s + vnf(d.totals), 0);

  return (
    <>
      <PageHeader title="Notas emitidas" description="NFC-e e NF-e de saída emitidas pelo Focus NFe. Rejeitada volta a ser pendência e pode ser reenviada depois de corrigir o cadastro; nota autorizada só se cancela com justificativa." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {str(sp.wait) && <AutoRefresh />}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Autorizadas" value={count("AUTHORIZED")} hint={formatBRL(authorizedTotal)} tone="success" />
        <Stat label="Rejeitadas" value={count("REJECTED") + count("DENIED")} tone={count("REJECTED") + count("DENIED") ? "danger" : undefined} />
        <Stat label="Processando" value={count("PROCESSING")} tone={count("PROCESSING") ? "warning" : undefined} />
        <Stat label="Canceladas" value={count("CANCELLED")} />
        <Stat label="Vendas sem nota" value={(pending ?? []).length} tone={(pending ?? []).length ? "warning" : undefined} hint="pagas, ainda sem NFC-e/NF-e válida" />
      </div>

      {(pending ?? []).length > 0 && (
        <Card className="mb-4" title="Vendas pagas sem nota">
          <Table head={["Pedido", "Canal", "Data", "Valor", ""]}>
            {(pending ?? []).filter((o) => o.order_id).map((o) => (
              <tr key={o.order_id}>
                <td className="px-3 py-2 font-medium"><Link className="text-brand" href={`/vender/pedidos/${o.order_id}`}>{o.number}</Link></td>
                <td className="px-3 py-2">{o.channel}</td>
                <td className="px-3 py-2 whitespace-nowrap">{o.created_at ? fmtDate(o.created_at.slice(0, 10)) : "—"}</td>
                <td className="px-3 py-2 font-medium">{formatBRL(Number(o.total))}</td>
                <td className="px-3 py-2">{canWrite && <form action={requestEmissionAction}><input type="hidden" name="order_id" value={o.order_id ?? ""} /><Button variant="secondary" className="px-2 py-1 text-xs">Emitir agora</Button></form>}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <form className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {FILTERS.map(([value, label]) => (
          <button key={value} name="status" value={value} className={`rounded-full border px-3 py-1 text-xs ${status === value ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2"}`}>{label}</button>
        ))}
        {str(sp.periodo) && <input type="hidden" name="periodo" value={str(sp.periodo)} />}
      </form>

      {all.length === 0 ? <Empty title="Nenhuma nota no período">As notas aparecem aqui assim que as vendas são finalizadas e o worker emite no Focus NFe.</Empty> : (
        <Table head={["Nota", "Emissão", "Pedido", "Valor", "Situação", "Retorno da SEFAZ", "Arquivos", ""]}>
          {all.map((d) => {
            const st = STATUS[d.status] ?? { label: d.status.toLowerCase(), tone: "neutral" as const };
            const danfe = d.danfe_path && /^https?:\/\//.test(d.danfe_path) ? d.danfe_path : null;
            const last = (d.events as { type?: string; message?: string; reason?: string }[] | null)?.at(-1);
            return (
              <tr key={d.id}>
                <td className="px-3 py-2 font-medium">{d.number ? `${d.number}/${d.series ?? "—"}` : "—"}<span className="block text-[11px] font-normal text-muted">{d.model === "65" ? "NFC-e" : "NF-e"}</span></td>
                <td className="px-3 py-2 whitespace-nowrap">{fmtDate((d.issue_at ?? d.created_at).slice(0, 10))}</td>
                <td className="px-3 py-2">{d.order_id ? <Link className="text-brand" href={`/vender/pedidos/${d.order_id}`}>{onum.get(d.order_id) ?? "ver"}</Link> : "—"}</td>
                <td className="px-3 py-2 font-medium">{formatBRL(vnf(d.totals))}</td>
                <td className="px-3 py-2"><Badge tone={st.tone}>{st.label}</Badge>{last?.type === "CANCEL_REQUESTED" && d.status === "AUTHORIZED" && <span className="ml-1 text-[11px] text-warning">cancelamento pedido…</span>}</td>
                <td className="max-w-xs px-3 py-2 text-xs">{d.sefaz_code ? <span className="font-mono">{d.sefaz_code}</span> : null} {d.sefaz_msg}{last?.type === "CANCEL_FAILED" && <span className="block text-danger">Cancelamento recusado: {last.message}</span>}</td>
                <td className="px-3 py-2 text-xs">{danfe ? <a className="text-brand" href={danfe} target="_blank" rel="noreferrer">DANFE</a> : "—"}{d.access_key && <span className="block font-mono text-[10px] text-muted" title={d.access_key}>{d.access_key.slice(0, 8)}…{d.access_key.slice(-6)}</span>}</td>
                <td className="px-3 py-2">
                  {canWrite && d.status === "AUTHORIZED" && <CancelForm documentId={d.id} label={`${d.number}/${d.series}`} />}
                  {canWrite && (d.status === "REJECTED" || d.status === "DENIED") && d.order_id && <form action={requestEmissionAction}><input type="hidden" name="order_id" value={d.order_id} /><Button variant="secondary" className="px-2 py-1 text-xs">Reenviar</Button></form>}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <p className="mt-3 text-xs text-muted">Devoluções e vendas B2B (NF-e) ficam para revisão: o documento fiscal correto depende da matriz validada com o contador (CFOP, finalidade, referência da chave).</p>
    </>
  );
}
