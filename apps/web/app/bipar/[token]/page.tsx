import type { Metadata } from "next";
import { Smartphone } from "lucide-react";
import { photoUrl } from "@/lib/photos";
import { ReceiveScanner } from "@/app/(app)/produtos/recebimento/[id]/bipar/receive-scanner";
import { mergeSummary } from "@/app/(app)/produtos/recebimento/[id]/bipar/data";
import type { GroupNote, ScanItem } from "@/app/(app)/produtos/recebimento/[id]/bipar/types";
import { linkBumpAction, linkFeedAction, linkScanAction, openLink } from "./actions";

export const metadata: Metadata = { title: "Bipar entrada", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

/** Modo assistido: o celular abre o link do WhatsApp (ou do QR) e bipa a nota, sem entrar no sistema. */
export default async function BiparPorLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const out = await openLink(token);
  if (!out.ok) {
    return (
      <main className="grid min-h-dvh place-items-center bg-bg p-6 text-center">
        <div className="max-w-sm space-y-2">
          <Smartphone size={32} className="mx-auto text-muted" />
          <h1 className="text-lg font-semibold">Não deu para abrir a bipagem</h1>
          <p className="text-sm text-muted">{out.error}</p>
          <p className="text-xs text-muted">No computador, abra a nota e toque em “Usar o celular como leitor” para gerar um link novo.</p>
        </div>
      </main>
    );
  }
  const toNote = (s: Record<string, unknown>): GroupNote => ({
    id: String(s.id ?? ""), receiptNumber: String(s.receiptNumber ?? ""), status: String(s.status ?? ""), nfNumber: String(s.nfNumber ?? "—"), issueAt: (s.issueAt as string | null) ?? null,
    supplier: String(s.supplier ?? "Fornecedor"), supplierCnpj: (s.supplierCnpj as string | null) ?? null, location: String(s.location ?? "—"),
    nfTotal: Number(s.nfTotal ?? 0), vProd: Number(s.vProd ?? 0), vFrete: Number(s.vFrete ?? 0), vDesc: Number(s.vDesc ?? 0),
  });
  // o link pode cobrir várias notas (as peças entram na nota que ainda precisa delas)
  const notes = (out.data.notes?.length ? out.data.notes : [out.data.summary]).map(toNote);
  const summary = mergeSummary(notes);
  const items: ScanItem[] = out.data.items.map((i) => ({
    id: String(i.id), receipt_id: i.receipt_id ? String(i.receipt_id) : undefined, n_item: Number(i.n_item), description: String(i.description ?? ""), cprod: (i.cprod as string | null) ?? null, cean: (i.cean as string | null) ?? null,
    qty_nfe: Number(i.qty_nfe), qty_counted: Number(i.qty_counted ?? 0), item_total: Number(i.item_total ?? 0), variant_id: (i.variant_id as string | null) ?? null,
    sku: (i.sku as string | null) ?? null, label: (i.label as string | null) ?? null, photo: i.photo ? photoUrl(String(i.photo), 160) : null,
  }));
  return (
    <main className="min-h-dvh bg-bg" style={{ ["--topbar-h" as string]: "0px" }}>
      <ReceiveScanner receiptId={token} summary={summary} notes={notes.length > 1 ? notes : undefined} initialItems={items} editable mode="link" expiresAt={out.data.expires_at}
        api={{ scan: linkScanAction.bind(null, token), bump: linkBumpAction.bind(null, token), feed: linkFeedAction.bind(null, token) }} />
    </main>
  );
}
