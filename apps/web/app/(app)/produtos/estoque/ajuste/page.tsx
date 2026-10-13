import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Flash } from "@/components/form";
import { Card, LinkButton, Narrow, PageHeader } from "@/components/ui";
import { AdjustForm } from "./adjust-form";

export const metadata = { title: "Ajuste de estoque" };

export default async function AjustePage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = await requirePerm("inv.write");
  const supabase = await createClient();
  let q = supabase.schema("inv").from("locations").select("id, name").order("name");
  if (session.storeId) q = q.eq("store_id", session.storeId);
  const { data: locations } = await q;
  return (
    <Narrow>
      <PageHeader title="Ajuste de estoque" description="Peça perdida, avariada, dada como brinde ou correção pontual. Para conferir o estoque inteiro, use a contagem."
        actions={<LinkButton href="/produtos/estoque">Voltar ao estoque</LinkButton>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <Card><AdjustForm locations={locations ?? []} /></Card>
    </Narrow>
  );
}
