import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, LinkButton, PageHeader, Stat, Table } from "@/components/ui";
import { Field, Flash, fmtDate } from "@/components/form";
import { cancelOrderAction, createLinkAction, emitOrderInvoiceAction, registerPaymentAction, saveShipmentAction, setOrderStatusAction } from "../../actions";
import { resolveItems } from "../../../produtos/compras/options";
import { StonePosOrderButton } from "./stone-pos-order-button";

export const metadata = { title: "Pedido" };

const STATUS: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  DRAFT: { label: "rascunho", tone: "neutral" }, CONFIRMED: { label: "confirmado", tone: "info" }, PENDING_PAYMENT: { label: "aguardando pagamento", tone: "warning" },
  PAID: { label: "pago", tone: "success" }, FULFILLING: { label: "em separação", tone: "info" }, READY_FOR_PICKUP: { label: "pronto para retirar", tone: "info" },
  SHIPPED: { label: "enviado", tone: "info" }, COMPLETED: { label: "concluído", tone: "success" }, CANCELLED: { label: "cancelado", tone: "danger" },
  PARTIALLY_RETURNED: { label: "devolvido em parte", tone: "warning" }, RETURNED: { label: "devolvido", tone: "danger" },
};
const METHOD: Record<string, string> = { PIX: "Pix", DEBIT: "Débito", CREDIT: "Crédito", CASH: "Dinheiro", PAYMENT_LINK: "Link", BOLETO: "Boleto", STORE_CREDIT: "Vale-troca", PERMUTA: "Permuta", B2B_INVOICE: "Fatura B2B" };
const CARRIER: Record<string, string> = { MOTOBOY_OWN: "Motoboy", MELHOR_ENVIO: "Melhor Envio", PICKUP_LOCKER: "Armário VIP", PICKUP_STORE: "Retirada na loja", OTHER: "Outro" };
const SHIP: Record<string, string> = { PENDING: "pendente", IN_TRANSIT: "a caminho", DELIVERED: "entregue", FAILED: "falhou", CANCELLED: "cancelada" };

export default async function PedidoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("sales.read");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: o } = await supabase.schema("sales").from("orders").select("*").eq("id", id).maybeSingle();
  if (!o) notFound();
  const [{ data: items }, { data: pays }, { data: links }, { data: ships }, { data: returns }, { data: party }, { data: fiscalDocRaw }] = await Promise.all([
    supabase.schema("sales").from("order_items").select("id, variant_id, description, qty, list_price, unit_price, discount_amount, total, returned_qty").eq("order_id", id).order("line_no"),
    supabase.schema("sales").from("payments").select("id, method, amount, installments, acquirer, nsu, status, created_at").eq("order_id", id).order("created_at"),
    supabase.schema("sales").from("payment_links").select("id, provider, url, amount, max_installments, status, expires_at").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.schema("sales").from("shipments").select("id, carrier, tracking, cost, charged, status, shipped_at, delivered_at").eq("order_id", id).order("created_at"),
    supabase.schema("sales").from("returns").select("id, number, type, amount, refund_method, created_at").eq("order_id", id).order("created_at"),
    o.party_id ? supabase.schema("crm").from("parties").select("id, display_name").eq("id", o.party_id).maybeSingle() : Promise.resolve({ data: null }),
    (supabase as unknown as { schema: (s: string) => { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> } }).schema("sales").rpc("get_order_fiscal_doc", { p_order: id }),
  ]);
  const fiscalDoc = fiscalDocRaw as {
    id: string; number: number; series: number; model: string; status: string;
    access_key?: string | null; danfe_path?: string | null; xml_path?: string | null;
    issued_at?: string | null; rejection_reason?: string | null;
  } | null;
  const labels = await resolveItems((items ?? []).flatMap((i) => i.variant_id ? [{ variant_id: i.variant_id, qty: 0, unit_cost: 0 }] : []));
  const lmap = new Map(labels.map((l) => [l.variant_id, l]));
  const st = STATUS[o.status] ?? { label: o.status, tone: "neutral" as const };
  const canWrite = can(session, "sales.write");
  const pending = o.status === "PENDING_PAYMENT";
  const balance = Number(o.total) - Number(o.paid_total);
  const isPaidOrBeyond = ["PAID", "COMPLETED", "FULFILLING", "READY_FOR_PICKUP", "SHIPPED"].includes(o.status);
  const delivery = isPaidOrBeyond;
  const returnable = ["PAID", "COMPLETED", "FULFILLING", "READY_FOR_PICKUP", "SHIPPED", "PARTIALLY_RETURNED"].includes(o.status);

  return (
    <>
      <PageHeader title={`Pedido ${o.number}`} description={`${o.channel} · ${new Date(o.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}${party ? ` · ${party.display_name}` : ""}`}
        actions={<><Badge tone={st.tone}>{st.label}</Badge>{returnable && canWrite && <LinkButton href={`/vender/trocas/nova?n=${o.number}`}>Trocar / devolver</LinkButton>}<LinkButton href="/vender/pedidos">Voltar</LinkButton></>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total" value={formatBRL(o.total)} hint={Number(o.discount_total) > 0 ? `desconto ${formatBRL(o.discount_total)}` : undefined} />
        <Stat label="Pago" value={formatBRL(o.paid_total)} tone={balance <= 0 ? "success" : undefined} />
        <Stat label="Saldo" value={formatBRL(Math.max(balance, 0))} tone={balance > 0 ? "warning" : undefined} />
        <Stat label="Entrega" value={o.fulfillment_type} hint={o.assisted_by_ai ? "atendimento com IA" : undefined} />
      </div>

      <Table head={["Peça", "Qtd", "Devolvida", "Preço", "Desconto", "Total"]}>
        {(items ?? []).map((i) => (
          <tr key={i.id}>
            <td className="px-3 py-2">
              {i.variant_id ? (
                <>
                  <span className="font-mono text-xs text-muted">{lmap.get(i.variant_id)?.sku}</span> {lmap.get(i.variant_id)?.label}
                </>
              ) : (
                <>
                  <span className="mr-1.5 inline-flex"><Badge tone="neutral">Avulso</Badge></span>
                  <span className="font-medium">{i.description || "Item avulso"}</span>
                </>
              )}
            </td>
            <td className="px-3 py-2">{Number(i.qty)}</td><td className="px-3 py-2">{Number(i.returned_qty) || "—"}</td>
            <td className="px-3 py-2">{formatBRL(i.list_price)}</td><td className="px-3 py-2">{Number(i.discount_amount) > 0 ? formatBRL(i.discount_amount) : "—"}</td>
            <td className="px-3 py-2 font-medium">{formatBRL(i.total)}</td>
          </tr>
        ))}
      </Table>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Pagamentos">
          {(pays ?? []).length === 0 ? <p className="text-sm text-muted">Nenhum pagamento ainda.</p> : (
            <ul className="divide-y divide-border text-sm">{(pays ?? []).map((p) => (
              <li key={p.id} className="flex justify-between py-1.5"><span>{METHOD[p.method] ?? p.method}{p.installments > 1 ? ` ${p.installments}x` : ""}{p.nsu ? <span className="text-xs text-muted"> · NSU {p.nsu}</span> : ""}</span><span className="font-medium">{formatBRL(p.amount)}</span></li>
            ))}</ul>
          )}
          {pending && canWrite && (
            <>
              {balance > 0 && (
                <div className="mt-3 rounded-xl border border-brand/20 bg-brand/5 p-3">
                  <p className="text-xs font-semibold text-brand mb-2">Cobrança presencial integrada</p>
                  <StonePosOrderButton
                    orderId={o.id}
                    orderNumber={o.number}
                    balance={balance}
                    customerName={party?.display_name}
                  />
                </div>
              )}
              <form action={registerPaymentAction} className="mt-3 grid gap-2 border-t border-border pt-3 sm:grid-cols-4">
                <input type="hidden" name="order_id" value={o.id} />
                <Field label="Forma"><select name="method" className={inputClass}><option value="PIX">Pix</option><option value="CREDIT">Crédito</option><option value="DEBIT">Débito</option><option value="PAYMENT_LINK">Link pago</option><option value="CASH">Dinheiro</option></select></Field>
                <Field label="Valor (R$)"><input name="amount" required inputMode="decimal" defaultValue={String(balance.toFixed(2)).replace(".", ",")} className={inputClass} /></Field>
                <Field label="Parcelas"><input name="installments" type="number" min={1} max={12} defaultValue={1} className={inputClass} /></Field>
                <Field label="Adquirente / banco"><input name="acquirer" placeholder="STONE, INTER…" className={inputClass} /></Field>
                <Field label="NSU / e2e Pix" className="sm:col-span-2"><input name="nsu" className={inputClass} /></Field>
                <Field label="ID externo (evita duplicar)" className="sm:col-span-2"><input name="external_id" className={inputClass} /></Field>
                <div className="sm:col-span-4"><Button>Registrar pagamento</Button></div>
              </form>
            </>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Nota Fiscal (NFC-e / NF-e)">
            {fiscalDoc ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge tone={fiscalDoc.status === "AUTHORIZED" ? "success" : fiscalDoc.status === "REJECTED" ? "danger" : "warning"}>
                      {fiscalDoc.status === "AUTHORIZED" ? "Autorizada" : fiscalDoc.status === "REJECTED" ? "Rejeitada" : "Processando na SEFAZ"}
                    </Badge>
                    <span className="font-semibold text-sm">
                      {fiscalDoc.model === "65" ? "NFC-e" : "NF-e"} nº {fiscalDoc.number}/{fiscalDoc.series}
                    </span>
                  </div>
                  {fiscalDoc.issued_at && (
                    <span className="text-xs text-muted">
                      {new Date(fiscalDoc.issued_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}
                    </span>
                  )}
                </div>

                {fiscalDoc.access_key && (
                  <p className="text-xs text-muted">
                    Chave: <span className="font-mono text-foreground break-all">{fiscalDoc.access_key}</span>
                  </p>
                )}

                {fiscalDoc.status === "REJECTED" && fiscalDoc.rejection_reason && (
                  <div className="rounded-lg bg-danger/10 p-2.5 text-xs text-danger">
                    <strong>Motivo da rejeição:</strong> {fiscalDoc.rejection_reason}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {fiscalDoc.danfe_path && (
                    <a
                      href={fiscalDoc.danfe_path}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-brand-contrast hover:opacity-90"
                    >
                      📄 Visualizar DANFE (PDF)
                    </a>
                  )}
                  {canWrite && fiscalDoc.status === "REJECTED" && (
                    <form action={emitOrderInvoiceAction}>
                      <input type="hidden" name="order_id" value={o.id} />
                      <Button variant="secondary" className="px-3 py-1.5 text-xs">
                        Tentar reenviar NF
                      </Button>
                    </form>
                  )}
                </div>
              </div>
            ) : isPaidOrBeyond ? (
              <div className="rounded-xl border border-warning/30 bg-warning/5 p-3">
                <div className="flex items-center gap-2">
                  <Badge tone="warning">Sem NF emitida</Badge>
                  <span className="text-xs text-muted">Pedido pago pronto para emissão fiscal.</span>
                </div>
                {canWrite && (
                  <form action={emitOrderInvoiceAction} className="mt-3">
                    <input type="hidden" name="order_id" value={o.id} />
                    <Button variant="primary" className="w-full sm:w-auto">
                      🧾 Emitir Nota Fiscal (NFC-e / NF-e)
                    </Button>
                  </form>
                )}
              </div>
            ) : (
              <div className="text-sm text-muted">
                <p>Nenhuma nota fiscal emitida para este pedido.</p>
                <p className="mt-1 text-xs">A nota pode ser emitida assim que o pedido for finalizado ou marcado como pago.</p>
              </div>
            )}
          </Card>

          <Card title="Situação do pedido">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">Status atual:</span>
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>

              {canWrite && (o.status === "DRAFT" || o.status === "PENDING_PAYMENT") && (
                <div className="rounded-lg border border-success/20 bg-success/5 p-2.5">
                  <p className="text-xs text-success mb-2">Pagamento já foi recebido ou confirmado fora do sistema?</p>
                  <form action={setOrderStatusAction}>
                    <input type="hidden" name="order_id" value={o.id} />
                    <input type="hidden" name="status" value="PAID" />
                    <input type="hidden" name="notes" value="Confirmado como pago manualmente" />
                    <Button variant="primary" className="bg-success text-white hover:bg-success/90 text-xs px-3 py-1.5">
                      ✓ Marcar pedido como Pago
                    </Button>
                  </form>
                </div>
              )}

              {canWrite && (
                <form action={setOrderStatusAction} className="space-y-2 border-t border-border pt-3">
                  <input type="hidden" name="order_id" value={o.id} />
                  <Field label="Alterar situação para">
                    <select name="status" defaultValue={o.status} className={inputClass}>
                      <option value="DRAFT">Rascunho (Em andamento)</option>
                      <option value="PENDING_PAYMENT">Aguardando pagamento</option>
                      <option value="PAID">Pago</option>
                      <option value="FULFILLING">Em separação</option>
                      <option value="READY_FOR_PICKUP">Pronto para retirar</option>
                      <option value="SHIPPED">Enviado (a caminho)</option>
                      <option value="COMPLETED">Concluído (finalizado)</option>
                      <option value="CANCELLED">Cancelado</option>
                    </select>
                  </Field>
                  <Field label="Observação da alteração (opcional)">
                    <input name="notes" placeholder="Motivo ou detalhe da mudança de status" className={inputClass} />
                  </Field>
                  <Button variant="secondary" className="text-xs">
                    Salvar nova situação
                  </Button>
                </form>
              )}
            </div>
          </Card>

          {(pending || (links ?? []).length > 0) && (
            <Card title="Link de pagamento">
              {(links ?? []).map((l) => (
                <p key={l.id} className="mb-1 flex flex-wrap items-center gap-2 text-sm"><Badge tone={l.status === "PAID" ? "success" : l.status === "CREATED" || l.status === "SENT" ? "warning" : "neutral"}>{l.status.toLowerCase()}</Badge>
                  {l.url ? <a className="break-all text-brand underline" href={l.url} target="_blank" rel="noreferrer">{l.url}</a> : <span className="text-muted">aguardando o provedor gerar o link</span>}
                  <span className="text-xs text-muted">{formatBRL(l.amount)} · até {l.max_installments}x</span></p>
              ))}
              {pending && canWrite && (
                <form action={createLinkAction} className="mt-2 flex flex-wrap items-end gap-2"><input type="hidden" name="order_id" value={o.id} />
                  <Field label="Parcelas até"><input name="max_installments" type="number" min={1} max={12} defaultValue={3} className={`${inputClass} w-24`} /></Field>
                  <Field label="Provedor"><select name="provider" className={inputClass}><option value="MERCADOPAGO">Mercado Pago</option><option value="PAGARME">Pagar.me (Stone)</option></select></Field>
                  <Button variant="secondary">Gerar link</Button></form>
              )}
            </Card>
          )}
          {pending && canWrite && (
            <Card title="Cancelar pedido">
              <form action={cancelOrderAction} className="flex items-end gap-2"><input type="hidden" name="order_id" value={o.id} />
                <Field label="Motivo"><input name="reason" className={`${inputClass} w-56`} placeholder="Ex.: cliente desistiu" /></Field><Button variant="danger">Cancelar</Button></form>
              <p className="mt-2 text-xs text-muted">Libera as peças reservadas. Pedido já pago se resolve por devolução.</p>
            </Card>
          )}
          {(returns ?? []).length > 0 && (
            <Card title="Trocas e devoluções">
              <ul className="divide-y divide-border text-sm">{(returns ?? []).map((r) => <li key={r.id} className="flex justify-between py-1.5"><Link className="text-brand" href="/vender/trocas">{r.number}</Link><span>{formatBRL(r.amount)} · {r.refund_method === "STORE_CREDIT" ? "vale-troca" : r.refund_method?.toLowerCase()}</span></li>)}</ul>
            </Card>
          )}
        </div>
      </div>

      {(delivery || (ships ?? []).length > 0) && (
        <Card className="mt-4" title="Entrega e retirada">
          {(ships ?? []).map((s) => (
            <ul key={s.id} className="mb-3 divide-y divide-border text-sm">
              <li className="flex flex-wrap justify-between gap-2 py-1.5"><span>{CARRIER[s.carrier] ?? s.carrier}{s.tracking ? ` · ${s.tracking}` : ""}</span>
                <span><Badge tone={s.status === "DELIVERED" ? "success" : s.status === "FAILED" ? "danger" : "info"}>{SHIP[s.status]}</Badge> <span className="text-xs text-muted">custo {formatBRL(s.cost)} · cobrado {formatBRL(s.charged)}</span></span></li>
            </ul>
          ))}
          {canWrite && delivery && (
            <div className="flex flex-wrap items-end gap-4">
              <form action={saveShipmentAction} className="flex flex-wrap items-end gap-2"><input type="hidden" name="order_id" value={o.id} />
                <Field label="Transporte"><select name="carrier" className={inputClass}>{Object.entries(CARRIER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="Rastreio"><input name="tracking" className={`${inputClass} w-36`} /></Field>
                <Field label="Custo (R$)"><input name="cost" inputMode="decimal" className={`${inputClass} w-24`} /></Field>
                <Field label="Cobrado (R$)"><input name="charged" inputMode="decimal" className={`${inputClass} w-24`} defaultValue={String(o.shipping_total).replace(".", ",")} /></Field>
                <Field label="Situação"><select name="status" className={inputClass}><option value="PENDING">Pendente</option><option value="IN_TRANSIT">A caminho</option><option value="DELIVERED">Entregue</option></select></Field>
                <Button variant="secondary">Registrar entrega</Button></form>
            </div>
          )}
        </Card>
      )}
      {o.notes && <p className="mt-4 text-sm text-muted">Observações: {o.notes}</p>}
      <p className="mt-2 text-xs text-muted">Criado em {fmtDate(o.created_at.slice(0, 10))}.</p>
    </>
  );
}
