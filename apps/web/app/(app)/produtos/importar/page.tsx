import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { Card, PageHeader } from "@/components/ui";
import { CatalogImporter } from "./importer";

export const metadata = { title: "Importar catálogo" };

export default async function ImportarPage() {
  const session = await requirePerm("catalog.write");
  const supabase = await createClient();
  let q = supabase.schema("inv").from("locations").select("id, name").in("kind", ["SALES_FLOOR", "BACKROOM"]).order("name");
  if (session.storeId) q = q.eq("store_id", session.storeId);
  const { data: locations } = await q;
  return (
    <>
      <PageHeader title="Importar catálogo" description="Envie ou cole a planilha (CSV do Excel). Reimportar atualiza em vez de duplicar; a quantidade FIXA o saldo do local (não soma)." />
      <Card title="Formato (uma linha por variante: referência × cor × tamanho)" className="mb-4">
        <code className="block overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs whitespace-pre">
{`referencia;nome;genero;categoria;ncm;cor;tamanho;ean;preco;quantidade;custo;marca;colecao
LEG-001;Legging Sculpt;FEM;Leggings;61046200;Preto;P;;429,00;4;178,75;SIÉ;Essenciais
LEG-001;Legging Sculpt;FEM;Leggings;61046200;Preto;M;;429,00;5;178,75;SIÉ;Essenciais`}
        </code>
        <p className="mt-2 text-xs text-muted">Separador <b>;</b> ou <b>,</b> (texto com separador vai entre aspas). Gênero: FEM, MASC ou UNISSEX. Valores em reais (1.234,56).
          EAN, preço, quantidade, custo, marca e coleção são opcionais; sem EAN, a etiqueta usa o SKU. Sem preço, o sistema sugere pelo markup.</p>
      </Card>
      <CatalogImporter locations={locations ?? []} canStock={can(session, "inv.write")} />
    </>
  );
}
