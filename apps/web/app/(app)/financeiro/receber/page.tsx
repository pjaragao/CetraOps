import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { TitlesView } from "../titles-view";

export const metadata = { title: "Contas a receber" };

export default async function ReceberPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("fin.read");
  return <TitlesView direction="RECEIVABLE" erro={str((await searchParams).erro)} />;
}
