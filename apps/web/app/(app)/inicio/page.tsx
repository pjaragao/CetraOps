import Link from "next/link";
import { computeCommission, DEFAULT_COMMISSION_PLAN, formatBRL, type Channel } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";
import { periodBounds, str, type SP } from "@/lib/context";
import { Badge, Card, Empty, PageHeader, Stat } from "@/components/ui";
import { Flash } from "@/components/form";
import { DailyList, type DailyAction } from "./daily-list";

export const metadata = { title: "Início" };

const BREAKEVEN_MONTH = 27274.02; // ponto de equilíbrio com eventos (doc 02 do plano de negócios)

export default async function Inicio({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = await getSession();
  const period = periodBounds(str(sp.periodo));
  const supabase = await createClient();
  const erro = str(sp.erro);

  let ordersQ = supabase.schema("sales").from("orders")
    .select("total, channel, seller_member_id, created_at, assisted_by_ai")
    .in("status", ["PAID", "COMPLETED", "FULFILLING", "READY_FOR_PICKUP", "SHIPPED"])
    .gte("created_at", period.fromTs).lte("created_at", period.toTs);
  if (session.storeId) ordersQ = ordersQ.eq("store_id", session.storeId);

  const [orders, waiting, openConvs, critical, obligations, daily] = await Promise.all([
    can(session, "sales.read") ? ordersQ : Promise.resolve({ data: [] as never[] }),
    can(session, "omni.read")
      ? supabase.schema("omni").from("conversations").select("id", { count: "exact", head: true }).eq("mode", "WAITING_HUMAN").neq("status", "CLOSED")
      : Promise.resolve({ count: 0 }),
    can(session, "omni.read")
      ? supabase.schema("omni").from("conversations").select("id", { count: "exact", head: true }).neq("status", "CLOSED")
      : Promise.resolve({ count: 0 }),
    can(session, "inv.read")
      ? supabase.schema("inv").from("v_stock_matrix").select("sku, product_name, size, available").lte("available", 1).order("available").limit(8)
      : Promise.resolve({ data: [] as never[] }),
    can(session, "fin.read")
      ? supabase.schema("fin").from("contract_obligations").select("id, description, due_date").eq("status", "PENDING").order("due_date").limit(5)
      : Promise.resolve({ data: [] as never[] }),
    can(session, "crm.read") ? supabase.schema("crm").rpc("daily_actions", { p_limit: 10 }) : Promise.resolve({ data: [] as never[] }),
  ]);

  const list = orders.data ?? [];
  const revenue = list.reduce((a, o) => a + Number(o.total), 0);
  const ticket = list.length ? revenue / list.length : 0;
  const byChannel = list.reduce<Record<string, number>>((acc, o) => ({ ...acc, [o.channel]: (acc[o.channel] ?? 0) + Number(o.total) }), {});
  const aiAssisted = list.filter((o) => o.assisted_by_ai).reduce((a, o) => a + Number(o.total), 0);

  const mine = list.filter((o) => o.seller_member_id === session.memberId);
  const commission = computeCommission(DEFAULT_COMMISSION_PLAN, mine.map((o) => ({ channel: o.channel as Channel, amount: Number(o.total) })));
  const isSeller = !session.isSuperuser && session.roles.includes("seller");

  return (
    <>
      <PageHeader title={`Olá, ${session.name.split(" ")[0]}`} description={`${period.from.split("-").reverse().join("/")} a ${period.to.split("-").reverse().join("/")}`} />
      {erro === "sem-permissao" && <p className="mb-4 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">Você não tem permissão para aquela tela.</p>}
      <Flash ok={str(sp.ok)} erro={erro && erro !== "sem-permissao" ? erro : undefined} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Vendas no período" value={formatBRL(revenue)} hint={`${list.length} pedidos`} />
        <Stat label="Ticket médio" value={formatBRL(ticket)} />
        <Stat label="Aguardando humano" value={waiting.count ?? 0} tone={(waiting.count ?? 0) > 0 ? "warning" : undefined} hint={`${openConvs.count ?? 0} conversas abertas`} />
        {isSeller ? (
          <Stat label="Minha comissão estimada" value={formatBRL(commission.total)}
            hint={commission.nextTier ? `faltam ${formatBRL(commission.nextTier.missing)} para ${commission.nextTier.description}` : "faixa máxima atingida"} />
        ) : (
          <Stat label="Ponto de equilíbrio do mês" value={`${Math.round((revenue / BREAKEVEN_MONTH) * 100)}%`}
            hint={`meta ${formatBRL(BREAKEVEN_MONTH)} (vale para o período "Mês atual")`} tone={revenue >= BREAKEVEN_MONTH ? "success" : undefined} />
        )}
      </div>

      {can(session, "crm.read") && <div className="mt-4"><DailyList items={(daily.data ?? []) as unknown as DailyAction[]} canSend={can(session, "omni.write")} /></div>}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Vendas por canal">
          {Object.keys(byChannel).length === 0 ? <Empty title="Sem vendas no período" /> : (
            <ul className="space-y-2 text-sm">
              {Object.entries(byChannel).sort((a, b) => b[1] - a[1]).map(([ch, v]) => (
                <li key={ch} className="flex justify-between"><span>{ch}</span><span className="font-medium">{formatBRL(v)}</span></li>
              ))}
              <li className="flex justify-between border-t border-border pt-2 text-muted"><span>Assistidas pela IA</span><span>{formatBRL(aiAssisted)}</span></li>
            </ul>
          )}
        </Card>

        <Card title="Estoque crítico por tamanho" action={<Link href="/produtos/estoque" className="text-xs text-brand">ver estoque</Link>}>
          {(critical.data ?? []).length === 0 ? <Empty title="Nenhuma grade crítica" /> : (
            <ul className="space-y-1.5 text-sm">
              {(critical.data ?? []).map((c) => (
                <li key={c.sku} className="flex justify-between gap-2">
                  <span className="truncate">{c.product_name} · <b>{c.size}</b></span>
                  <Badge tone={Number(c.available) <= 0 ? "danger" : "warning"}>{Number(c.available)} disp.</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Próximas obrigações (contratos)">
          {!can(session, "fin.read") ? <p className="text-sm text-muted">Visível para sócios e financeiro.</p>
            : (obligations.data ?? []).length === 0 ? <Empty title="Nada pendente" /> : (
              <ul className="space-y-1.5 text-sm">
                {(obligations.data ?? []).map((o) => (
                  <li key={o.id} className="flex justify-between gap-2"><span className="truncate">{o.description}</span><span className="text-muted">{o.due_date.split("-").reverse().join("/")}</span></li>
                ))}
              </ul>
            )}
        </Card>
      </div>
    </>
  );
}
