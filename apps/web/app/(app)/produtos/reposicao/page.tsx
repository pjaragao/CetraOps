import Link from "next/link";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Stat, Table } from "@/components/ui";
import { Field } from "@/components/form";

export const metadata = { title: "Reposição" };

const intParam = (v: string | undefined, d: number, min: number, max: number) => Math.min(Math.max(Math.round(Number(v ?? d)) || d, min), max);

/** Sugestão de reposição por tamanho: velocidade de venda × (prazo + cobertura + segurança) − (estoque disponível + a receber). */
export default async function ReposicaoPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("purch.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: locations } = await supabase.schema("inv").from("locations").select("id, name, store_id").in("kind", ["SALES_FLOOR", "BACKROOM"]).eq("is_sellable", true).order("name");
  const location = str(sp.local) ?? (locations ?? []).find((l) => l.store_id === session.storeId)?.id ?? locations?.[0]?.id;
  const lookback = intParam(str(sp.janela), 60, 7, 365), lead = intParam(str(sp.prazo), 14, 0, 120), cover = intParam(str(sp.cobertura), 30, 7, 180), safety = intParam(str(sp.seguranca), 7, 0, 60);
  if (!location) return (<><PageHeader title="Reposição" /><Empty title="Nenhum local de estoque cadastrado" /></>);

  const { data: rows } = await supabase.schema("purch").rpc("replenishment", { p_location: location, p_lookback: lookback, p_lead: lead, p_cover: cover, p_safety: safety });
  const list = rows ?? [];
  const need = list.filter((r) => Number(r.suggested) > 0);
  const supplierIds = [...new Set(need.map((r) => r.supplier_party_id).filter(Boolean))] as string[];
  const { data: suppliers } = supplierIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", supplierIds) : { data: [] as { id: string; display_name: string }[] };
  const sname = new Map((suppliers ?? []).map((s) => [s.id, s.display_name]));
  const groups = new Map<string, typeof need>();
  for (const r of need) { const k = r.supplier_party_id ?? ""; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const totalPieces = need.reduce((s, r) => s + Number(r.suggested), 0);
  const totalCost = need.reduce((s, r) => s + Number(r.suggested) * Number(r.last_cost ?? 0), 0);
  const canWrite = can(session, "purch.write");

  return (
    <>
      <PageHeader title="Sugestão de reposição" description="Calculada pela venda real de cada tamanho e cor. Os parâmetros são ajustáveis; a decisão de comprar é sua." />
      <form className="mb-4 grid gap-2 rounded-xl border border-border bg-surface p-3 sm:grid-cols-6">
        <Field label="Local" className="sm:col-span-2"><select name="local" defaultValue={location} className={inputClass}>{(locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label="Janela de vendas (dias)"><input name="janela" type="number" min={7} max={365} defaultValue={lookback} className={inputClass} /></Field>
        <Field label="Prazo do fornecedor (dias)"><input name="prazo" type="number" min={0} max={120} defaultValue={lead} className={inputClass} /></Field>
        <Field label="Cobertura desejada (dias)"><input name="cobertura" type="number" min={7} max={180} defaultValue={cover} className={inputClass} /></Field>
        <Field label="Segurança (dias)"><input name="seguranca" type="number" min={0} max={60} defaultValue={safety} className={inputClass} /></Field>
        <div className="flex items-end sm:col-span-6"><Button variant="secondary">Recalcular</Button></div>
      </form>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Itens com demanda" value={list.length} hint={`vendas dos últimos ${lookback} dias`} />
        <Stat label="Itens a repor" value={need.length} tone={need.length ? "warning" : "success"} />
        <Stat label="Peças sugeridas" value={totalPieces} />
        <Stat label="Investimento estimado" value={formatBRL(totalCost)} hint="pelo último custo de compra" />
      </div>

      {canWrite && groups.size > 0 && (
        <Card className="mb-4" title="Criar pedidos de compra">
          <div className="flex flex-wrap gap-2">
            {[...groups.entries()].map(([sid, rs]) => {
              const items = rs.map((r) => `${r.variant_id}:${r.suggested}:${r.last_cost ?? 0}`).join(";");
              return (
                <Link key={sid || "none"} href={`/produtos/compras/novo?local=${location}&items=${items}${sid ? `&fornecedor=${sid}` : ""}`}
                  className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-2">
                  {sid ? sname.get(sid) ?? "Fornecedor" : "Sem fornecedor definido"} · {rs.length} item(ns) · {rs.reduce((s, r) => s + Number(r.suggested), 0)} pç
                </Link>
              );
            })}
          </div>
        </Card>
      )}

      {list.length === 0 ? <Empty title="Sem histórico de vendas neste local e período">Assim que houver vendas, a sugestão aparece aqui.</Empty> : (
        <Table head={["Produto", "Tam.", "Estoque", "A receber", "Vendidas", "Vel./dia", "Cobertura", "Alvo", "Sugerido", "Último custo"]}>
          {list.map((r) => (
            <tr key={r.variant_id}>
              <td className="px-3 py-2"><span className="font-medium">{r.product_name}</span> <span className="text-xs text-muted">{r.color}</span><span className="block font-mono text-[11px] text-muted">{r.sku}</span></td>
              <td className="px-3 py-2">{r.size}</td>
              <td className="px-3 py-2">{Number(r.on_hand) - Number(r.reserved)}{Number(r.reserved) > 0 && <span className="text-xs text-muted"> (+{Number(r.reserved)} res.)</span>}</td>
              <td className="px-3 py-2">{Number(r.on_order) || "—"}</td><td className="px-3 py-2">{Number(r.sold)}</td><td className="px-3 py-2">{Number(r.velocity)}</td>
              <td className="px-3 py-2">{r.days_cover != null ? <Badge tone={Number(r.days_cover) < lead ? "danger" : Number(r.days_cover) < lead + cover ? "warning" : "success"}>{Number(r.days_cover)} d</Badge> : "—"}</td>
              <td className="px-3 py-2">{Number(r.target)}</td>
              <td className="px-3 py-2 font-semibold">{Number(r.suggested) > 0 ? Number(r.suggested) : "—"}</td>
              <td className="px-3 py-2">{r.last_cost != null ? formatBRL(r.last_cost) : "—"}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
