import type { SP } from "@/lib/context";
import { PartyList } from "../lista";

export const metadata = { title: "Pessoas" };

export default function PessoasPage({ searchParams }: { searchParams: SP }) {
  return <PartyList kind="PERSON" searchParams={searchParams} />;
}
