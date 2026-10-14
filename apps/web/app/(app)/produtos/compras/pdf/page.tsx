import { can, requirePerm } from "@/lib/session";
import { LinkButton, PageHeader } from "@/components/ui";
import { loadPurchaseOptions } from "../options";
import { OrderPdfImport } from "./order-pdf";

export const metadata = { title: "Pedido de compra pelo PDF" };

export default async function PedidoPdfPage() {
  const session = await requirePerm("purch.write");
  const opts = await loadPurchaseOptions();
  return (
    <>
      <PageHeader title="Pedido de compra pelo PDF" description="Envie o PDF do pedido feito com a marca (showroom/representante): as peças são conferidas com o catálogo, o que falta é cadastrado e o pedido de compra já vem preenchido com quantidades e custos."
        actions={<LinkButton href="/produtos/compras">Voltar</LinkButton>} />
      <OrderPdfImport opts={opts} canCatalog={can(session, "catalog.write")} />
    </>
  );
}
