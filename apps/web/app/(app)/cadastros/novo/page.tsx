import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { LinkButton, Narrow, PageHeader } from "@/components/ui";
import { PartyForm } from "./party-form";

export const metadata = { title: "Novo cadastro" };

export default async function NovoCadastroPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.write");
  const company = str((await searchParams).tipo) === "empresa";
  return (
    <Narrow>
      <PageHeader title={company ? "Nova empresa" : "Nova pessoa"} description={company ? "Fornecedor, academia parceira, transportadora…" : "Cliente, afiliada, prestadora ou qualquer pessoa que o sistema precise conhecer."}
        actions={<LinkButton href={company ? "/cadastros/empresas" : "/cadastros/pessoas"}>Voltar</LinkButton>} />
      <PartyForm company={company} canReadDocs={can(session, "ai.assistant")} />
    </Narrow>
  );
}
