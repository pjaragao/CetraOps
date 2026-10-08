import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, PageHeader, Table } from "@/components/ui";
import { Flash, fmtDate } from "@/components/form";
import { toggleCouponAction } from "../../vender/actions";
import { CouponForm } from "./coupon-form";

export const metadata = { title: "Cupons" };

export default async function CuponsPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("sales.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const tipo = str(sp.tipo) ?? "";
  const [{ data: allCoupons }, { data: uses }, { data: roles }, { data: camps }] = await Promise.all([
    supabase.schema("sales").from("coupons").select("*").order("created_at", { ascending: false }),
    supabase.schema("sales").from("coupon_redemptions").select("coupon_id, amount"),
    supabase.schema("crm").from("party_roles").select("party_id").eq("role", "AFFILIATE_TRAINER"),
    supabase.schema("mkt").from("campaigns").select("id, name"),
  ]);
  const camp = new Map((camps ?? []).map((x) => [x.id, x.name]));
  const kindOf = (c: { party_id: string | null; affiliate_party_id: string | null; campaign_id: string | null }) => (c.party_id ? "pessoal" : c.affiliate_party_id ? "afiliada" : c.campaign_id ? "campanha" : "avulso");
  // pessoais ficam recolhidos por padrão (um por cliente polui a lista): só aparecem em ?tipo=pessoal
  const coupons = (allCoupons ?? []).filter((c) => (tipo ? kindOf(c) === tipo : kindOf(c) !== "pessoal"));
  const hiddenPersonal = tipo ? 0 : (allCoupons ?? []).filter((c) => kindOf(c) === "pessoal").length;
  const ids = [...new Set([...(roles ?? []).map((r) => r.party_id), ...coupons.flatMap((c) => (c.party_id ? [c.party_id] : []))])];
  const { data: parties } = ids.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", ids) : { data: [] as { id: string; display_name: string }[] };
  const aff = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const ownerIds = [...new Set(coupons.map((c) => c.party_id).filter((x): x is string => !!x))];
  const { data: owners } = ownerIds.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", ownerIds) : { data: [] as { id: string; display_name: string }[] };
  const ownerName = new Map((owners ?? []).map((p) => [p.id, p.display_name]));
  const stat = new Map<string, { n: number; total: number }>();
  for (const u of uses ?? []) { const s = stat.get(u.coupon_id) ?? { n: 0, total: 0 }; s.n += 1; s.total += Number(u.amount); stat.set(u.coupon_id, s); }
  const canWrite = can(session, "sales.write");

  return (
    <>
      <PageHeader title="Cupons" description="Códigos de desconto para campanhas e para o cupom de cada trainer (o desconto entra no mesmo centro de resultado da venda)." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <nav aria-label="Tipo de cupom" className="mb-3 flex flex-wrap gap-2 text-sm">
        {[["", "Todos (sem pessoais)"], ["campanha", "Campanha"], ["afiliada", "Afiliada"], ["pessoal", "Pessoais"], ["avulso", "Avulsos"]].map(([k, l]) => <Link key={k} href={k ? `/marketing/cupons?tipo=${k}` : "/marketing/cupons"}><Badge tone={tipo === k ? "brand" : "neutral"}>{l}</Badge></Link>)}
      </nav>
      {hiddenPersonal > 0 && <p className="mb-2 text-xs text-muted">{hiddenPersonal} cupom(ns) pessoal(is) ocultos: <Link className="text-brand" href="/marketing/cupons?tipo=pessoal">ver</Link>.</p>}
      {coupons.length === 0 ? <Empty title="Nenhum cupom neste filtro" /> : (
        <Table head={["Código", "Desconto", "Regras", "Usos", "Desconto dado", "Validade", "Situação", ""]}>
          {coupons.map((c) => {
            const s = stat.get(c.id) ?? { n: 0, total: 0 };
            return (
              <tr key={c.id} className={c.active ? "" : "opacity-60"}>
                <td className="px-3 py-2 font-mono font-medium">{c.code}{c.affiliate_party_id && <span className="ml-2 font-sans text-xs text-muted">{aff.get(c.affiliate_party_id) ?? "afiliada"}</span>}{c.party_id && <span className="ml-2 font-sans text-xs text-muted">pessoal · {ownerName.get(c.party_id) ?? "cliente"}</span>}{c.campaign_id && <span className="ml-2 font-sans text-xs text-muted">campanha {camp.get(c.campaign_id) ?? ""}</span>}</td>
                <td className="px-3 py-2">{c.kind === "PERCENT" ? `${String(c.value).replace(".", ",")}%` : formatBRL(c.value)}</td>
                <td className="px-3 py-2 text-xs text-muted">{[c.min_order ? `mín. ${formatBRL(c.min_order)}` : "", c.per_customer_limit ? `${c.per_customer_limit}/cliente` : ""].filter(Boolean).join(" · ") || "—"}</td>
                <td className="px-3 py-2">{s.n}{c.max_uses ? ` / ${c.max_uses}` : ""}</td><td className="px-3 py-2">{formatBRL(s.total)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{c.valid_to ? fmtDate(c.valid_to.slice(0, 10)) : "sem fim"}</td>
                <td className="px-3 py-2"><Badge tone={c.active ? "success" : "neutral"}>{c.active ? "ativo" : "pausado"}</Badge></td>
                <td className="px-3 py-2">{canWrite && <form action={toggleCouponAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="active" value={c.active ? "0" : "1"} /><Button variant="ghost" className="px-2 py-1 text-xs">{c.active ? "Pausar" : "Ativar"}</Button></form>}</td>
              </tr>
            );
          })}
        </Table>
      )}
      {canWrite && <Card className="mt-4" title="Novo cupom"><CouponForm affiliates={(parties ?? []).map((p) => ({ id: p.id, label: p.display_name }))} /></Card>}
    </>
  );
}
