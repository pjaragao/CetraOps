import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { isoFromNow, str, type SP } from "@/lib/context";
import { Badge, Card, cn, Empty, PageHeader, Stat, Table } from "@/components/ui";
import { Flash } from "@/components/form";
import { LoanForm } from "./loan-form";

export const metadata = { title: "Malinhas e peças em campanha" };

const KIND = { TRY_ON: "Malinha", CAMPAIGN: "Campanha" } as const;

export default async function MalinhasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("sales.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const tipo = str(sp.tipo) === "CAMPAIGN" ? "CAMPAIGN" : "TRY_ON";
  const filtro = str(sp.ver) ?? "abertas";
  const now = new Date(isoFromNow(0)).getTime();
  const store = session.stores.find((s) => s.id === session.storeId) ?? session.stores[0];

  let q = supabase.schema("inv").from("loans").select("id, number, kind, party_id, campaign_id, purpose, due_at, status, created_at, closed_at, order_id").eq("kind", tipo)
    .order(filtro === "encerradas" ? "closed_at" : "due_at", { ascending: filtro !== "encerradas" }).limit(200);
  q = filtro === "encerradas" ? q.neq("status", "OPEN") : q.eq("status", "OPEN");
  if (filtro === "vencidas") q = q.lt("due_at", new Date(now).toISOString());
  if (session.storeId) q = q.eq("store_id", session.storeId);
  const [{ data: loans }, { data: openAll }, { data: campaigns }] = await Promise.all([
    q,
    supabase.schema("inv").from("loans").select("id, kind, due_at").eq("status", "OPEN"),
    supabase.schema("mkt").from("campaigns").select("id, name").in("status", ["DRAFT", "ACTIVE"]).order("created_at", { ascending: false }).limit(50),
  ]);
  const ids = (loans ?? []).map((l) => l.id);
  const [{ data: items }, { data: parties }] = await Promise.all([
    ids.length ? supabase.schema("inv").from("loan_items").select("loan_id, qty, unit_price, returned, sold, lost, damaged, gifted").in("loan_id", ids) : Promise.resolve({ data: [] as never[] }),
    supabase.schema("crm").from("parties").select("id, display_name").in("id", [...new Set((loans ?? []).map((l) => l.party_id).filter(Boolean) as string[])].concat(["00000000-0000-0000-0000-000000000000"])),
  ]);
  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const cname = new Map((campaigns ?? []).map((c) => [c.id, c.name]));
  const agg = new Map<string, { pieces: number; pending: number; value: number }>();
  for (const it of items ?? []) {
    const a = agg.get(it.loan_id) ?? { pieces: 0, pending: 0, value: 0 };
    const pend = Number(it.qty) - Number(it.returned) - Number(it.sold) - Number(it.lost) - Number(it.damaged) - Number(it.gifted);
    agg.set(it.loan_id, { pieces: a.pieces + Number(it.qty), pending: a.pending + pend, value: a.value + pend * Number(it.unit_price ?? 0) });
  }
  const open = (openAll ?? []).filter((l) => l.kind === tipo);
  const overdue = open.filter((l) => new Date(l.due_at).getTime() < now).length;
  const today = open.filter((l) => { const t = new Date(l.due_at).getTime(); return t >= now && t < now + 86_400_000; }).length;
  const qs = (k: Record<string, string>) => `/vender/malinhas?${new URLSearchParams({ tipo, ver: filtro, ...k }).toString()}`;

  return (
    <>
      <PageHeader title="Malinhas e peças em campanha"
        description="Peças que saem da loja e voltam: malinha para a cliente provar em casa, ou empréstimo para fotos, influenciadoras e eventos. Enquanto estão fora, não aparecem como disponíveis." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 flex flex-wrap gap-2">
        {(["TRY_ON", "CAMPAIGN"] as const).map((k) => (
          <Link key={k} href={`/vender/malinhas?tipo=${k}`} className={cn("rounded-lg border px-3 py-1.5 text-sm", tipo === k ? "border-brand bg-brand/10 text-brand" : "border-border")}>
            {k === "TRY_ON" ? "Malinhas de clientes" : "Peças em campanha"}
          </Link>
        ))}
      </div>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label={tipo === "TRY_ON" ? "Malinhas abertas" : "Saídas abertas"} value={open.length} />
        <Stat label="Voltam nas próximas 24 h" value={today} />
        <Stat label="Vencidas" value={overdue} tone={overdue > 0 ? "danger" : undefined} />
      </div>
      {can(session, "sales.write") && store && (
        <Card className="mb-4" title={tipo === "TRY_ON" ? "Nova malinha" : "Nova saída para campanha"}>
          <LoanForm storeId={store.id} kind={tipo} campaigns={campaigns ?? []} />
        </Card>
      )}
      <div className="mb-2 flex flex-wrap gap-3 text-sm">
        {[["abertas", "Abertas"], ["vencidas", "Vencidas"], ["encerradas", "Encerradas"]].map(([k, l]) => (
          <Link key={k} href={qs({ ver: k })} className={filtro === k ? "font-semibold text-brand" : "text-muted"}>{l}</Link>
        ))}
      </div>
      {(loans ?? []).length === 0 ? <Empty title="Nada por aqui" /> : (
        <Table head={["Nº", tipo === "TRY_ON" ? "Cliente" : "Para", "Peças", "Pendentes", "Valor fora", "Devolver até", ""]}>
          {(loans ?? []).map((l) => {
            const a = agg.get(l.id) ?? { pieces: 0, pending: 0, value: 0 };
            const late = l.status === "OPEN" && new Date(l.due_at).getTime() < now;
            return (
              <tr key={l.id}>
                <td className="px-3 py-2 font-mono text-xs">{l.number}</td>
                <td className="px-3 py-2">{l.party_id ? pname.get(l.party_id) ?? "—" : null}{l.campaign_id && <span className="block text-xs text-muted">{cname.get(l.campaign_id) ?? "campanha"}</span>}{l.purpose && <span className="block text-xs text-muted">{l.purpose}</span>}</td>
                <td className="px-3 py-2 tabular-nums">{a.pieces}</td>
                <td className="px-3 py-2 tabular-nums">{a.pending}</td>
                <td className="px-3 py-2 tabular-nums">{formatBRL(a.value)}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {l.status === "OPEN" ? <span className={late ? "font-medium text-danger" : ""}>{new Date(l.due_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}{late && " (vencida)"}</span>
                    : <Badge tone={l.status === "CLOSED" ? "success" : "neutral"}>{l.status === "CLOSED" ? "encerrada" : "cancelada"}</Badge>}
                </td>
                <td className="px-3 py-2"><Link className="text-brand" href={`/vender/malinhas/${l.id}`}>{l.status === "OPEN" ? "acertar" : "ver"}</Link></td>
              </tr>
            );
          })}
        </Table>
      )}
      <p className="mt-3 text-xs text-muted">{KIND[tipo]}: quando a pessoa devolve, registre o que voltou e o que ficou. Peças vendidas abrem uma venda no PDV já preenchida.</p>
    </>
  );
}
