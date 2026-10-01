import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { Empty, LinkButton, PageHeader } from "@/components/ui";
import { RemoteOrderForm } from "./remote-order-form";

export const metadata = { title: "Novo pedido remoto" };

export default async function NovoPedidoRemotoPage() {
  const session = await requirePerm("sales.write");
  const store = session.stores.find((s) => s.id === session.storeId) ?? session.stores[0];
  if (!store) return (<><PageHeader title="Novo pedido remoto" /><Empty title="Nenhuma loja disponível para você" /></>);
  const supabase = await createClient();
  const { data: loc } = await supabase.schema("inv").from("locations").select("id").eq("store_id", store.id).eq("kind", "SALES_FLOOR").order("created_at").limit(1).maybeSingle();
  return (
    <>
      <PageHeader title="Novo pedido remoto" description="Venda por WhatsApp, Instagram ou link: o estoque fica reservado até o pagamento e a nota sai quando pago." actions={<LinkButton href="/vender/pedidos">Voltar</LinkButton>} />
      <RemoteOrderForm storeId={store.id} storeName={store.name} locationId={loc?.id} idempotencyKey={`web-${randomUUID()}`} />
    </>
  );
}
