import type { SP } from "@/lib/context";
import { PartyList } from "../lista";

export const metadata = { title: "Empresas" };

export default function EmpresasPage({ searchParams }: { searchParams: SP }) {
  return <PartyList kind="COMPANY" searchParams={searchParams} />;
}
