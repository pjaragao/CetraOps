import { notFound } from "next/navigation";
import { can, requirePerm } from "@/lib/session";
import { loadExtras, loadNotes, loadScanItems, loadSiblings } from "./data";
import { bumpItemAction, discardExtrasAction, feedAction, refreshReceiptAction, resetReviewAction, reviewGroupAction, scanGroupAction } from "./actions";
import { ReceiveScanner } from "./receive-scanner";
import { loadTeamPhones } from "./team";

export const metadata = { title: "Bipar entrada" };

/** Entrada de mercadoria pelo leitor: câmera do celular (ou leitor USB/Bluetooth) somando cada peça no item da NF-e. */
export default async function BiparRecebimentoPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePerm("purch.read");
  const { id } = await params;
  const [note] = await loadNotes([id]);
  if (!note) notFound();
  const editable = can(session, "purch.write");
  const [items, team, siblings, extras] = await Promise.all([loadScanItems(id), editable ? loadTeamPhones() : Promise.resolve([]), editable ? loadSiblings(id) : Promise.resolve([]), loadExtras([id])]);
  return (
    <ReceiveScanner receiptId={id} summary={note} initialItems={items} editable={editable} team={team} leaveAction={refreshReceiptAction} siblings={siblings} initialExtras={extras}
      api={{ scan: scanGroupAction.bind(null, [id]), bump: bumpItemAction, feed: feedAction.bind(null, id), discard: discardExtrasAction, review: reviewGroupAction.bind(null, [id]), resetReview: resetReviewAction.bind(null, [id]) }} />
  );
}
