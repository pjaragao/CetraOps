import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, PageHeader, Table, inputClass } from "@/components/ui";
import { Flash, fmtDate } from "@/components/form";
import { fetchDfeByKeyAction, manifestAction, syncDfeAction } from "./actions";
import { InboundReceiveButton } from "./receive-inbound-dialog";
import { SyncStatus } from "./sync-status";
import { DESTINATION_LABEL } from "@/lib/nfe-view";

export const metadata = { title: "Notas recebidas" };

const fmtDoc = (v: string | null) => (v ?? "").replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5").replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");

const MANIFEST: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" }> = {
  PENDING: { label: "sem manifestação", tone: "warning" }, CIENCIA: { label: "ciência", tone: "neutral" }, CONFIRMADA: { label: "confirmada", tone: "success" },
  DESCONHECIDA: { label: "desconhecida", tone: "danger" }, NAO_REALIZADA: { label: "não realizada", tone: "danger" },
};

/** NF-e de entrada: as que a SEFAZ aponta contra o CNPJ (MDe, com manifestação) e as já importadas no recebimento (compras). */
export default async function NotasRecebidasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fiscal.read");
  const sp = await searchParams;
  const canWrite = can(session, "fiscal.write");
  const canPurch = can(session, "purch.write");
  const supabase = await createClient();
  const [{ data: dfe }, { data: states }, { data: locations }] = await Promise.all([
    supabase.schema("fiscal").from("inbound_dfe").select("id, access_key, issuer_name, issuer_cnpj, amount, issue_at, manifest_status, manifest_requested, xml_downloaded, last_error, document_id, legal_entity_id, triage_status, triage, destination, destination_title_id").order("issue_at", { ascending: false }).limit(100),
    supabase.schema("fiscal").from("dfe_sync_state").select("last_run_at, last_found, last_error"),
    supabase.schema("inv").from("locations").select("id, name, legal_entity_id").in("kind", ["SALES_FLOOR", "BACKROOM"]).order("name"),
  ]);
  const waiting = (dfe ?? []).some((d) => (d.manifest_requested && d.manifest_requested !== d.manifest_status && !d.last_error)
    || (!d.destination && !d.document_id && (d.triage_status === "QUEUED" || d.triage_status === "RUNNING")));   // a IA ainda analisando
  const dfeByKey = new Map((dfe ?? []).map((d) => [d.access_key, d]));
  const titleIds = (dfe ?? []).map((d) => d.destination_title_id).filter(Boolean) as string[];
  const { data: titles } = titleIds.length ? await supabase.schema("fin").from("titles").select("id, number").in("id", titleIds) : { data: [] as { id: string; number: string }[] };
  const titleNo = new Map((titles ?? []).map((t) => [t.id, t.number]));
  const lastRun = (states ?? []).map((x) => x.last_run_at).filter(Boolean).sort().pop();
  const lastRunLabel = lastRun ? new Date(lastRun).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }) : null;
  const syncError = (states ?? []).find((x) => x.last_error)?.last_error;
  const { data: docs } = await supabase.schema("fiscal").from("documents")
    .select("id, number, series, access_key, issue_at, status, totals, counterpart_name, counterpart_cnpj, operation_nature, receipt_id")
    .eq("direction", "IN").order("issue_at", { ascending: false }).limit(200);
  const rids = (docs ?? []).map((d) => d.receipt_id).filter(Boolean) as string[];
  const { data: receipts } = rids.length ? await supabase.schema("purch").from("receipts").select("id, number, status").in("id", rids) : { data: [] as { id: string; number: string; status: string }[] };
  const rmap = new Map((receipts ?? []).map((r) => [r.id, r]));
  const docByKey = new Map((docs ?? []).map((d) => [d.access_key, d]));
  const total = (docs ?? []).reduce((s, d) => s + Number((d.totals as Record<string, number> | null)?.vNF ?? 0), 0);

  return (
    <>
      <PageHeader title="Notas recebidas"
        description={`${(docs ?? []).length} nota(s) importada(s) — ${formatBRL(total)}. Cada nota alimenta estoque, contas a pagar e o pacote do contador.`}
        actions={<SyncStatus active={Boolean(str(sp.wait)) || waiting} updatedAt={lastRunLabel} />} />
      <Flash ok={str(sp.wait) ? undefined : str(sp.ok)} erro={str(sp.erro)} />

      <Card title="Notas emitidas contra o seu CNPJ (SEFAZ)" className="mb-5"
        action={canWrite ? <form action={syncDfeAction}><Button variant="secondary" className="px-2 py-1 text-xs">Buscar agora</Button></form> : undefined}>
        <p className="mb-3 text-xs text-muted">
          Busca automática a cada 2 horas{lastRun ? ` · última: ${new Date(lastRun).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : ""}.
        </p>
        {syncError && <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">A última busca falhou: {syncError}</p>}
        {(dfe ?? []).length === 0 ? <p className="text-sm text-muted">Nada por aqui ainda. Conecte a SEFAZ direta (certificado A1), o Focus NFe ou a Brasil NFe em Configurações › Integrações e use “Buscar agora”. Pela SEFAZ direta, a busca respeita a espera de 1 hora exigida quando não há nota nova.</p> : (
          <Table head={["Fornecedor", "Valor", "Manifestação", "Destino", canWrite ? "Manifestar" : ""]}>
            {(dfe ?? []).map((d) => {
              const m = MANIFEST[d.manifest_status] ?? MANIFEST.PENDING;
              const conclusive = ["CONFIRMADA", "DESCONHECIDA", "NAO_REALIZADA"].includes(d.manifest_status);
              const matchedDoc = docByKey.get(d.access_key);
              const matchedReceipt = matchedDoc?.receipt_id ? rmap.get(matchedDoc.receipt_id) : undefined;

              return (
                <tr key={d.id}>
                  <td className="px-3 py-2">
                    <span className="font-medium">{d.issuer_name ?? "—"}</span>
                    <span className="block text-[11px] text-muted">{fmtDoc(d.issuer_cnpj)}{d.issue_at ? ` · emitida em ${fmtDate(d.issue_at.slice(0, 10))}` : ""}</span>
                  </td>
                  <td className="px-3 py-2 font-medium whitespace-nowrap">{formatBRL(Number(d.amount ?? 0))}</td>
                  <td className="px-3 py-2">
                    <Badge tone={m.tone}>{m.label}</Badge>
                    {d.manifest_requested && d.manifest_requested !== d.manifest_status && !d.last_error && <span className="ml-1 text-[11px] text-muted">enviando…</span>}
                    {d.last_error && !d.xml_downloaded && <span className="block text-[11px] text-danger">{d.last_error}</span>}
                  </td>
                  <td className="px-3 py-2">
                    {d.destination ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={DESTINATION_LABEL[d.destination]?.tone ?? "neutral"}>{DESTINATION_LABEL[d.destination]?.label ?? d.destination}</Badge>
                        {d.destination_title_id && <Link className="text-xs font-medium text-brand hover:underline" href={`/financeiro/titulos/${d.destination_title_id}`}>{titleNo.get(d.destination_title_id) ?? "conta a pagar"}</Link>}
                        <Link className="text-xs text-muted hover:text-brand" href={`/fiscal/recebidas/nota/${d.access_key}`}>ver nota</Link>
                      </div>
                    ) : matchedReceipt ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="success">Importada</Badge>
                        <Link className="text-xs font-medium text-brand hover:underline" href={`/produtos/recebimento/${matchedReceipt.id}`}>
                          {matchedReceipt.number}
                        </Link>
                        <Link className="text-xs text-muted hover:text-brand" href={`/fiscal/recebidas/nota/${d.access_key}`}>ver nota</Link>
                      </div>
                    ) : d.xml_downloaded ? (
                      <div className="flex flex-wrap items-center gap-2">
                        {(() => {
                          const t = d.triage as { destino?: string; confianca?: number } | null;
                          if (d.triage_status === "QUEUED" || d.triage_status === "RUNNING") return <span className="text-xs text-muted">IA analisando o destino…</span>;
                          if (!t?.destino || t.destino === "STOCK") return t?.destino === "STOCK" ? <Badge tone="info">IA: mercadoria</Badge> : null;
                          return (
                            <Link href={`/fiscal/recebidas/nota/${d.access_key}`} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-brand-contrast hover:opacity-90">
                              IA: {DESTINATION_LABEL[t.destino]?.label ?? t.destino} · confirmar
                            </Link>
                          );
                        })()}
                        {canPurch && ((d.triage as { destino?: string } | null)?.destino ?? "STOCK") === "STOCK" && (
                          <InboundReceiveButton
                            dfe={{
                              id: d.id,
                              access_key: d.access_key,
                              issuer_name: d.issuer_name,
                              issuer_cnpj: d.issuer_cnpj,
                              amount: Number(d.amount ?? 0),
                              legal_entity_id: d.legal_entity_id,
                            }}
                            locations={locations ?? []}
                          />
                        )}
                        <Link className="text-xs text-muted hover:text-brand" href={`/fiscal/recebidas/nota/${d.access_key}`}>ver nota</Link>
                        <a className="text-xs text-muted hover:text-brand" href={`/fiscal/recebidas/xml/${d.id}`} title="Baixar arquivo XML para arquivo/backup">
                          baixar XML
                        </a>
                      </div>
                    ) : (
                      d.manifest_status === "PENDING" ? <span className="text-xs text-muted">dê ciência para liberar o XML</span> : (
                        <span className="text-xs text-muted">
                          aguardando a SEFAZ liberar o XML (o sistema tenta de novo sozinho).
                          {canPurch && <> Com pressa? Peça o XML ao fornecedor e <Link className="text-brand" href="/produtos/recebimento">importe no Recebimento</Link>.</>}
                        </span>
                      )
                    )}
                  </td>
                  {canWrite && (
                    <td className="px-3 py-2 align-top">
                      {!conclusive && (
                        <details className="group">
                          <summary className="cursor-pointer text-xs font-medium text-brand hover:underline">
                            {d.manifest_status === "PENDING" ? "Dar ciência / manifestar" : "Manifestar"}
                          </summary>
                          <form action={manifestAction} className="mt-2 flex flex-col gap-2">
                            <input type="hidden" name="id" value={d.id} />
                            <select name="type" className={`${inputClass} w-52 py-1 text-xs`} aria-label="Manifestação" defaultValue={d.manifest_status === "PENDING" ? "CIENCIA" : "CONFIRMADA"}>
                              {d.manifest_status === "PENDING" && <option value="CIENCIA">Ciência da operação</option>}
                              <option value="CONFIRMADA">Confirmar operação</option>
                              <option value="DESCONHECIDA">Desconheço a operação</option>
                              <option value="NAO_REALIZADA">Operação não realizada</option>
                            </select>
                            <input name="reason" maxLength={255} placeholder="Justificativa (só para desconhecer / não realizada)" className={`${inputClass} w-64 py-1 text-xs`} aria-label="Justificativa" />
                            <Button variant="secondary" className="w-fit px-2 py-1 text-xs">Enviar</Button>
                          </form>
                        </details>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </Table>
        )}

        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer hover:text-brand">Como funciona a manifestação</summary>
          <p className="mt-2">
            A manifestação do destinatário tem efeito legal e é sempre decidida por uma pessoa: <b>ciência</b> libera o XML; <b>confirmar</b> reconhece a compra;
            {" "}<b>desconhecer</b> ou <b>não realizada</b> exigem justificativa (15 a 255 caracteres).
          </p>
        </details>

        {canWrite && (
          <details className="mt-2 text-xs text-muted">
            <summary className="cursor-pointer hover:text-brand">Nota não apareceu? Buscar pela chave de acesso</summary>
            <form action={fetchDfeByKeyAction} className="mt-2 flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 text-xs text-muted">Chave de acesso (44 dígitos do DANFE)
                <input name="key" required inputMode="numeric" maxLength={60} placeholder="0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000" className={`${inputClass} mt-1 font-mono`} />
              </label>
              <Button variant="secondary" className="px-3 py-2 text-xs">Buscar pela chave</Button>
              <span className="w-full text-[11px]">A busca automática só traz notas emitidas depois do primeiro uso (regra da SEFAZ, sem notas retroativas). Para uma nota anterior, use a chave. Limite da SEFAZ: 20 consultas por hora.</span>
            </form>
          </details>
        )}
      </Card>
      <h2 className="mb-2 text-sm font-semibold text-muted">Notas lançadas</h2>
      {(docs ?? []).length === 0 ? <Empty title="Nenhuma nota lançada">Mercadoria entra pelo recebimento (Produtos › Recebimento de NF-e); patrimônio e despesa, pelo destino da nota acima.</Empty> : (
        <Table head={["Nota", "Fornecedor", "Natureza", "Valor", "Situação", "Destino", ""]}>
          {(docs ?? []).map((d) => {
            const r = d.receipt_id ? rmap.get(d.receipt_id) : undefined;
            return (
              <tr key={d.id}>
                <td className="px-3 py-2 font-medium whitespace-nowrap">{d.number}/{d.series}<span className="block text-[11px] font-normal text-muted">{d.issue_at ? fmtDate(d.issue_at.slice(0, 10)) : "—"}</span></td>
                <td className="px-3 py-2">{d.counterpart_name}<span className="block text-[11px] text-muted">{fmtDoc(d.counterpart_cnpj)}</span></td>
                <td className="px-3 py-2">{d.operation_nature ?? "—"}</td>
                <td className="px-3 py-2 font-medium">{formatBRL(Number((d.totals as Record<string, number> | null)?.vNF ?? 0))}</td>
                <td className="px-3 py-2"><Badge tone={d.status === "AUTHORIZED" ? "success" : "neutral"}>{d.status === "AUTHORIZED" ? "autorizada" : d.status.toLowerCase()}</Badge></td>
                <td className="px-3 py-2">{r ? <>estoque · <Link className="text-brand" href={`/produtos/recebimento/${r.id}`}>{r.number}</Link></>
                  : (() => { const x = dfeByKey.get(d.access_key ?? ""); return x?.destination ? <Badge tone={DESTINATION_LABEL[x.destination]?.tone ?? "neutral"}>{DESTINATION_LABEL[x.destination]?.label ?? x.destination}</Badge> : "—"; })()}</td>
                <td className="px-3 py-2">{d.access_key && <Link className="text-xs text-brand" href={`/fiscal/recebidas/nota/${d.access_key}`}>ver nota</Link>}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
