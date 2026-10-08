import { redirect } from "next/navigation";

/** O pedido remoto agora é um modo da tela de venda (PDV): mantém o endereço antigo funcionando. */
export default function NovoPedidoRemotoPage() {
  redirect("/vender/pdv?modo=remoto");
}
