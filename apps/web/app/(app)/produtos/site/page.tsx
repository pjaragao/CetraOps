import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge, Button, Card, Empty, PageHeader, Stat, Table } from "@/components/ui";
import { Flash } from "@/components/form";
import { requestSiteSyncAction, setSiteSyncAction } from "./actions";

export const metadata = { title: "Site da marca" };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "—");

/** Catálogo vindo do site oficial (siewear.com): rotinas, últimas rodadas, mudanças de preço e o que saiu do site. */
export default async function SitePage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("catalog.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const soEstoque = str(sp.estoque) !== "todos";
  let changesQ = supabase.schema("catalog").from("price_changes").select("product_id, variant_id, old_price, new_price, compare_at_price, in_stock, changed_at").order("changed_at", { ascending: false }).limit(300);
  if (soEstoque) changesQ = changesQ.gt("in_stock", 0);
  const [{ data: cfg }, { data: runs }, { data: changes }, { count: items }, { data: removed }] = await Promise.all([
    supabase.schema("core").from("settings").select("value").eq("key", "catalog_site").maybeSingle(),
    supabase.schema("catalog").from("site_sync_runs").select("id, kind, started_at, finished_at, status, stats, error").order("id", { ascending: false }).limit(30),
    changesQ,
    supabase.schema("catalog").from("site_items").select("id", { count: "exact", head: true }).is("removed_at", null),
    supabase.schema("catalog").from("site_items").select("title, url, removed_at, product_id").not("removed_at", "is", null).order("removed_at", { ascending: false }).limit(50),
  ]);
  const ids = [...new Set([...(changes ?? []).map((c) => c.product_id), ...(removed ?? []).map((r) => r.product_id).filter(Boolean) as string[]])];
  const vids = (changes ?? []).map((c) => c.variant_id).filter(Boolean) as string[];
  const [{ data: prods }, { data: vars }] = await Promise.all([
    ids.length ? supabase.schema("catalog").from("products").select("id, name, reference_code").in("id", ids) : Promise.resolve({ data: [] as { id: string; name: string; reference_code: string }[] }),
    vids.length ? supabase.schema("catalog").from("variants").select("id, sku").in("id", vids) : Promise.resolve({ data: [] as { id: string; sku: string }[] }),
  ]);
  const pname = new Map((prods ?? []).map((p) => [p.id, p.name])), vsku = new Map((vars ?? []).map((v) => [v.id, v.sku]));
  const conf = (cfg?.value ?? {}) as { enabled?: boolean; base_url?: string };
  const lastFull = (runs ?? []).find((r) => r.kind === "FULL" && r.status === "OK");
  const lastPrices = (runs ?? []).find((r) => r.kind === "PRICES" && r.status === "OK");
  const running = (runs ?? []).some((r) => r.status === "RUNNING");

  return (
    <>
      <PageHeader title="Site da marca"
        description={`Catálogo, fotos por cor, guia de tamanho e preços vêm do site oficial (${conf.base_url ?? "siewear.com"}). Completo todo dia às 05:20; preços a cada 6 horas. Se o preço de uma peça que está no seu estoque muda no site, chega um aviso.`}
        actions={<Link href="/produtos" className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-2">Catálogo</Link>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {running && <AutoRefresh every={15000} times={20} />}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Rotina" value={conf.enabled ? "ligada" : "desligada"} tone={conf.enabled ? "success" : "warning"} />
        <Stat label="Itens do site (modelo × cor)" value={items ?? 0} />
        <Stat label="Último catálogo completo" value={lastFull ? when(lastFull.finished_at) : "—"} />
        <Stat label="Última checagem de preço" value={lastPrices ? when(lastPrices.finished_at) : "—"} />
      </div>
      {can(session, "catalog.write") && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <form action={requestSiteSyncAction}><input type="hidden" name="kind" value="FULL" /><Button disabled={running}>Sincronizar catálogo agora</Button></form>
            <form action={requestSiteSyncAction}><input type="hidden" name="kind" value="PRICES" /><Button variant="secondary" disabled={running}>Só atualizar preços</Button></form>
            {running && <span className="text-sm text-warning">sincronização em andamento…</span>}
            {can(session, "core.admin") && (
              <form action={setSiteSyncAction} className="ml-auto"><input type="hidden" name="enabled" value={conf.enabled ? "0" : "1"} />
                <Button variant="ghost">{conf.enabled ? "Desligar rotinas" : "Ligar rotinas"}</Button></form>
            )}
          </div>
          <p className="mt-2 text-xs text-muted">O site é a fonte dos textos, fotos, guia de tamanho e preço de venda dos produtos da marca. O que a loja preencher e o site não tiver (NCM, EAN, cuidados) é mantido.</p>
        </Card>
      )}

      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted">Mudanças de preço no site</h2>
        <Link href={`/produtos/site?estoque=${soEstoque ? "todos" : "com"}`} className="text-xs text-brand">{soEstoque ? "ver todas (inclusive sem estoque)" : "só peças com estoque"}</Link>
      </div>
      {(changes ?? []).length === 0 ? <Empty title="Nenhuma mudança de preço registrada" /> : (
        <Table head={["Data", "Produto", "SKU", "Antes", "Agora", "Diferença", "Em estoque"]}>
          {(changes ?? []).map((c, i) => {
            const diff = c.old_price != null ? Number(c.new_price) - Number(c.old_price) : null;
            return (
              <tr key={i}>
                <td className="px-3 py-2 whitespace-nowrap">{when(c.changed_at)}</td>
                <td className="px-3 py-2"><Link className="hover:underline" href={`/produtos/${c.product_id}`}>{pname.get(c.product_id) ?? "—"}</Link></td>
                <td className="px-3 py-2 font-mono text-xs">{c.variant_id ? vsku.get(c.variant_id) : "—"}</td>
                <td className="px-3 py-2">{c.old_price != null ? formatBRL(c.old_price) : "—"}</td>
                <td className="px-3 py-2 font-medium">{formatBRL(c.new_price)}{c.compare_at_price ? <span className="block text-xs text-muted">de {formatBRL(c.compare_at_price)}</span> : null}</td>
                <td className="px-3 py-2">{diff == null ? "—" : <Badge tone={diff > 0 ? "warning" : "success"}>{diff > 0 ? "+" : ""}{formatBRL(diff)}</Badge>}</td>
                <td className="px-3 py-2 tabular-nums">{Number(c.in_stock)}</td>
              </tr>
            );
          })}
        </Table>
      )}

      <h2 className="mb-2 mt-6 text-sm font-semibold text-muted">Rodadas</h2>
      {(runs ?? []).length === 0 ? <Empty title="Ainda não rodou" /> : (
        <Table head={["Início", "Tipo", "Situação", "Itens", "Modelos novos", "Mudanças de preço", "Detalhe"]}>
          {(runs ?? []).map((r) => {
            const s = (r.stats ?? {}) as Record<string, number>;
            return (
              <tr key={r.id}>
                <td className="px-3 py-2 whitespace-nowrap">{when(r.started_at)}</td>
                <td className="px-3 py-2">{r.kind === "FULL" ? "Catálogo completo" : "Preços"}</td>
                <td className="px-3 py-2"><Badge tone={r.status === "OK" ? "success" : r.status === "ERROR" ? "danger" : "warning"}>{r.status === "OK" ? "ok" : r.status === "ERROR" ? "erro" : "rodando"}</Badge></td>
                <td className="px-3 py-2 tabular-nums">{s.items ?? s.products ?? s.site_products ?? "—"}</td>
                <td className="px-3 py-2 tabular-nums">{s.new_models ?? "—"}</td>
                <td className="px-3 py-2 tabular-nums">{s.price_changes ?? "—"}</td>
                <td className="px-3 py-2 text-xs text-muted">{r.error ?? (s.size_charts != null ? `${s.size_charts} guia(s) de tamanho` : "")}</td>
              </tr>
            );
          })}
        </Table>
      )}

      {(removed ?? []).length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-sm font-semibold text-muted">Saíram do site (continuam no catálogo da loja)</h2>
          <Table head={["Produto no site", "Desde"]}>
            {(removed ?? []).map((r) => (
              <tr key={r.url ?? r.title}><td className="px-3 py-2">{r.product_id ? <Link className="hover:underline" href={`/produtos/${r.product_id}`}>{r.title}</Link> : r.title}</td><td className="px-3 py-2">{when(r.removed_at)}</td></tr>
            ))}
          </Table>
        </>
      )}
    </>
  );
}
