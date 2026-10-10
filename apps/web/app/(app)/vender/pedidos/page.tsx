import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Card, Empty, inputClass, LinkButton, PageHeader, Pager } from "@/components/ui";
import { Flash } from "@/components/form";
import { PedidosTable, type FiscalDocInfo, type OrderRow } from "./pedidos-table";

export const metadata = { title: "Pedidos" };

const PAGE = 25;

const SITUACOES = [
  ["", "Todos"],
  ["rascunho", "Em andamento (Rascunho)"],
  ["aguardando", "Aguardando pagamento"],
  ["pagos", "Pagos"],
  ["entrega", "Em entrega / retirada"],
  ["concluidos", "Concluídos"],
  ["sem_nf", "Pagos sem NF"],
  ["cancelados", "Cancelados"],
  ["devolvidos", "Devolvidos"],
] as const;

const CANAIS = [
  ["", "Todos os canais"],
  ["POS", "Balcão (PDV)"],
  ["WHATSAPP", "WhatsApp"],
  ["INSTAGRAM", "Instagram"],
  ["TELEGRAM", "Telegram"],
  ["PAYMENT_LINK", "Link de pagamento"],
  ["B2B", "B2B"],
  ["EVENT", "Evento"],
] as const;

export default async function PedidosPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = await requirePerm("sales.read");
  const supabase = await createClient();
  const canWrite = can(session, "sales.write");
  const base = "/vender/pedidos";

  // Filtros
  const situacao = SITUACOES.some(([k]) => k === str(sp.situacao)) ? str(sp.situacao)! : "";
  const canal = str(sp.canal) ?? "";
  const statusNf = str(sp.nf) ?? "";
  const q = (str(sp.q) ?? "").replace(/[%,()]/g, " ").trim();
  const de = /^\d{4}-\d{2}-\d{2}$/.test(str(sp.de) ?? "") ? str(sp.de)! : "";
  const ate = /^\d{4}-\d{2}-\d{2}$/.test(str(sp.ate) ?? "") ? str(sp.ate)! : "";
  const sort = ["number", "created_at", "total", "status"].includes(str(sp.sort) ?? "") ? str(sp.sort)! : "created_at";
  const dir = str(sp.dir) === "asc" ? ("asc" as const) : ("desc" as const);
  const page = Math.max(1, Number(str(sp.p)) || 1);

  // Parâmetros para manter links e paginação
  const params: Record<string, string | undefined> = {
    situacao: situacao || undefined,
    canal: canal || undefined,
    nf: statusNf || undefined,
    q: q || undefined,
    de: de || undefined,
    ate: ate || undefined,
    sort: sort !== "created_at" ? sort : undefined,
    dir: dir !== "desc" ? dir : undefined,
  };

  const link = (extra: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = { ...params, ...extra, p: undefined };
    const u = new URLSearchParams(
      Object.entries(merged).filter((e): e is [string, string] => Boolean(e[1])),
    );
    const s = u.toString();
    return s ? `${base}?${s}` : base;
  };

  // Montagem da query de pedidos
  let query = supabase
    .schema("sales")
    .from("orders")
    .select(
      "id, number, channel, status, fulfillment_type, total, paid_total, created_at, party_id, order_items(count)",
      { count: "exact" },
    );

  if (session.storeId) {
    query = query.eq("store_id", session.storeId);
  }

  // Filtro por situação
  if (situacao === "rascunho") {
    query = query.eq("status", "DRAFT");
  } else if (situacao === "aguardando") {
    query = query.eq("status", "PENDING_PAYMENT");
  } else if (situacao === "pagos") {
    query = query.eq("status", "PAID");
  } else if (situacao === "entrega") {
    query = query.in("status", ["FULFILLING", "READY_FOR_PICKUP", "SHIPPED"]);
  } else if (situacao === "concluidos") {
    query = query.eq("status", "COMPLETED");
  } else if (situacao === "sem_nf") {
    query = query.in("status", ["PAID", "COMPLETED", "FULFILLING", "READY_FOR_PICKUP", "SHIPPED"]);
  } else if (situacao === "cancelados") {
    query = query.eq("status", "CANCELLED");
  } else if (situacao === "devolvidos") {
    query = query.in("status", ["PARTIALLY_RETURNED", "RETURNED"]);
  }

  // Filtro por canal
  const VALID_CHANNELS = ["POS", "WHATSAPP", "INSTAGRAM", "TELEGRAM", "PAYMENT_LINK", "B2B", "EVENT"] as const;
  type ChannelType = typeof VALID_CHANNELS[number];
  if (canal && VALID_CHANNELS.includes(canal as ChannelType)) {
    query = query.eq("channel", canal as ChannelType);
  }

  // Filtro por período
  if (de) {
    query = query.gte("created_at", `${de}T00:00:00-03:00`);
  }
  if (ate) {
    query = query.lte("created_at", `${ate}T23:59:59-03:00`);
  }

  // Busca por texto
  if (q) {
    query = query.or(`number.ilike.%${q}%`);
  }

  // Ordenação e paginação
  query = query
    .order(sort, { ascending: dir === "asc" })
    .range((page - 1) * PAGE, page * PAGE - 1);

  // Executar query principal e estatísticas gerais
  let statQuery = supabase
    .schema("sales")
    .from("orders")
    .select("id, status, total, paid_total")
    .limit(1000);
  if (session.storeId) {
    statQuery = statQuery.eq("store_id", session.storeId);
  }
  if (de) statQuery = statQuery.gte("created_at", `${de}T00:00:00-03:00`);
  if (ate) statQuery = statQuery.lte("created_at", `${ate}T23:59:59-03:00`);

  const [{ data: orderRows, count, error }, { data: stats }] = await Promise.all([
    query,
    statQuery,
  ]);

  // Carregar nomes de clientes
  const partyIds = [...new Set((orderRows ?? []).map((o) => o.party_id).filter((p): p is string => Boolean(p)))];
  const { data: partyRows } = partyIds.length
    ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", partyIds)
    : { data: [] as { id: string; display_name: string }[] };
  const partyNameMap = new Map((partyRows ?? []).map((p) => [p.id, p.display_name]));

  // Carregar status fiscal via RPC
  const orderIds = (orderRows ?? []).map((o) => o.id);
  const { data: fiscalDocsRaw } = orderIds.length
    ? await (supabase as unknown as { schema: (s: string) => { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> } }).schema("sales").rpc("get_orders_fiscal_docs", { p_orders: orderIds })
    : { data: null };

  const fiscalDocMap = new Map<string, FiscalDocInfo>();
  if (fiscalDocsRaw && typeof fiscalDocsRaw === "object") {
    if (Array.isArray(fiscalDocsRaw)) {
      for (const doc of fiscalDocsRaw as (FiscalDocInfo & { order_id?: string })[]) {
        if (doc?.order_id) {
          fiscalDocMap.set(doc.order_id, doc);
        }
      }
    } else {
      for (const [orderId, doc] of Object.entries(fiscalDocsRaw as Record<string, FiscalDocInfo>)) {
        if (orderId && doc) {
          fiscalDocMap.set(orderId, doc);
        }
      }
    }
  }

  // Montar lista de linhas para a tabela
  let list: OrderRow[] = (orderRows ?? []).map((o) => ({
    id: o.id,
    number: o.number,
    channel: o.channel,
    status: o.status,
    fulfillment_type: o.fulfillment_type,
    total: Number(o.total),
    paid_total: Number(o.paid_total),
    created_at: o.created_at,
    party_id: o.party_id,
    party_name: o.party_id ? partyNameMap.get(o.party_id) : null,
    items_count: o.order_items?.[0]?.count ?? 0,
    fiscal_doc: fiscalDocMap.get(o.id) ?? null,
  }));

  // Se o filtro for especificamente por NF
  if (statusNf === "com_nf") {
    list = list.filter((o) => o.fiscal_doc?.status === "AUTHORIZED");
  } else if (statusNf === "sem_nf" || situacao === "sem_nf") {
    list = list.filter((o) => {
      const isPaid = ["PAID", "COMPLETED", "FULFILLING", "READY_FOR_PICKUP", "SHIPPED"].includes(o.status);
      return isPaid && (!o.fiscal_doc || o.fiscal_doc.status !== "AUTHORIZED");
    });
  }

  // Métricas para os Cards de Topo
  const totalGeral = (stats ?? []).reduce((acc, o) => acc + Number(o.total), 0);
  const emAndamentoCount = (stats ?? []).filter((o) => o.status === "DRAFT" || o.status === "PENDING_PAYMENT").length;
  const pagosOuConcluidos = (stats ?? []).filter((o) => ["PAID", "COMPLETED", "FULFILLING", "READY_FOR_PICKUP", "SHIPPED"].includes(o.status));
  const pagosTotalVal = pagosOuConcluidos.reduce((acc, o) => acc + Number(o.total), 0);

  return (
    <>
      <PageHeader
        title="Pedidos"
        description="Gestão de vendas em todos os canais: balcão, WhatsApp, Instagram, links e B2B."
        actions={
          <div className="flex gap-2">
            <LinkButton href="/vender/pdv" variant="primary">
              + Nova venda (PDV)
            </LinkButton>
          </div>
        }
      />

      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      {/* Cards de Métricas */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <p className="text-xs text-muted">Total em pedidos</p>
          <p className="text-xl font-semibold">{formatBRL(totalGeral)}</p>
          <p className="mt-0.5 text-xs text-muted">{(stats ?? []).length} pedidos no total</p>
        </Card>
        <Card>
          <p className="text-xs text-muted">Em andamento / Aguardando</p>
          <p className="text-xl font-semibold text-warning">{emAndamentoCount}</p>
          <p className="mt-0.5 text-xs text-muted">Rascunhos ou aguardando pagamento</p>
        </Card>
        <Card>
          <p className="text-xs text-muted">Pagos / Concluídos</p>
          <p className="text-xl font-semibold text-success">{formatBRL(pagosTotalVal)}</p>
          <p className="mt-0.5 text-xs text-muted">{pagosOuConcluidos.length} vendas confirmadas</p>
        </Card>
        <Card>
          <p className="text-xs text-muted">Atenção Fiscal</p>
          <Link
            href={link({ situacao: "sem_nf", nf: undefined })}
            className="text-xs font-semibold text-brand hover:underline block mt-2"
          >
            Ver pedidos pagos sem NF →
          </Link>
        </Card>
      </div>

      {/* Navegação por Pílulas de Situação */}
      <nav className="mb-3 flex flex-wrap gap-1.5 text-sm" aria-label="Situação do pedido">
        {SITUACOES.map(([v, l]) => (
          <Link
            key={v}
            href={link({ situacao: v || undefined })}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              situacao === v
                ? "bg-brand text-brand-contrast"
                : "border border-border bg-surface hover:bg-surface-2 text-muted hover:text-foreground"
            }`}
          >
            {l}
          </Link>
        ))}
      </nav>

      {/* Barra de Filtros e Pesquisa */}
      <form className="mb-4 flex flex-wrap items-end gap-2.5" action={base}>
        {situacao && <input type="hidden" name="situacao" value={situacao} />}
        {sort && <input type="hidden" name="sort" value={sort} />}
        {dir && <input type="hidden" name="dir" value={dir} />}

        <label className="text-xs text-muted">
          Buscar
          <input
            name="q"
            defaultValue={q}
            placeholder="Nº pedido (ex: PED-…)"
            className={`${inputClass} w-48`}
          />
        </label>

        <label className="text-xs text-muted">
          Canal
          <select name="canal" defaultValue={canal} className={`${inputClass} w-40`}>
            {CANAIS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs text-muted">
          Nota Fiscal
          <select name="nf" defaultValue={statusNf} className={`${inputClass} w-36`}>
            <option value="">Todas</option>
            <option value="com_nf">Com NF emitida</option>
            <option value="sem_nf">Sem NF emitida</option>
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

        {(q || canal || statusNf || de || ate) && (
          <Link
            href={link({ q: undefined, canal: undefined, nf: undefined, de: undefined, ate: undefined })}
            className="py-2 text-sm text-muted hover:text-foreground transition-colors"
          >
            Limpar filtros
          </Link>
        )}
      </form>

      {error && <p className="mb-3 text-sm text-danger">Erro ao carregar pedidos: {error.message}</p>}

      {/* Tabela de Pedidos */}
      {list.length === 0 ? (
        <Empty title="Nenhum pedido encontrado">
          {situacao || canal || statusNf || q || de || ate
            ? "Tente ajustar ou limpar os filtros para ver mais pedidos."
            : "Comece uma nova venda no PDV para criar o primeiro pedido."}
        </Empty>
      ) : (
        <PedidosTable
          orders={list}
          canWrite={canWrite}
          base={base}
          params={params}
          sort={sort}
          dir={dir}
        />
      )}

      {/* Paginação */}
      <Pager path={base} params={params} page={page} pageSize={PAGE} total={count ?? 0} />
    </>
  );
}
