import { requirePerm } from "@/lib/session";
import type { SP } from "@/lib/context";
import { TitlesView } from "../titles-view";

export const metadata = { title: "Contas a receber" };

export default async function Page({ searchParams }: { searchParams: SP }) {
  await requirePerm("fin.read");
  return <TitlesView direction="RECEIVABLE" sp={await searchParams} />;
}
