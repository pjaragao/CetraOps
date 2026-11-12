import { notFound, redirect } from "next/navigation";
import { can, requirePerm } from "@/lib/session";
import { type SP } from "@/lib/context";
import { loadNotes, loadScanItems, mergeSummary } from "../[id]/bipar/data";
import { feedGroupAction, refreshReceiptAction, scanGroupAction, bumpItemAction } from "../[id]/bipar/actions";
import { ReceiveScanner } from "../[id]/bipar/receive-scanner";
import { loadTeamPhones } from "../[id]/bipar/team";

export const metadata = { title: "Bipar várias NF-e" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Entrada de várias NF-e de uma vez: três caixas do mesmo pedido, três notas, uma bipagem só. Cada peça entra na nota que ainda precisa dela. */
export default async function BiparVariasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("purch.read");
  const sp = await searchParams;
  const raw = ([] as (string | undefined)[]).concat(sp.n as string | string[] | undefined).flatMap((v) => String(v ?? "").split(","));
  const wanted = [...new Set(raw.map((v) => v.trim().toLowerCase()).filter((v) => UUID.test(v)))].slice(0, 20);
  if (wanted.length === 0) redirect("/produtos/recebimento?erro=" + encodeURIComponent("Escolha as notas que serão bipadas juntas"));
  const found = await loadNotes(wanted);
  if (found.length === 0) notFound();
  const open = found.filter((n) => n.status !== "POSTED");
  if (open.length === 0) redirect("/produtos/recebimento?erro=" + encodeURIComponent("As notas escolhidas já foram lançadas no estoque"));
  if (open.length === 1) redirect(`/produtos/recebimento/${open[0].id}/bipar`);
  const ids = open.map((n) => n.id);                                   // na ordem do número da NF-e: é a ordem em que as notas "enchem"
  const editable = can(session, "purch.write");
  const [items, team] = await Promise.all([loadScanItems(ids), editable ? loadTeamPhones() : Promise.resolve([])]);
  return (
    <ReceiveScanner receiptId={ids.join(",")} summary={mergeSummary(open)} notes={open} initialItems={items} editable={editable} team={team} leaveAction={refreshReceiptAction}
      api={{ scan: scanGroupAction.bind(null, ids), bump: bumpItemAction, feed: feedGroupAction.bind(null, ids) }} />
  );
}
