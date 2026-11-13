import { notFound, redirect } from "next/navigation";
import { can, requirePerm } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { rpcAny } from "@/lib/rpc";
import { type SP } from "@/lib/context";
import { loadExtras, loadNotes, loadScanItems, mergeSummary } from "../[id]/bipar/data";
import { feedGroupAction, finishBatchAction, refreshReceiptAction, scanGroupAction, bumpItemAction, discardExtrasAction, resetReviewAction, reviewGroupAction } from "../[id]/bipar/actions";
import { ReceiveScanner } from "../[id]/bipar/receive-scanner";
import { loadTeamPhones } from "../[id]/bipar/team";

export const metadata = { title: "Bipar várias NF-e" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const back = (msg: string): never => redirect("/produtos/recebimento?erro=" + encodeURIComponent(msg));

/**
 * Lote de entrada: três caixas do mesmo pedido, três notas, uma bipagem só. Cada peça entra na nota que ainda precisa dela.
 * O lote fica salvo (aparece na lista de recebimentos até ser finalizado): ?lote=<id>. Com ?n=<ids> (notas marcadas na lista) o lote é criado/reaberto.
 */
export default async function BiparVariasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("purch.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const loteParam = typeof sp.lote === "string" ? sp.lote : undefined;

  let batchId: string;
  let wanted: string[];
  if (loteParam && UUID.test(loteParam)) {
    const { data, error } = await rpcAny(supabase, "purch", "get_receipt_batch", { p_batch: loteParam });
    if (error || !data) notFound();
    const b = data as { id: string; status: string; receipt_ids: string[] };
    if (b.status !== "OPEN") back("Este lote já foi finalizado");
    batchId = b.id; wanted = b.receipt_ids;
  } else {
    const raw = ([] as (string | undefined)[]).concat(sp.n as string | string[] | undefined).flatMap((v) => String(v ?? "").split(","));
    wanted = [...new Set(raw.map((v) => v.trim().toLowerCase()).filter((v) => UUID.test(v)))].slice(0, 20);
    if (wanted.length === 0) back("Escolha as notas que serão bipadas juntas");
    if (wanted.length === 1) redirect(`/produtos/recebimento/${wanted[0]}/bipar`);
    if (!can(session, "purch.write")) back("Sem permissão para bipar");
    const { data, error } = await rpcAny(supabase, "purch", "open_receipt_batch", { p_receipts: wanted });
    if (error || !data) back(error?.message.replace(/^ERROR:\s*/, "") ?? "Não foi possível abrir o lote");
    redirect(`/produtos/recebimento/bipar?lote=${data as string}`);          // endereço fixo do lote: dá para voltar a ele depois
  }

  const found = await loadNotes(wanted);
  if (found.length === 0) notFound();
  const open = found.filter((n) => n.status !== "POSTED");
  if (open.length === 0) back("As notas deste lote já foram lançadas no estoque");
  if (open.length === 1) redirect(`/produtos/recebimento/${open[0].id}/bipar`);
  const ids = open.map((n) => n.id);                                   // na ordem do número da NF-e: é a ordem em que as notas "enchem"
  const editable = can(session, "purch.write");
  const [items, team, extras] = await Promise.all([loadScanItems(ids), editable ? loadTeamPhones() : Promise.resolve([]), loadExtras(ids)]);
  return (
    <ReceiveScanner receiptId={ids.join(",")} summary={mergeSummary(open)} notes={open} initialItems={items} initialExtras={extras} editable={editable} team={team} leaveAction={refreshReceiptAction}
      finishBatch={editable ? finishBatchAction.bind(null, batchId) : undefined}
      api={{ scan: scanGroupAction.bind(null, ids), bump: bumpItemAction, feed: feedGroupAction.bind(null, ids), discard: discardExtrasAction, review: reviewGroupAction.bind(null, ids), resetReview: resetReviewAction.bind(null, ids) }} />
  );
}
