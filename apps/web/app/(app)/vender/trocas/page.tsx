import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Card, Empty, inputClass, LinkButton, PageHeader, Pager } from "@/components/ui";
import { Flash } from "@/components/form";

export const metadata = { title: "Trocas e devoluções" };

const PAGE = 25;

const TYPE: Record<string, string> = {
  RETURN_REFUND: "Devolução",
  EXCHANGE: "Troca",
  STORE_CREDIT: "Vale-troca",
};

const REASON: Record<string, string> = {
  SIZE: "Tamanho",
  DEFECT: "Defeito",
  REGRET_7D: "Arrependimento",
  OTHER: "Outro",
};

const METHOD: Record<string, string> = {
  STORE_CREDIT: "vale-troca",
  CASH: "dinheiro",
  PIX: "Pix a pagar",
  CARD: "estorno no cartão",
};

export default async function TrocasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("sales.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const base = "/vender/trocas";

  const q = (str(sp.q) ?? "").replace(/[%,()]/g, " ").trim();
  const tipo = str(sp.tipo) ?? "";
  const de = /^\d{4}-\d{2}-\d{2}$/.test(str(sp.de) ?? "") ? str(sp.de)! : "";
  const ate = /^\d{4}-\d{2}-\d{2}$/.test(str(sp.ate) ?? "") ? str(sp.ate)! : "";
  const page = Math.max(1, Number(str(sp.p)) || 1);

  const params: Record<string, string | undefined> = {
    q: q || undefined,
    tipo: tipo || undefined,
    de: de || undefined,
    ate: ate || undefined,
  };

  const link = (extra: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = { ...params, ...extra, p: undefined };
    const u = new URLSearchParams(
      Object.entries(merged).filter((e): e is [string, string] => Boolean(e[1])),
    );
    const s = u.toString();
    return s ? `${base}?${s}` : base;
  };

  let query = supabase
    .schema("sales")
    .from("returns")
    .select("id, number, order_id, type, reason, amount, refund_method, party_id, created_at", { count: "exact" });

  if (tipo) query = query.eq("type", tipo);
  if (de) query = query.gte("created_at", `${de}T00:00:00-03:00`);
  if (ate) query = query.lte("created_at", `${ate}T23:59:59-03:00`);
  if (q) query = query.ilike("number", `%${q}%`);

  query = query.order("created_at", { ascending: false }).range((page - 1) * PAGE, page * PAGE - 1);

  const [{ data: list, count, error }, { data: credit }] = await Promise.all([
    query,
    supabase.schema("sales").from("store_credit_ledger").select("party_id, amount").limit(2000),
  ]);

  const orderIds = [...new Set((list ?? []).map((r) => r.order_id))];
  const partyIds = [...new Set((list ?? []).map((r) => r.party_id).filter((p): p is string => Boolean(p)))];

  const [{ data: orders }, { data: parties }] = await Promise.all([
    orderIds.length
      ? supabase.schema("sales").from("orders").select("id, number").in("id", orderIds)
      : Promise.resolve({ data: [] as { id: string; number: string }[] }),
    partyIds.length
      ? supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
  ]);

  const onum = new Map((orders ?? []).map((o) => [o.id, o.number]));
  const pname = new Map((parties ?? []).map((p) => [p.id, p.display_name]));

  // Vales-troca ativos
  const bal = new Map<string, number>();
  for (const c of credit ?? []) bal.set(c.party_id, (bal.get(c.party_id) ?? 0) + Number(c.amount));
  const withBalance = [...bal.entries()].filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const { data: cpar } = withBalance.length
    ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", withBalance.map(([id]) => id))
    : { data: [] as { id: string; display_name: string }[] };
  const cname = new Map((cpar ?? []).map((p) => [p.id, p.display_name]));
  const totalCreditos = withBalance.reduce((s, [, v]) => s + v, 0);

  return (
    <>
      <PageHeader
        title="Trocas e devoluções"
        description="Troca vira vale-troca (passivo) para a cliente levar outra peça no PDV; devolução reembolsa por dinheiro, Pix ou estorno no cartão. Estoque e financeiro são ajustados automaticamente."
        actions={
          can(session, "sales.write") ? (
            <LinkButton href="/vender/trocas/nova" variant="primary">
              + Nova troca / devolução
            </LinkButton>
          ) : undefined
        }
      />

      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      {withBalance.length > 0 && (
        <Card className="mb-4" title={`Vales-troca em aberto · ${formatBRL(totalCreditos)}`}>
          <p className="text-xs text-muted mb-2">Clientes com saldo disponível para abater em novas compras no PDV:</p>
          <ul className="flex flex-wrap gap-2 text-sm">
            {withBalance.map(([id, v]) => (
              <li key={id}>
                <Link className="rounded-full border border-border px-3 py-1 hover:bg-surface-2 transition-colors inline-block" href={`/clientes/${id}`}>
                  {cname.get(id) ?? "cliente"} · <b>{formatBRL(v)}</b>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Filtros */}
      <form className="mb-4 flex flex-wrap items-end gap-2.5" action={base}>
        <label className="text-xs text-muted">
          Buscar
          <input name="q" defaultValue={q} placeholder="Nº da troca (ex: DEV-…)" className={`${inputClass} w-48`} />
        </label>

        <label className="text-xs text-muted">
          Tipo
          <select name="tipo" defaultValue={tipo} className={`${inputClass} w-44`}>
            <option value="">Todos os tipos</option>
            <option value="EXCHANGE">Troca</option>
            <option value="STORE_CREDIT">Vale-troca</option>
            <option value="RETURN_REFUND">Devolução com reembolso</option>
          </select>
        </label>

        <label className="text-xs text-muted">
          De
          <input name="de" type="date" defaultValue={de} className={`${inputClass} w-36`} />
        </label>

        <label className="text-xs text-muted">
          Até
          <input name="ate" type="date" defaultValue={ate} className={`${inputClass} w-36`} />
        </label>

        <button type="submit" className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2 transition-colors">
          Filtrar
        </button>

        {(q || tipo || de || ate) && (
          <Link href={link({ q: undefined, tipo: undefined, de: undefined, ate: undefined })} className="py-2 text-sm text-muted hover:text-foreground">
            Limpar
          </Link>
        )}
      </form>

      {error && <p className="mb-3 text-sm text-danger">Erro ao carregar trocas: {error.message}</p>}

      {(list ?? []).length === 0 ? (
        <Empty title="Nenhuma troca ou devolução encontrada">
          {q || tipo || de || ate ? "Ajuste os filtros para ver outros registros." : "Use o botão acima para registrar a primeira troca de pedido."}
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Número</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Data</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Pedido</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Cliente</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Tipo</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Motivo</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Valor</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Devolvido por</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(list ?? []).map((r) => (
                <tr key={r.id} className="hover:bg-surface-2/60 transition-colors">
                  <td className="px-3 py-2.5 font-medium font-mono text-sm whitespace-nowrap">{r.number}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-xs text-muted">
                    {new Date(r.created_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <Link className="text-brand hover:underline font-medium" href={`/vender/pedidos/${r.order_id}`}>
                      {onum.get(r.order_id) ?? "Ver pedido"}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    {r.party_id ? (
                      <Link className="text-brand hover:underline" href={`/clientes/${r.party_id}`}>
                        {pname.get(r.party_id) ?? "Cliente"}
                      </Link>
                    ) : (
                      <span className="text-muted text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <Badge tone={r.type === "EXCHANGE" ? "info" : r.type === "STORE_CREDIT" ? "brand" : "warning"}>
                      {TYPE[r.type] ?? r.type}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-xs">{REASON[r.reason] ?? r.reason}</td>
                  <td className="px-3 py-2.5 font-semibold whitespace-nowrap">{formatBRL(r.amount)}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-xs text-muted">
                    {r.refund_method ? METHOD[r.refund_method] ?? r.refund_method : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager path={base} params={params} page={page} pageSize={PAGE} total={count ?? 0} />
    </>
  );
}
