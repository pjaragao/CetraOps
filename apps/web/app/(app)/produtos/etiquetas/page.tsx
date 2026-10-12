import { requirePerm } from "@/lib/session";
import { Card, LinkButton, PageHeader } from "@/components/ui";
import { LabelPicker } from "./label-picker";

export const metadata = { title: "Etiquetas" };

export default async function EtiquetasPage() {
  await requirePerm("catalog.read");
  return (
    <>
      <PageHeader title="Etiquetas" description="Etiqueta com nome, cor, tamanho, preço e código de barras (EAN ou, sem EAN, o SKU). O PDV e a contagem leem pelo leitor ou pela câmera."
        actions={<LinkButton href="/imprimir/etiquetas?estoque=1">Uma etiqueta por peça em estoque</LinkButton>} />
      <Card title="Escolher as peças"><LabelPicker /></Card>
      <p className="mt-3 text-xs text-muted">Também dá para imprimir a partir de uma contagem (botão na tela da contagem). Impressora térmica: use o tamanho da bobina e desligue as margens na janela de impressão.</p>
    </>
  );
}
