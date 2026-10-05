import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Card, Empty, LinkButton, PageHeader, Table } from "@/components/ui";
import { Flash } from "@/components/form";

export const metadata = { title: "Trocas e devoluções" };

const TYPE: Record<string, string> = { RETURN_REFUND: "Devolução", EXCHANGE: "Troca", STORE_CREDIT: "Vale-troca" };
const REASON: Record<string, string> = { SIZE: "Tamanho", DEFECT: "Defeito", REGRET_7D: "Arrependimento", OTHER: "Outro" };
const METHOD: Record<string, string> = { STORE_CREDIT: "vale-troca", CASH: "dinheiro", PIX: "Pix a pagar", CARD: "estorno no cartão" };

export default async function TrocasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("sales.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: list } = await supabase.schema("sales").from("returns").select("id, number, order_id, type, reason, amount, refund_method, party_id, created_at").order("created_at", { ascending: false }).limit(200);
  const orderIds = [...new Set((list ?? []).map((r) => r.order_id))], partyIds = [...new Set((list ?? []).map((r) => r.party_id).filter(Boolean) as string[])];
  const [{ data: orders }, { data: parties }, { data: credit }] = await Promise.all([
    orderIds.length ? supabase.schema("sales").from("orders").select("id, number").in("id", orderIds) : Promise.resolve({ data: [] as { id: string; number: string }[] }),
    partyIds.length ? supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds) : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
    supabase.schema("sales").from("store_credit_ledger").select("party_id, amount").limit(2000),
  ]);
  const onum = new Map((orders ?? []).map((o) => [o.id, o.number])), pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const bal = new Map<string, number>();
  for (const c of credit ?? []) bal.set(c.party_id, (bal.get(c.party_id) ?? 0) + Number(c.amount));
  const withBalance = [...bal.entries()].filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const { data: cpar } = withBalance.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", withBalance.map(([id]) => id)) : { data: [] as { id: string; display_name: string }[] };
  const cname = new Map((cpar ?? []).map((p) => [p.id, p.display_name]));
  const total = withBalance.reduce((s, [, v]) => s + v, 0);

  return (
    <>
      <PageHeader title="Trocas e devoluções" description="Troca vira vale-troca (passivo) para a cliente levar outra peça; devolução reembolsa por dinheiro, Pix ou estorno no cartão. Estoque, CMV, receita e comissão ajustam sozinhos."
        actions={can(session, "sales.write") ? <LinkButton href="/vender/trocas/nova" variant="primary">Nova troca / devolução</LinkButton> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {withBalance.length > 0 && (
        <Card className="mb-4" title={`Vales-troca em aberto · ${formatBRL(total)}`}>
          <ul className="flex flex-wrap gap-2 text-sm">{withBalance.map(([id, v]) => <li key={id}><Link className="rounded-full border border-border px-3 py-1 hover:bg-surface-2" href={`/clientes/${id}`}>{cname.get(id) ?? "cliente"} · {formatBRL(v)}</Link></li>)}</ul>
        </Card>
      )}
      {(list ?? []).length === 0 ? <Empty title="Nenhuma troca ou devolução ainda" /> : (
        <Table head={["Número", "Data", "Pedido", "Cliente", "Tipo", "Motivo", "Valor", "Devolvido por"]}>
          {(list ?? []).map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 font-medium">{r.number}</td>
              <td className="px-3 py-2 whitespace-nowrap">{new Date(r.created_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td>
              <td className="px-3 py-2"><Link className="text-brand" href={`/vender/pedidos/${r.order_id}`}>{onum.get(r.order_id)}</Link></td>
              <td className="px-3 py-2">{r.party_id ? pname.get(r.party_id) ?? "—" : "—"}</td>
              <td className="px-3 py-2"><Badge tone={r.type === "EXCHANGE" ? "info" : "warning"}>{TYPE[r.type]}</Badge></td>
              <td className="px-3 py-2">{REASON[r.reason]}</td><td className="px-3 py-2 font-medium">{formatBRL(r.amount)}</td>
              <td className="px-3 py-2">{r.refund_method ? METHOD[r.refund_method] : "—"}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
