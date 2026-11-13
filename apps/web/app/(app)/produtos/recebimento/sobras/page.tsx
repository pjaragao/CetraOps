import { can, requirePerm } from "@/lib/session";
import { LinkButton, PageHeader } from "@/components/ui";
import { loadExtrasOverview, loadNotes } from "../[id]/bipar/data";
import { ExtrasManager } from "../[id]/bipar/extras-ui";

export const metadata = { title: "Sobras e fora da NF" };

/** Tudo que chegou e não está na NF, de todas as notas: o que fazer, devoluções, entradas sem NF a definir, concluídas e lixeira (30 dias). */
export default async function SobrasPage() {
  const session = await requirePerm("purch.read");
  const overview = await loadExtrasOverview(null);
  const ids = [...new Set([...overview.pending, ...overview.trash].map((x) => x.receipt_id).filter(Boolean) as string[])].slice(0, 100);
  const notes = ids.length ? await loadNotes(ids) : [];
  const names = Object.fromEntries(notes.map((n) => [n.id, `NF ${n.nfNumber.split("/")[0]} · ${n.receiptNumber}`]));
  return (
    <>
      <PageHeader title="Sobras e fora da NF" description="Peça lida a mais, peça que não está na nota e código desconhecido. Dê um destino a cada uma: compensar com um faltante parecido, dar entrada sem NF (e definir depois: presente da marca ou NF a lançar) ou devolver. Itens apagados ficam 30 dias na lixeira."
        actions={<LinkButton href="/produtos/recebimento">Voltar ao recebimento</LinkButton>} />
      <ExtrasManager scope={null} initial={overview} canWrite={can(session, "purch.write")} receiptNames={names} />
    </>
  );
}
