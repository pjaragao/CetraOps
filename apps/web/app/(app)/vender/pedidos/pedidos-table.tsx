"use client";

import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { Badge } from "@/components/ui";
import { emitOrderInvoiceAction } from "../actions";

export interface FiscalDocInfo {
  id: string;
  number: number;
  series: number;
  model: string;
  status: string;
  access_key?: string | null;
  danfe_path?: string | null;
  rejection_reason?: string | null;
}

export interface OrderRow {
  id: string;
  number: string;
  channel: string;
  status: string;
  fulfillment_type: string;
  total: number;
  paid_total: number;
  created_at: string;
  party_id: string | null;
  party_name?: string | null;
  items_count: number;
  fiscal_doc?: FiscalDocInfo | null;
}

const STATUS_CONFIG: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" }> = {
  DRAFT: { label: "Rascunho", tone: "neutral" },
  PENDING_PAYMENT: { label: "Aguardando pagamento", tone: "warning" },
  PAID: { label: "Pago", tone: "success" },
  FULFILLING: { label: "Em separação", tone: "info" },
  READY_FOR_PICKUP: { label: "Pronto para retirar", tone: "info" },
  SHIPPED: { label: "Enviado", tone: "info" },
  COMPLETED: { label: "Concluído", tone: "success" },
  CANCELLED: { label: "Cancelado", tone: "danger" },
  PARTIALLY_RETURNED: { label: "Devolvido parcial", tone: "warning" },
  RETURNED: { label: "Devolvido", tone: "danger" },
};

const CHANNEL_LABELS: Record<string, string> = {
  POS: "Balcão",
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  TELEGRAM: "Telegram",
  PAYMENT_LINK: "Link de pagamento",
  B2B: "B2B",
  EVENT: "Evento",
};

interface PedidosTableProps {
  orders: OrderRow[];
  canWrite: boolean;
  base: string;
  params: Record<string, string | undefined>;
  sort: string;
  dir: "asc" | "desc";
}

export function PedidosTable({ orders, canWrite, base, params, sort, dir }: PedidosTableProps) {
  function sortLink(col: string) {
    const nextDir = sort === col && dir === "desc" ? "asc" : "desc";
    const nextParams = new URLSearchParams(
      Object.entries({ ...params, sort: col, dir: nextDir, p: undefined }).filter(
        (e): e is [string, string] => Boolean(e[1]),
      ),
    );
    return `${base}?${nextParams.toString()}`;
  }

  function sortIndicator(col: string) {
    if (sort !== col) return null;
    return <span className="ml-1 text-xs text-brand font-bold">{dir === "asc" ? "▲" : "▼"}</span>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2.5 font-medium whitespace-nowrap">
              <Link href={sortLink("number")} className="inline-flex items-center hover:text-foreground">
                Número {sortIndicator("number")}
              </Link>
            </th>
            <th className="px-3 py-2.5 font-medium whitespace-nowrap">
              <Link href={sortLink("created_at")} className="inline-flex items-center hover:text-foreground">
                Data {sortIndicator("created_at")}
              </Link>
            </th>
            <th className="px-3 py-2.5 font-medium whitespace-nowrap">Cliente</th>
            <th className="px-3 py-2.5 font-medium whitespace-nowrap">Canal</th>
            <th className="px-3 py-2.5 font-medium whitespace-nowrap text-center">Itens</th>
            <th className="px-3 py-2.5 font-medium whitespace-nowrap">
              <Link href={sortLink("total")} className="inline-flex items-center hover:text-foreground">
                Total {sortIndicator("total")}
              </Link>
            </th>
            <th className="px-3 py-2.5 font-medium whitespace-nowrap">
              <Link href={sortLink("status")} className="inline-flex items-center hover:text-foreground">
                Situação {sortIndicator("status")}
              </Link>
            </th>
            <th className="px-3 py-2.5 font-medium whitespace-nowrap">Nota Fiscal</th>
            <th className="px-3 py-2.5 font-medium whitespace-nowrap text-right">Ações</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {orders.map((o) => {
            const st = STATUS_CONFIG[o.status] ?? { label: o.status, tone: "info" as const };
            const doc = o.fiscal_doc;
            const isPaid = ["PAID", "COMPLETED", "FULFILLING", "READY_FOR_PICKUP", "SHIPPED"].includes(o.status);

            return (
              <tr key={o.id} className="hover:bg-surface-2/60 transition-colors">
                <td className="px-3 py-2.5 font-medium whitespace-nowrap">
                  <Link className="text-brand hover:underline font-mono text-sm" href={`/vender/pedidos/${o.id}`}>
                    {o.number}
                  </Link>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-xs text-muted">
                  {new Date(o.created_at).toLocaleString("pt-BR", {
                    timeZone: "America/Sao_Paulo",
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </td>
                <td className="px-3 py-2.5">
                  {o.party_id ? (
                    <Link className="text-brand hover:underline line-clamp-1 max-w-[200px]" href={`/clientes/${o.party_id}`}>
                      {o.party_name || "Cliente"}
                    </Link>
                  ) : (
                    <span className="text-muted text-xs">Balcão / Consumidor</span>
                  )}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <span className="text-xs text-muted">{CHANNEL_LABELS[o.channel] ?? o.channel}</span>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-center text-xs">
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">{o.items_count}</span>
                </td>
                <td className="px-3 py-2.5 font-medium whitespace-nowrap">
                  {formatBRL(o.total)}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <Badge tone={st.tone}>{st.label}</Badge>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {doc ? (
                    doc.status === "AUTHORIZED" ? (
                      <div className="flex items-center gap-1.5">
                        <Badge tone="success">
                          {doc.model === "65" ? "NFC-e" : "NF-e"} {doc.number}
                        </Badge>
                        {doc.danfe_path && (
                          <a
                            href={doc.danfe_path}
                            target="_blank"
                            rel="noreferrer"
                            title="Abrir DANFE (PDF)"
                            className="text-xs text-brand hover:underline font-medium"
                          >
                            PDF
                          </a>
                        )}
                      </div>
                    ) : doc.status === "PROCESSING" ? (
                      <Badge tone="warning">Processando NF</Badge>
                    ) : doc.status === "REJECTED" ? (
                      <span title={doc.rejection_reason ?? "Rejeição SEFAZ"}>
                        <Badge tone="danger">NF Rejeitada</Badge>
                      </span>
                    ) : (
                      <Badge tone="neutral">{doc.status}</Badge>
                    )
                  ) : isPaid ? (
                    <div className="flex items-center gap-2">
                      <Badge tone="warning">Sem NF</Badge>
                      {canWrite && (
                        <form action={emitOrderInvoiceAction}>
                          <input type="hidden" name="order_id" value={o.id} />
                          <input
                            type="hidden"
                            name="return_to"
                            value={`${base}?${new URLSearchParams(
                              Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])),
                            ).toString()}`}
                          />
                          <button
                            type="submit"
                            title="Emitir NF agora para este pedido"
                            className="rounded border border-brand/30 bg-brand/10 px-1.5 py-0.5 text-[11px] font-medium text-brand hover:bg-brand/20 transition-colors"
                          >
                            Emitir NF
                          </button>
                        </form>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted text-xs">—</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right whitespace-nowrap">
                  <div className="flex items-center justify-end gap-1.5">
                    {o.status === "DRAFT" && (
                      <Link
                        href={`/vender/pdv?resume=${o.id}`}
                        className="inline-flex items-center rounded-lg bg-brand px-2.5 py-1 text-xs font-semibold text-brand-contrast hover:opacity-90 transition-opacity"
                        title="Retomar e finalizar este pedido no PDV"
                      >
                        Retomar no PDV
                      </Link>
                    )}
                    <Link
                      href={`/vender/pedidos/${o.id}`}
                      className="inline-flex items-center rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium hover:bg-surface-2 transition-colors"
                    >
                      Ver detalhe
                    </Link>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
