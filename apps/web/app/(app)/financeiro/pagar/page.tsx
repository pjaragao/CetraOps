import { requirePerm } from "@/lib/session";
import type { SP } from "@/lib/context";
import { TitlesView } from "../titles-view";

export const metadata = { title: "Contas a pagar" };

export default async function Page({ searchParams }: { searchParams: SP }) {
  await requirePerm("fin.read");
  return <TitlesView direction="PAYABLE" sp={await searchParams} />;
}
