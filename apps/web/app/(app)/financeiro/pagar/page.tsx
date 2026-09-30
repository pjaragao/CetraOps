import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { TitlesView } from "../titles-view";

export const metadata = { title: "Contas a pagar" };

export default async function PagarPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("fin.read");
  const sp = await searchParams;
  return <TitlesView direction="PAYABLE" erro={str(sp.erro)} ok={str(sp.ok)} filtro={str(sp.filtro)} />;
}
