import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Empty, inputClass, LinkButton, PageHeader, Table } from "@/components/ui";
import { resolveItems } from "../../../produtos/compras/options";
import { ReturnForm, type ReturnLine } from "./return-form";

export const metadata = { title: "Nova troca ou devolução" };

/** 1) achar o pedido pelo número; 2) escolher as peças e como resolver. */
export default async function NovaTrocaPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("sales.write");
  const sp = await searchParams;
  const supabase = await createClient();
  const n = (str(sp.n) ?? "").replace(/[%,()]/g, " ").trim();

  const { data: found } = n ? await supabase.schema("sales").from("orders").select("id, number, status, total, party_id, created_at, location_id, store_id, discount_total")
    .ilike("number", `%${n}%`).in("status", ["PAID", "COMPLETED", "FULFILLING", "READY_FOR_PICKUP", "SHIPPED", "PARTIALLY_RETURNED"]).order("created_at", { ascending: false }).limit(10) : { data: [] };
  const order = (found ?? []).length === 1 ? found![0] : (found ?? []).find((o) => o.number.toLowerCase() === n.toLowerCase());

  return (
    <>
      <PageHeader title="Nova troca ou devolução" description="Encontre a venda pelo número (ex.: VEN-2026-000123), escolha as peças e o que a cliente prefere." actions={<LinkButton href="/vender/trocas">Voltar</LinkButton>} />
      <form className="mb-4 flex gap-2"><input name="n" defaultValue={n} placeholder="Número do pedido" className={`${inputClass} max-w-xs`} aria-label="Número do pedido" autoFocus /><Button variant="secondary">Buscar</Button></form>
      {!n ? <Empty title="Digite o número do pedido">Também dá para chegar aqui pelo botão “Trocar / devolver” dentro do pedido.</Empty>
        : !order ? (
          (found ?? []).length === 0 ? <Empty title="Nenhum pedido pago com esse número" /> : (
            <Table head={["Pedido", "Data", "Total", "Situação"]}>
              {(found ?? []).map((o) => <tr key={o.id}><td className="px-3 py-2"><Link className="font-medium text-brand" href={`/vender/trocas/nova?n=${o.number}`}>{o.number}</Link></td>
                <td className="px-3 py-2">{new Date(o.created_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td><td className="px-3 py-2">{formatBRL(o.total)}</td><td className="px-3 py-2"><Badge>{o.status}</Badge></td></tr>)}
            </Table>
          )
        ) : await (async () => {
          const [{ data: items }, { data: locs }, { data: cash }, { data: party }] = await Promise.all([
            supabase.schema("sales").from("order_items").select("id, variant_id, description, qty, total, returned_qty").eq("order_id", order.id).order("line_no"),
            supabase.schema("inv").from("locations").select("id, name, kind").eq("store_id", order.store_id),
            supabase.schema("sales").from("cash_sessions").select("id").eq("status", "OPEN").limit(1).maybeSingle(),
            order.party_id ? supabase.schema("crm").from("parties").select("display_name").eq("id", order.party_id).maybeSingle() : Promise.resolve({ data: null }),
          ]);
          const labels = await resolveItems((items ?? []).flatMap((i) => i.variant_id ? [{ variant_id: i.variant_id, qty: 0, unit_cost: 0 }] : []));
          const lmap = new Map(labels.map((l) => [l.variant_id, l]));
          const lines: ReturnLine[] = (items ?? []).map((i) => ({
            id: i.id,
            sku: (i.variant_id && lmap.get(i.variant_id)?.sku) || "AVULSO",
            label: (i.variant_id && lmap.get(i.variant_id)?.label) || i.description || "Item avulso",
            qty: Number(i.qty),
            returned: Number(i.returned_qty),
            total: Number(i.total),
          }));
          const itemsSum = lines.reduce((s, l) => s + l.total, 0);
          const { data: cup } = await supabase.schema("sales").from("coupon_redemptions").select("amount").eq("order_id", order.id);
          const coupon = (cup ?? []).reduce((s, c) => s + Number(c.amount), 0);
          const ratio = itemsSum > 0 ? Math.max(1 - coupon / itemsSum, 0) : 1;
          return (
            <>
              <p className="mb-3 text-sm">Pedido <b>{order.number}</b> · {party?.display_name ?? "cliente não identificado"} · total {formatBRL(order.total)}{coupon > 0 && <span className="text-muted"> · cupom de {formatBRL(coupon)} (a devolução considera o valor efetivamente pago)</span>}</p>
              <ReturnForm orderId={order.id} hasParty={!!order.party_id} lines={lines} locations={locs ?? []} cashSessionId={cash?.id} ratio={ratio} />
            </>
          );
        })()}
    </>
  );
}
