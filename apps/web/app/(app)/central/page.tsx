import { ASSISTANT_NAME } from "@centralops/domain";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { PageHeader } from "@/components/ui";
import { listCentralThreads } from "./actions";
import { CentralWorkspace } from "./workspace";

export const metadata = { title: ASSISTANT_NAME };

export default async function CentralPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("ai.assistant");
  const sp = await searchParams;
  const threads = await listCentralThreads();
  return (
    <>
      <PageHeader title={ASSISTANT_NAME} description="Fale, escreva, bipe ou mande uma foto. A Central consulta o sistema com as suas permissões e prepara vendas, cadastros, contas e tarefas em cartões que você confere e confirma." />
      <CentralWorkspace threads={threads} initialThread={str(sp.c) ?? null} />
    </>
  );
}
