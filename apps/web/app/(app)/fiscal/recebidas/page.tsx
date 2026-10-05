import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge, Button, Card, Empty, PageHeader, Table, inputClass } from "@/components/ui";
import { Flash, fmtDate } from "@/components/form";
import { manifestAction, syncDfeAction } from "./actions";

export const metadata = { title: "Notas recebidas" };

const MANIFEST: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" }> = {
  PENDING: { label: "sem manifestação", tone: "warning" }, CIENCIA: { label: "ciência", tone: "neutral" }, CONFIRMADA: { label: "confirmada", tone: "success" },
  DESCONHECIDA: { label: "desconhecida", tone: "danger" }, NAO_REALIZADA: { label: "não realizada", tone: "danger" },
};

/** NF-e de entrada: as que a SEFAZ aponta contra o CNPJ (MDe, com manifestação) e as já importadas no recebimento (compras). */
export default async function NotasRecebidasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fiscal.read");
  const sp = await searchParams;
  const canWrite = can(session, "fiscal.write");
  const supabase = await createClient();
  const [{ data: dfe }, { data: states }] = await Promise.all([
    supabase.schema("fiscal").from("inbound_dfe").select("id, access_key, issuer_name, issuer_cnpj, amount, issue_at, manifest_status, manifest_requested, xml_downloaded, last_error, document_id").order("issue_at", { ascending: false }).limit(100),
    supabase.schema("fiscal").from("dfe_sync_state").select("last_run_at, last_found, last_error"),
  ]);
  const waiting = (dfe ?? []).some((d) => d.manifest_requested && d.manifest_requested !== d.manifest_status && !d.last_error);
  const lastRun = (states ?? []).map((x) => x.last_run_at).filter(Boolean).sort().pop();
  const syncError = (states ?? []).find((x) => x.last_error)?.last_error;
  const { data: docs } = await supabase.schema("fiscal").from("documents")
    .select("id, number, series, access_key, issue_at, status, totals, counterpart_name, counterpart_cnpj, operation_nature, receipt_id")
    .eq("direction", "IN").order("issue_at", { ascending: false }).limit(200);
  const rids = (docs ?? []).map((d) => d.receipt_id).filter(Boolean) as string[];
  const { data: receipts } = rids.length ? await supabase.schema("purch").from("receipts").select("id, number, status").in("id", rids) : { data: [] as { id: string; number: string; status: string }[] };
  const rmap = new Map((receipts ?? []).map((r) => [r.id, r]));
  const total = (docs ?? []).reduce((s, d) => s + Number((d.totals as Record<string, number> | null)?.vNF ?? 0), 0);

  return (
    <>
      <PageHeader title="Notas recebidas" description={`NF-e de fornecedores importadas no recebimento — ${(docs ?? []).length} nota(s), ${formatBRL(total)}. Cada nota alimenta estoque, contas a pagar e o pacote do contador.`} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(str(sp.wait) || waiting) && <AutoRefresh />}

      <Card title="Notas emitidas contra o seu CNPJ (SEFAZ)" className="mb-5"
        action={canWrite ? <form action={syncDfeAction}><Button variant="secondary" className="px-2 py-1 text-xs">Buscar agora</Button></form> : undefined}>
        <p className="mb-3 text-xs text-muted">
          A busca roda sozinha a cada 2 horas{lastRun ? ` (última: ${new Date(lastRun).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })})` : ""}.
          A manifestação do destinatário tem efeito legal e é sempre decidida por uma pessoa: <b>ciência</b> libera o XML; <b>confirmar</b> reconhece a compra; <b>desconhecer</b> ou <b>não realizada</b> exigem justificativa (15 a 255 caracteres).
        </p>
        {syncError && <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">A última busca falhou: {syncError}</p>}
        {(dfe ?? []).length === 0 ? <p className="text-sm text-muted">Nada por aqui ainda. Conecte o Focus NFe em Configurações › Integrações e use “Buscar agora”.</p> : (
          <Table head={["Emissão", "Fornecedor", "Valor", "Manifestação", "XML", canWrite ? "Manifestar" : ""]}>
            {(dfe ?? []).map((d) => {
              const m = MANIFEST[d.manifest_status] ?? MANIFEST.PENDING;
              const conclusive = ["CONFIRMADA", "DESCONHECIDA", "NAO_REALIZADA"].includes(d.manifest_status);
              return (
                <tr key={d.id}>
                  <td className="px-3 py-2 whitespace-nowrap">{d.issue_at ? fmtDate(d.issue_at.slice(0, 10)) : "—"}</td>
                  <td className="px-3 py-2">{d.issuer_name ?? "—"}<span className="block text-[11px] text-muted">{d.issuer_cnpj}</span></td>
                  <td className="px-3 py-2 font-medium">{formatBRL(Number(d.amount ?? 0))}</td>
                  <td className="px-3 py-2">
                    <Badge tone={m.tone}>{m.label}</Badge>
                    {d.manifest_requested && d.manifest_requested !== d.manifest_status && !d.last_error && <span className="ml-1 text-[11px] text-muted">enviando…</span>}
                    {d.last_error && <span className="block text-[11px] text-danger">{d.last_error}</span>}
                  </td>
                  <td className="px-3 py-2">{d.xml_downloaded ? <a className="text-brand" href={`/fiscal/recebidas/xml/${d.id}`}>baixar</a> : <span className="text-xs text-muted">{d.manifest_status === "PENDING" ? "dê ciência" : "aguardando"}</span>}</td>
                  <td className="px-3 py-2">
                    {canWrite && !conclusive && (
                      <form action={manifestAction} className="flex flex-wrap items-center gap-1">
                        <input type="hidden" name="id" value={d.id} />
                        <select name="type" className={`${inputClass} w-36 py-1 text-xs`} aria-label="Manifestação" defaultValue={d.manifest_status === "PENDING" ? "CIENCIA" : "CONFIRMADA"}>
                          {d.manifest_status === "PENDING" && <option value="CIENCIA">Ciência da operação</option>}
                          <option value="CONFIRMADA">Confirmar operação</option>
                          <option value="DESCONHECIDA">Desconheço a operação</option>
                          <option value="NAO_REALIZADA">Operação não realizada</option>
                        </select>
                        <input name="reason" maxLength={255} placeholder="Justificativa (desconhecer / não realizada)" className={`${inputClass} w-56 py-1 text-xs`} aria-label="Justificativa" />
                        <Button variant="secondary" className="px-2 py-1 text-xs">Enviar</Button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
      <h2 className="mb-2 text-sm font-semibold text-muted">Já importadas no recebimento</h2>
      {(docs ?? []).length === 0 ? <Empty title="Nenhuma nota recebida">Importe o XML em Produtos › Recebimento de NF-e.</Empty> : (
        <Table head={["Nota", "Emissão", "Fornecedor", "Natureza", "Valor", "Situação", "Recebimento", "Chave"]}>
          {(docs ?? []).map((d) => {
            const r = d.receipt_id ? rmap.get(d.receipt_id) : undefined;
            return (
              <tr key={d.id}>
                <td className="px-3 py-2 font-medium">{d.number}/{d.series}</td>
                <td className="px-3 py-2 whitespace-nowrap">{d.issue_at ? fmtDate(d.issue_at.slice(0, 10)) : "—"}</td>
                <td className="px-3 py-2">{d.counterpart_name}<span className="block text-[11px] text-muted">{d.counterpart_cnpj}</span></td>
                <td className="px-3 py-2">{d.operation_nature ?? "—"}</td>
                <td className="px-3 py-2 font-medium">{formatBRL(Number((d.totals as Record<string, number> | null)?.vNF ?? 0))}</td>
                <td className="px-3 py-2"><Badge tone={d.status === "AUTHORIZED" ? "success" : "neutral"}>{d.status === "AUTHORIZED" ? "autorizada" : d.status.toLowerCase()}</Badge></td>
                <td className="px-3 py-2">{r ? <Link className="text-brand" href={`/produtos/recebimento/${r.id}`}>{r.number}</Link> : "—"}</td>
                <td className="px-3 py-2 font-mono text-[10px] text-muted">{d.access_key}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
