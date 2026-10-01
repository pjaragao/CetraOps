import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { LinkButton, PageHeader } from "@/components/ui";
import { loadPurchaseOptions, resolveItems } from "../options";
import { PoEditor } from "../po-editor";

export const metadata = { title: "Novo pedido de compra" };

/** Aceita itens pré-preenchidos (vindos da sugestão de reposição): ?items=variantId:qtd:custo;variantId:qtd:custo */
export default async function NovoPedidoPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("purch.write");
  const sp = await searchParams;
  const opts = await loadPurchaseOptions();
  const rows = (str(sp.items) ?? "").split(";").filter(Boolean).flatMap((s) => {
    const [variant_id, qty, cost] = s.split(":");
    return /^[0-9a-f-]{36}$/.test(variant_id ?? "") && Number(qty) > 0 ? [{ variant_id, qty: Number(qty), unit_cost: Number(cost) || 0 }] : [];
  });
  const items = await resolveItems(rows);
  const location = str(sp.local);
  const entity = opts.locations.find((l) => l.id === location)?.legal_entity_id;
  return (
    <>
      <PageHeader title="Novo pedido de compra" description="O pedido vira rascunho; depois de aprovado, as NF-e do fornecedor são vinculadas a ele no recebimento." actions={<LinkButton href="/produtos/compras">Voltar</LinkButton>} />
      <PoEditor {...opts} initial={{ items, supplier_party_id: str(sp.fornecedor), location_id: location, legal_entity_id: entity }} />
    </>
  );
}
