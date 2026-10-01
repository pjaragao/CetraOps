import { requirePerm } from "@/lib/session";
import { Card, PageHeader } from "@/components/ui";
import { CatalogImporter } from "./importer";

export const metadata = { title: "Importar catálogo" };

export default async function ImportarPage() {
  await requirePerm("catalog.write");
  return (
    <>
      <PageHeader title="Importar catálogo" description="Cole ou envie a planilha (CSV) com o catálogo real. Linhas repetidas atualizam em vez de duplicar." />
      <Card title="Formato esperado (uma linha por variante: referência × cor × tamanho)" className="mb-4">
        <code className="block overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs whitespace-pre">
{`referencia;nome;genero;categoria;ncm;cor;tamanho;ean;preco
LEG-001;Legging Sculpt;FEM;Leggings;61046200;Preto;P;7890000000011;429,00
TEE-M01;Camiseta Dry;MASC;Camisetas;61091000;Off-white;G;;249,00`}
        </code>
        <p className="mt-2 text-xs text-muted">Separador <b>;</b> ou <b>,</b>. Gênero: FEM, MASC ou UNISSEX. Preço em reais. EAN opcional.</p>
      </Card>
      <CatalogImporter />
    </>
  );
}
