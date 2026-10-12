import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { fetchAll } from "@/lib/fetch-all";
import { Badge, Button, Card, LinkButton, PageHeader, Table } from "@/components/ui";
import { Flash } from "@/components/form";
import { resolveItems } from "../../compras/options";
import { cancelCountAction, postCountAction } from "../actions";
import { CountScanner, type CountLine } from "./count-scanner";

export const metadata = { title: "Contagem" };

export default async function ContagemDetalhe({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("inv.read");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: count } = await supabase.schema("inv").from("counts").select("id, location_id, kind, status, notes, created_at, posted_at, adjusted").eq("id", id).maybeSingle();
  if (!count) notFound();
  const [{ data: loc }, items, stock] = await Promise.all([
    supabase.schema("inv").from("locations").select("name").eq("id", count.location_id).maybeSingle(),
    fetchAll((a, b) => supabase.schema("inv").from("count_items").select("variant_id, counted, expected").eq("count_id", id).order("variant_id").range(a, b)),
    fetchAll((a, b) => supabase.schema("inv").from("stock_levels").select("variant_id, on_hand").eq("location_id", count.location_id).neq("on_hand", 0).order("variant_id").range(a, b)),
  ]);
  const onHand = new Map(stock.map((s) => [s.variant_id, Number(s.on_hand)]));
  const open = count.status === "OPEN";
  const counted = new Set(items.map((i) => i.variant_id));
  const missing = open && count.kind === "FULL" ? stock.filter((s) => !counted.has(s.variant_id)) : [];
  const labels = await resolveItems([...items, ...missing].map((i) => ({ variant_id: i.variant_id, qty: 0, unit_cost: 0 })));
  const lmap = new Map(labels.map((l) => [l.variant_id, l]));
  const lines: CountLine[] = items.map((i) => ({ variant_id: i.variant_id, sku: lmap.get(i.variant_id)?.sku ?? "", label: lmap.get(i.variant_id)?.label ?? "",
    counted: Number(i.counted), expected: open ? onHand.get(i.variant_id) ?? 0 : Number(i.expected ?? 0) }));
  const canPost = can(session, "inv.write");
  const canCount = can(session, "inv.count") || canPost;

  return (
    <>
      <PageHeader title={`Contagem · ${loc?.name ?? ""}`}
        description={`${count.kind === "FULL" ? "Completa: o que não for bipado fica zerado ao lançar." : "Parcial: só as peças bipadas mudam."}${count.notes ? ` · ${count.notes}` : ""}`}
        actions={<LinkButton href="/produtos/contagem">Voltar</LinkButton>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {!open && <p className="mb-4"><Badge tone={count.status === "POSTED" ? "success" : "neutral"}>{count.status === "POSTED" ? `lançada · ${count.adjusted ?? 0} ajuste(s)` : "cancelada"}</Badge></p>}

      <CountScanner countId={count.id} initial={lines} editable={open && canCount} />

      {missing.length > 0 && (
        <Card className="mt-4" title={`Têm saldo e ainda não foram bipadas · ${missing.length} (vão zerar se lançar assim)`}>
          <Table head={["Peça", "No sistema"]}>
            {missing.slice(0, 300).map((m) => <tr key={m.variant_id}><td className="px-3 py-1.5"><span className="font-mono text-xs text-muted">{lmap.get(m.variant_id)?.sku}</span> {lmap.get(m.variant_id)?.label}</td><td className="px-3 py-1.5 tabular-nums">{Number(m.on_hand)}</td></tr>)}
          </Table>
        </Card>
      )}

      {open && (
        <div className="mt-4 flex flex-wrap gap-2">
          {canPost ? (
            <form action={postCountAction}><input type="hidden" name="count_id" value={count.id} /><Button>Lançar contagem e ajustar o estoque</Button></form>
          ) : <p className="text-sm text-muted">Quando terminar, peça para quem administra lançar a contagem.</p>}
          {canCount && <form action={cancelCountAction}><input type="hidden" name="count_id" value={count.id} /><Button variant="secondary">Cancelar contagem</Button></form>}
          <LinkButton href={`/produtos/etiquetas?contagem=${count.id}`}>Imprimir etiquetas destas peças</LinkButton>
        </div>
      )}
    </>
  );
}
