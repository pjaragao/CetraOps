import { createClient } from "@/lib/supabase/server";
import { loadPosCatalog } from "@/lib/pos-catalog";
import { can, requirePerm } from "@/lib/session";
import { Empty, PageHeader } from "@/components/ui";
import { PosTerminal } from "./pos-terminal";
import { getOrderDraft } from "./actions";

export const metadata = { title: "PDV" };

export default async function PdvPage({ searchParams }: { searchParams: Promise<{ modo?: string; resume?: string; order_id?: string }> }) {
  const { modo, resume, order_id } = await searchParams;
  const session = await requirePerm("sales.write");
  if (!session.storeId) {
    return (<><PageHeader title="PDV" /><Empty title="Escolha uma loja">O PDV vende numa loja específica. Selecione a loja no topo da tela.</Empty></>);
  }
  const resumeId = resume || order_id;
  const draftOrder = resumeId ? await getOrderDraft(resumeId) : null;
  const supabase = await createClient();

  const [products, { data: session_ }] = await Promise.all([
    loadPosCatalog(supabase, session.storeId),
    supabase.schema("sales").from("cash_sessions").select("id").eq("store_id", session.storeId).eq("status", "OPEN").maybeSingle(),
  ]);

  return (
    <>
      <PageHeader title="PDV" description="Nova venda: no balcão (recebe e emite a NFC-e) ou pedido remoto (reserva o estoque até o pagamento). Só aparece o que dá para vender: peça em estoque ou de produto liberado para encomenda." />
      <PosTerminal
        storeId={session.storeId}
        products={products}
        cashSessionId={session_?.id ?? null}
        initialMode={modo === "remoto" ? "remoto" : "balcao"}
        canDiscount={can(session, "sales.discount")}
        canCustomItem={can(session, "sales.custom_item")}
        initialDraft={draftOrder}
      />
    </>
  );
}
