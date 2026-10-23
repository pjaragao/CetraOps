import Link from "next/link";
import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, PageHeader, Table } from "@/components/ui";
import { Flash, fmtDate } from "@/components/form";
import { AutoRefresh } from "@/components/auto-refresh";
import { CopyButton } from "@/components/copy-button";
import { DESTINATION_LABEL, FIN_NFE, ITEM_DEST, MOD_FRETE, SOURCE_LABEL, T_PAG, fmtCnpj, fmtKey, fmtNcm, nfeExtras, type DfeTriage, type NfeParsed } from "@/lib/nfe-view";
import { reopenDfeDestinationAction, requestDfeTriageAction } from "../../actions";
import { InboundReceiveButton } from "../../receive-inbound-dialog";
import { DestinationForm } from "./destination-form";

export const metadata = { title: "Nota fiscal recebida" };

const dt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const qty = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 4 });

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return v ? <li className="flex justify-between gap-3"><span className="shrink-0 text-muted">{k}</span><span className="text-right">{v}</span></li> : null;
}

/** NF-e recebida em formato de leitura (estilo DANFE) e, enquanto não tem destino, a sugestão da IA para confirmar. */
export default async function NotaRecebidaPage({ params, searchParams }: { params: Promise<{ chave: string }>; searchParams: SP }) {
  const session = await requirePerm("fiscal.read");
  const { chave } = await params;
  const sp = await searchParams;
  const key = chave.replace(/\D/g, "");
  const supabase = await createClient();
  const [{ data: dfe }, { data: doc }] = await Promise.all([
    supabase.schema("fiscal").from("inbound_dfe").select("*").eq("access_key", key).maybeSingle(),
    supabase.schema("fiscal").from("documents").select("id, xml, receipt_id").eq("access_key", key).eq("direction", "IN").maybeSingle(),
  ]);
  if (!dfe && !doc) notFound();
  const xml = dfe?.xml || doc?.xml || null;
  const canFin = can(session, "fin.write"), canPurch = can(session, "purch.write"), canFiscal = can(session, "fiscal.write");

  if (!xml) {
    return (
      <>
        <PageHeader title={`Nota de ${dfe?.issuer_name ?? "fornecedor"}`} description={`${formatBRL(Number(dfe?.amount ?? 0))} · chave ${fmtKey(key)}`}
          actions={<Link href="/fiscal/recebidas" className="text-sm text-brand">← Notas recebidas</Link>} />
        <Card><p className="text-sm text-muted">O XML desta nota ainda não foi liberado pela SEFAZ. Dê ciência da operação na lista de notas; o sistema baixa sozinho em seguida.</p></Card>
      </>
    );
  }

  const { data: parsed, error } = await supabase.schema("fiscal").rpc("parse_nfe", { p_xml: xml });
  if (error || !parsed) return <Card><p className="text-sm text-danger">Não consegui ler o XML desta nota: {error?.message}</p></Card>;
  const nf = parsed as unknown as NfeParsed;
  const ex = nfeExtras(xml);
  const total = Number(nf.totals.vNF ?? 0);
  const triage = (dfe?.triage ?? null) as unknown as DfeTriage | null;

  const [{ data: receipt }, { data: title }, { data: linked }, { data: accounts }, { data: locations }] = await Promise.all([
    doc?.receipt_id ? supabase.schema("purch").from("receipts").select("id, number, status").eq("id", doc.receipt_id).maybeSingle() : Promise.resolve({ data: null }),
    dfe?.destination_title_id ? supabase.schema("fin").from("titles").select("id, number, approval_status, status").eq("id", dfe.destination_title_id).maybeSingle() : Promise.resolve({ data: null }),
    dfe?.reimbursement_ids?.length ? supabase.schema("fin").from("reimbursements").select("id, number, purpose, total, status").in("id", dfe.reimbursement_ids) : Promise.resolve({ data: [] as { id: string; number: string; purpose: string; total: number; status: string }[] }),
    supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC").is("archived_at", null).or("code.like.1.2.1.%,code.eq.1.1.3.02,code.like.7.%").order("code"),
    supabase.schema("inv").from("locations").select("id, name, legal_entity_id").in("kind", ["SALES_FLOOR", "BACKROOM"]).order("name"),
  ]);
  const undecided = !!dfe && !dfe.destination && !doc?.receipt_id;
  const { data: paidBy } = dfe?.cash_transaction_id
    ? await supabase.schema("fin").from("cash_transactions").select("id, occurred_on, amount, description").eq("id", dfe.cash_transaction_id).maybeSingle()
    : { data: null };
  // reembolsos para ligar: os que a IA achou (mesmo CNPJ) e, se não achou nenhum, os recentes ainda abertos
  const { data: recent } = undecided && canFin && !(triage?.reembolsos?.length)
    ? await supabase.schema("fin").from("reimbursements").select("id, number, purpose, total, status").neq("status", "CANCELLED").order("created_at", { ascending: false }).limit(30)
    : { data: [] as { id: string; number: string; purpose: string; total: number; status: string }[] };
  const reimbOptions = [
    ...(triage?.reembolsos ?? []).map((r) => ({ id: r.id, number: r.number, purpose: r.purpose, status: r.status, total: Number(r.total), suggested: true })),
    ...(recent ?? []).map((r) => ({ id: r.id, number: r.number, purpose: r.purpose, status: r.status, total: Number(r.total), suggested: false })),
  ];
  const acc = (accounts ?? []).filter((a) => a.code !== "1.2.1.09");
  const assetAccounts = acc.filter((a) => a.code.startsWith("1.2.1.")).map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }));
  const expenseAccounts = acc.filter((a) => !a.code.startsWith("1.2.1.")).map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }));
  const dest = dfe?.destination ? DESTINATION_LABEL[dfe.destination] : null;
  const sug = triage ? DESTINATION_LABEL[triage.destino] : null;
  const running = dfe?.triage_status === "QUEUED" || dfe?.triage_status === "RUNNING";

  return (
    <>
      <PageHeader title={`NF-e ${nf.header.number}/${nf.header.series} · ${nf.issuer.fantasy || nf.issuer.name}`}
        description={`${nf.header.operation_nature ?? "—"} · emitida em ${dt(nf.header.issue_at)} · ${formatBRL(total)}`}
        actions={<div className="flex flex-wrap gap-2">
          {dfe && <a href={`/fiscal/recebidas/xml/${dfe.id}`} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2">Baixar XML</a>}
          <Link href="/fiscal/recebidas" className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Notas recebidas</Link>
        </div>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {nf.header.tp_amb === "2" && <p className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">Nota de homologação (teste da SEFAZ): sem valor fiscal.</p>}

      {/* ---------------- destino ---------------- */}
      <Card className="mb-4" title="Destino da nota">
        {doc?.receipt_id ? (
          <p className="text-sm">Entrou como <Badge tone="info">mercadoria</Badge> pelo recebimento {receipt ? <Link href={`/produtos/recebimento/${receipt.id}`} className="font-mono text-brand">{receipt.number}</Link> : "—"}.</p>
        ) : dfe?.destination && dest ? (
          <div className="space-y-2 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={dest.tone}>{dest.label}</Badge>
              {title && <>conta a pagar <Link href={`/financeiro/titulos/${title.id}`} className="font-mono text-brand">{title.number}</Link> <Badge tone={title.status === "CANCELLED" ? "neutral" : title.approval_status === "APPROVED" ? "success" : "warning"}>{title.status === "CANCELLED" ? "cancelada" : title.approval_status === "APPROVED" ? "aprovada" : "rascunho: aprove em Contas a pagar"}</Badge></>}
              {(linked ?? []).map((r) => <Link key={r.id} href={`/financeiro/reembolsos/${r.id}`} className="font-mono text-xs text-brand">{r.number}</Link>)}
              {paidBy && <Link href="/financeiro/movimentacoes" className="text-xs text-brand">pagamento de {formatBRL(Math.abs(Number(paidBy.amount)))} em {fmtDate(paidBy.occurred_on)}{dfe.statement_line_id ? " (extrato conciliado)" : ""}</Link>}
              {dfe.destination_note && <span className="text-muted">— {dfe.destination_note}</span>}
            </p>
            <p className="text-xs text-muted">Decidido em {dt(dfe.decided_at)}.</p>
            {canFin && !dfe.statement_line_id && (dfe.destination === "PAYABLE" || !title || title.approval_status === "DRAFT" || title.status === "CANCELLED") && (
              <form action={reopenDfeDestinationAction}><input type="hidden" name="id" value={dfe.id} /><input type="hidden" name="key" value={key} />
                <Button variant="ghost" className="px-2 py-1 text-xs">Desfazer e escolher de novo</Button></form>
            )}
            {dfe.statement_line_id && <p className="flex items-center gap-1 text-xs text-muted"><Lock size={11} /> A nota conciliou uma saída do extrato: para mudar, estorne o movimento em Movimentações.</p>}
            {dfe.destination !== "PAYABLE" && title && title.approval_status === "APPROVED" && title.status !== "CANCELLED" && <p className="flex items-center gap-1 text-xs text-muted"><Lock size={11} /> A conta já foi aprovada: para mudar o destino, cancele-a em Contas a pagar.</p>}
          </div>
        ) : undecided ? (
          <div className="space-y-4">
            {running && <><AutoRefresh every={3000} times={20} /><p className="text-sm text-muted">A IA está analisando os itens desta nota…</p></>}
            {dfe?.triage_status === "FAILED" && <p className="text-sm text-danger">A análise falhou: {dfe.triage_note}</p>}
            {triage && sug && (
              <div className="space-y-2">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted">Sugestão da IA:</span><Badge tone={sug.tone}>{sug.label}</Badge><span>{triage.motivo}</span>
                  <span className="text-xs text-muted">· confiança {Math.round(triage.confianca * 100)}%</span>
                </p>
                {triage.alertas.map((a) => <p key={a} className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">{a}</p>)}
                <Table head={["#", "Item", "NCM", "Valor", "Destino sugerido", "Conta", "Por quê"]} totals={false}>
                  {triage.itens.map((i) => (
                    <tr key={i.n}>
                      <td className="px-3 py-2 text-xs">{i.n}</td><td className="px-3 py-2">{i.descricao}</td><td className="px-3 py-2 font-mono text-xs">{fmtNcm(i.ncm)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatBRL(i.valor)}</td>
                      <td className="px-3 py-2"><Badge tone={i.destino === "ESTOQUE" ? "info" : i.destino === "INDEFINIDO" ? "neutral" : "brand"}>{ITEM_DEST[i.destino] ?? i.destino}</Badge></td>
                      <td className="px-3 py-2 text-xs">{i.conta ?? "—"}</td>
                      <td className="px-3 py-2 text-xs text-muted">{i.motivo} <span className="whitespace-nowrap">({SOURCE_LABEL[i.fonte] ?? i.fonte}, {Math.round(i.confianca * 100)}%)</span></td>
                    </tr>
                  ))}
                </Table>
              </div>
            )}
            {triage?.destino === "STOCK" && <p className="text-sm">A IA acha que é <b>mercadoria para revenda</b>: dê entrada no estoque pelo botão abaixo.</p>}
            {canFin && dfe && (
              <DestinationForm id={dfe.id} accessKey={key} total={total} triage={triage} assetAccounts={assetAccounts} expenseAccounts={expenseAccounts}
                reimbursements={reimbOptions} hasInstallments={nf.installments.length > 0} today={todayIsoSP()} />
            )}
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3 text-sm">
              {canPurch && dfe && (
                <><span className="text-muted">É mercadoria para revenda?</span>
                  <InboundReceiveButton dfe={{ id: dfe.id, access_key: dfe.access_key, issuer_name: dfe.issuer_name, issuer_cnpj: dfe.issuer_cnpj, amount: Number(dfe.amount ?? 0), legal_entity_id: dfe.legal_entity_id }} locations={locations ?? []} /></>
              )}
              {canFiscal && dfe && !running && (
                <form action={requestDfeTriageAction} className="ml-auto"><input type="hidden" name="id" value={dfe.id} /><input type="hidden" name="key" value={key} />
                  <Button variant="ghost" className="px-2 py-1 text-xs">Analisar de novo com a IA</Button></form>
              )}
            </div>
          </div>
        ) : <p className="text-sm text-muted">Nota registrada no fiscal.</p>}
      </Card>

      {/* ---------------- DANFE ---------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Emitente">
          <ul className="space-y-1 text-sm">
            <li className="font-medium">{nf.issuer.name}{nf.issuer.fantasy && nf.issuer.fantasy !== nf.issuer.name && <span className="block text-xs font-normal text-muted">{nf.issuer.fantasy}</span>}</li>
            <Row k="CNPJ" v={fmtCnpj(nf.issuer.cnpj)} /><Row k="IE" v={nf.issuer.ie} /><Row k="Endereço" v={ex.issuerAddress} /><Row k="Fone" v={ex.issuerPhone} />
            <Row k="Atividade (CNAE)" v={ex.issuerCnae} /><Row k="Regime" v={nf.issuer.crt === "1" || nf.issuer.crt === "4" ? "Simples Nacional" : nf.issuer.crt === "3" ? "Regime normal" : nf.issuer.crt} />
          </ul>
        </Card>
        <Card title="Destinatário">
          <ul className="space-y-1 text-sm">
            <li className="font-medium">{nf.recipient.name ?? "—"}</li>
            <Row k={nf.recipient.cpf ? "CPF" : "CNPJ"} v={fmtCnpj(nf.recipient.cnpj ?? nf.recipient.cpf)} /><Row k="IE" v={ex.recipientIe} /><Row k="Endereço" v={ex.recipientAddress} />
          </ul>
        </Card>
        <Card title="Dados da nota">
          <ul className="space-y-1 text-sm">
            <Row k="Número / série" v={`${nf.header.number} / ${nf.header.series}`} /><Row k="Emissão" v={dt(nf.header.issue_at)} /><Row k="Saída" v={ex.leftAt ? dt(ex.leftAt) : null} />
            <Row k="Natureza" v={nf.header.operation_nature} /><Row k="Finalidade" v={FIN_NFE[nf.header.fin_nfe] ?? String(nf.header.fin_nfe)} />
            <Row k="Protocolo" v={nf.protocol?.number ? `${nf.protocol.number} · ${dt(nf.protocol.received_at)}` : "sem protocolo no XML"} />
          </ul>
          <div className="mt-3 rounded-lg bg-surface-2 p-2">
            <p className="text-[11px] text-muted">Chave de acesso</p>
            <p className="select-all break-all font-mono text-xs">{fmtKey(nf.access_key)}</p>
            <div className="mt-1"><CopyButton text={nf.access_key} label="Copiar chave" /></div>
          </div>
        </Card>
      </div>

      <h2 className="mb-2 mt-5 text-sm font-semibold">Itens</h2>
      <Table head={["#", "Código", "Descrição", "NCM", "CFOP", "Qtd", "Un", "Valor unit.", "Desconto", "Total"]} totals={[5, 8, 9]}>
        {nf.items.map((i) => (
          <tr key={i.n_item}>
            <td className="px-3 py-2 text-xs">{i.n_item}</td><td className="px-3 py-2 font-mono text-xs">{i.cprod}</td>
            <td className="px-3 py-2">{i.xprod}{i.cean && i.cean !== "SEM GTIN" && <span className="block text-[11px] text-muted">EAN {i.cean}</span>}</td>
            <td className="px-3 py-2 font-mono text-xs">{fmtNcm(i.ncm)}</td><td className="px-3 py-2 font-mono text-xs">{i.cfop}</td>
            <td className="px-3 py-2 tabular-nums">{qty(Number(i.qcom))}</td><td className="px-3 py-2 text-xs">{i.ucom}</td>
            <td className="px-3 py-2 tabular-nums">{formatBRL(Number(i.vuncom))}</td><td className="px-3 py-2 tabular-nums">{formatBRL(Number(i.vdesc))}</td>
            <td className="px-3 py-2 tabular-nums font-medium">{formatBRL(Number(i.vprod) - Number(i.vdesc))}</td>
          </tr>
        ))}
      </Table>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Totais">
          <ul className="space-y-1 text-sm">
            <Row k="Produtos" v={formatBRL(nf.totals.vProd ?? 0)} />
            {(["vFrete", "vSeg", "vOutro", "vIPI", "vST"] as const).map((k) => Number(nf.totals[k] ?? 0) > 0 ? <Row key={k} k={{ vFrete: "Frete", vSeg: "Seguro", vOutro: "Outras despesas", vIPI: "IPI", vST: "ICMS ST" }[k]} v={formatBRL(nf.totals[k])} /> : null)}
            {Number(nf.totals.vDesc ?? 0) > 0 && <Row k="Desconto" v={`− ${formatBRL(nf.totals.vDesc)}`} />}
            <li className="flex justify-between gap-3 border-t border-border pt-1 font-semibold"><span>Total da nota</span><span>{formatBRL(total)}</span></li>
          </ul>
        </Card>
        <Card title="Pagamento">
          <ul className="space-y-1 text-sm">
            {nf.payments.map((p, i) => <Row key={i} k={T_PAG[p.t_pag] ?? `forma ${p.t_pag}`} v={formatBRL(p.amount)} />)}
            {nf.payments.length === 0 && <li className="text-muted">Sem informação de pagamento.</li>}
          </ul>
          {nf.installments.length > 0 && (
            <>
              <p className="mt-3 text-xs font-medium text-muted">Duplicatas</p>
              <ul className="space-y-1 text-sm">{nf.installments.map((d, i) => <Row key={i} k={`${d.n_dup ?? i + 1} · vence ${fmtDate(d.due_date)}`} v={formatBRL(d.amount)} />)}</ul>
            </>
          )}
        </Card>
        <Card title="Transporte">
          <ul className="space-y-1 text-sm">
            <Row k="Frete" v={MOD_FRETE[nf.header.mod_frete ?? ""] ?? nf.header.mod_frete} />
            {ex.carrier && <Row k="Transportadora" v={<>{ex.carrier.name}<span className="block text-xs text-muted">{[fmtCnpj(ex.carrier.doc), ex.carrier.city].filter(Boolean).join(" · ")}</span></>} />}
            {ex.volumes && <Row k="Volumes" v={[ex.volumes.qty, ex.volumes.kind].filter(Boolean).join(" ") + (ex.volumes.gross ? ` · ${Number(ex.volumes.gross).toLocaleString("pt-BR")} kg` : "")} />}
          </ul>
        </Card>
      </div>

      {(nf.header.info || ex.fiscoInfo) && (
        <Card className="mt-4" title="Informações complementares">
          {nf.header.info && <p className="whitespace-pre-line text-sm">{nf.header.info}</p>}
          {ex.fiscoInfo && <p className="mt-2 whitespace-pre-line text-xs text-muted">Fisco: {ex.fiscoInfo}</p>}
        </Card>
      )}
    </>
  );
}
