"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, Check, Gift, PackagePlus, Pencil, ScanBarcode, Trash2, Truck, Undo2, X } from "lucide-react";
import { catalogPhoto } from "@centralops/domain";
import { Button, cn, inputClass } from "@/components/ui";
import { VariantPicker, type VariantHit } from "../../../compras/variant-picker";
import { discardExtrasAction } from "./actions";
import { compensationCandidatesAction, defineNoNfAction, extrasOverviewAction, linkableReceiptsAction, linkNoNfAction, markReturnedAction, reopenResolutionAction, resolveExtraAction, restoreExtrasAction, setExtraQtyAction } from "./extras-actions";
import type { CompensationCandidate, ExtraResolution, ExtrasOverview, ScanExtra } from "./types";

const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString("pt-BR", { maximumFractionDigits: 3 }));
const photoOf = (p: string | null | undefined) => (p ? catalogPhoto(p, 160, process.env.NEXT_PUBLIC_SUPABASE_URL ?? "") : null);
const dmy = (iso: string) => new Date(iso).toLocaleDateString("pt-BR");

export const KIND_LABEL: Record<ScanExtra["kind"], string> = { EXCESS: "Sobra: a nota já estava completa", NOT_IN_NOTE: "Fora da nota", UNKNOWN: "Código não reconhecido" };

function Pic({ src }: { src: string | null }) {
  return (
    <div className="relative h-12 w-10 shrink-0 overflow-hidden rounded-md bg-surface-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" /> : <ScanBarcode size={16} className="absolute inset-0 m-auto text-muted" />}
    </div>
  );
}

type Action = "COMPENSATE" | "ENTRY_NO_NF" | "RETURN";

/** O que fazer com uma sobra / peça fora da NF. */
function ExtraDialog({ row, receiptIds, onClose, onDone }: { row: ScanExtra; receiptIds: string[]; onClose(): void; onDone(reload: boolean): void }) {
  const [action, setAction] = useState<Action | null>(null);
  const [qty, setQty] = useState(String(row.qty));
  const [variant, setVariant] = useState<{ id: string; label: string } | null>(row.variant_id ? { id: row.variant_id, label: row.label ?? row.sku ?? "peça" } : null);
  const [cands, setCands] = useState<CompensationCandidate[] | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // faltantes da nota para compensar (depois de saber qual peça chegou)
  useEffect(() => {
    if (action !== "COMPENSATE" || !variant) return;
    let live = true;
    void compensationCandidatesAction(receiptIds, variant.id).then((out) => { if (live) { setCands(out.ok ? out.data : []); if (!out.ok) setError(out.error); } });
    return () => { live = false; };
  }, [action, variant, receiptIds]);

  const n = Number(qty);
  const qtyOk = Number.isInteger(n) && n >= 1 && n <= row.qty;
  const pickedCand = cands?.find((c) => c.item_id === target);
  const canSubmit = !busy && !!action && qtyOk && (action === "RETURN" || !!variant) && (action !== "COMPENSATE" || (!!pickedCand && n <= pickedCand.missing));

  const submit = async () => {
    if (!action) return;
    setBusy(true); setError(null);
    const out = await resolveExtraAction({ action, events: row.events, qty: n, variantId: variant?.id ?? null, targetItemId: target, note });
    setBusy(false);
    if (!out.ok) { setError(out.error); return; }
    onDone(action === "COMPENSATE");                       // compensar muda as linhas da nota: a tela recarrega
    onClose();
  };

  const opt = (a: Action, icon: React.ReactNode, title: string, text: string) => (
    <button type="button" onClick={() => { setAction(a); setError(null); }}
      className={cn("flex w-full items-start gap-3 rounded-xl border p-3 text-left", action === a ? "border-brand bg-brand/5" : "border-border hover:bg-surface-2")}>
      <span className="mt-0.5 text-brand">{icon}</span>
      <span className="min-w-0"><span className="block text-sm font-semibold">{title}</span><span className="block text-xs text-muted">{text}</span></span>
    </button>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="extra-title" className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-xl">
        <div className="mb-3 flex items-start gap-3">
          <Pic src={photoOf(row.photo)} />
          <div className="min-w-0 flex-1">
            <h2 id="extra-title" className="truncate font-semibold">{row.label ?? row.code}</h2>
            <p className="text-xs text-muted">{KIND_LABEL[row.kind]} · {row.sku ?? row.code} · <b>{fmtQty(row.qty)}</b> peça(s) pendente(s)</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-surface-2" aria-label="Fechar"><X size={18} /></button>
        </div>

        <p className="mb-2 text-sm font-medium">O que fazer com {row.qty === 1 ? "esta peça" : "estas peças"}?</p>
        <div className="space-y-2">
          {opt("COMPENSATE", <ArrowLeftRight size={18} />, "Compensar com um faltante parecido", "A peça que chegou vale por um item da NF que faltou (outro tamanho ou cor, preço parecido). A nota continua fechando.")}
          {opt("ENTRY_NO_NF", <PackagePlus size={18} />, "Dar entrada sem NF", "Entra no estoque agora e fica “a definir”, sem prazo: depois vira presente da marca ou espera a NF chegar.")}
          {opt("RETURN", <Truck size={18} />, "Não dar entrada e devolver", "Não entra no estoque. Fica na lista de devoluções até você marcar como devolvida.")}
        </div>

        {action && (
          <div className="mt-4 space-y-3 border-t border-border pt-3">
            <label className="block text-xs font-medium text-muted">Quantas peças
              <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" className={cn(inputClass, "mt-1 w-28", !qtyOk && "border-danger")} />
              <span className="ml-2 text-[11px] font-normal">de {fmtQty(row.qty)} pendentes (o resto continua pendente)</span>
            </label>

            {action !== "RETURN" && (
              <div className="text-xs font-medium text-muted">Peça que chegou
                {variant ? (
                  <p className="mt-1 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text"><Check size={14} className="text-success" /> <span className="min-w-0 flex-1 truncate">{variant.label}</span>
                    {!row.variant_id && <button type="button" onClick={() => { setVariant(null); setTarget(null); setCands(null); }} className="text-xs text-brand">trocar</button>}</p>
                ) : (
                  <div className="mt-1"><VariantPicker onPick={(v: VariantHit) => setVariant({ id: v.id, label: `${v.sku} · ${v.label}` })} placeholder="Qual peça do catálogo chegou? SKU, EAN ou nome" autoFocus />
                    <p className="mt-1 text-[11px] font-normal">O código lido não está no catálogo: escolha a peça (ou cadastre antes em Produtos).</p></div>
                )}
              </div>
            )}

            {action === "COMPENSATE" && variant && (
              <div className="text-xs font-medium text-muted">Faltante que ela compensa
                {cands === null ? <p className="mt-1 font-normal">Buscando itens que faltaram…</p>
                  : cands.length === 0 ? <p className="mt-1 rounded-lg bg-warning/10 px-3 py-2 font-normal text-warning">Nenhum item das notas está faltando agora. Bipe a nota inteira primeiro ou escolha outro destino.</p>
                  : (
                    <ul className="mt-1 max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                      {cands.map((c) => (
                        <li key={c.item_id}>
                          <label className={cn("flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-normal text-text", target === c.item_id && "bg-brand/5")}>
                            <input type="radio" name="cand" checked={target === c.item_id} onChange={() => setTarget(c.item_id)} />
                            <span className="min-w-0 flex-1"><span className="block truncate">{c.label}</span>
                              <span className="block text-xs text-muted">NF {c.nf} · faltam {fmtQty(c.missing)} · R$ {c.unit_cost.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} un.</span></span>
                            {c.same_product && <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] text-success">mesmo produto</span>}
                            {c.diff_pct != null && <span className={cn("rounded px-1.5 py-0.5 text-[10px]", Math.abs(c.diff_pct) <= 15 ? "bg-success/15 text-success" : "bg-warning/15 text-warning")}>{c.diff_pct > 0 ? "+" : ""}{c.diff_pct}% no preço</span>}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                {pickedCand && n > pickedCand.missing && <p className="mt-1 font-normal text-danger">Esse item só tem {fmtQty(pickedCand.missing)} peça(s) faltando: diminua a quantidade.</p>}
              </div>
            )}

            <label className="block text-xs font-medium text-muted">Observação (opcional)
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={cn(inputClass, "mt-1")} placeholder={action === "RETURN" ? "Ex.: devolver na próxima visita do representante" : "Ex.: combinado com o fornecedor"} />
            </label>
            {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>{busy ? "Salvando…" : action === "COMPENSATE" ? "Compensar" : action === "ENTRY_NO_NF" ? "Dar entrada sem NF" : "Devolver (sem dar entrada)"}</Button>
              <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            </div>
          </div>
        )}
        {!action && error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{error}</p>}
      </div>
    </div>,
    document.body,
  );
}

/** Botões de uma linha de sobra: o que fazer, editar a quantidade e apagar (lixeira de 30 dias). */
export function ExtraRowActions({ row, receiptIds, onChanged }: { row: ScanExtra; receiptIds: string[]; onChanged(reload?: boolean): void }) {
  const [dialog, setDialog] = useState(false);
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState(String(row.qty));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveQty = async () => {
    const n = Number(qty);
    if (!Number.isInteger(n) || n < 0) { setError("Quantidade inválida"); return; }
    if (n === 0 && !window.confirm("Quantidade zero apaga esta linha (vai para a lixeira por 30 dias). Continuar?")) return;
    setBusy(true); setError(null);
    const out = await setExtraQtyAction(row.events, n);
    setBusy(false);
    if (!out.ok) { setError(out.error); return; }
    setEditing(false); onChanged();
  };
  const trash = async () => {
    if (!window.confirm("Apagar esta sobra? Ela vai para a lixeira e pode ser restaurada em até 30 dias.")) return;
    setBusy(true); setError(null);
    const out = await discardExtrasAction(row.events);
    setBusy(false);
    if (!out.ok) { setError(out.error); return; }
    onChanged();
  };

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      {editing ? (
        <form onSubmit={(e) => { e.preventDefault(); void saveQty(); }} className="flex items-center gap-1">
          <input autoFocus value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" className={cn(inputClass, "h-8 w-16 px-1 text-center")} aria-label="Quantidade da sobra" />
          <Button type="submit" className="h-8 px-2 text-xs" disabled={busy}><Check size={14} /></Button>
          <Button type="button" variant="ghost" className="h-8 px-2 text-xs" onClick={() => { setEditing(false); setQty(String(row.qty)); setError(null); }}><X size={14} /></Button>
        </form>
      ) : (
        <div className="flex items-center gap-1">
          <Button type="button" className="h-8 px-2.5 text-xs" onClick={() => setDialog(true)} disabled={busy}>O que fazer</Button>
          <Button type="button" variant="ghost" className="h-8 px-2 text-xs" onClick={() => { setEditing(true); setQty(String(row.qty)); }} disabled={busy} title="Editar a quantidade" aria-label="Editar a quantidade"><Pencil size={14} /></Button>
          <Button type="button" variant="ghost" className="h-8 px-2 text-xs text-danger" onClick={() => void trash()} disabled={busy} title="Apagar (vai para a lixeira por 30 dias)" aria-label="Apagar"><Trash2 size={14} /></Button>
        </div>
      )}
      {error && <p className="max-w-56 text-right text-[11px] text-danger" role="alert">{error}</p>}
      {dialog && <ExtraDialog row={row} receiptIds={receiptIds} onClose={() => setDialog(false)} onDone={(reload) => onChanged(reload)} />}
    </div>
  );
}

const ACTION_LABEL: Record<ExtraResolution["action"], string> = { COMPENSATE: "Compensada com faltante", ENTRY_NO_NF: "Entrada sem NF", RETURN: "Devolução" };

function resolutionText(r: ExtraResolution): string {
  if (r.action === "RETURN") return r.status === "OPEN" ? "A devolver (não entrou no estoque)" : "Devolvida";
  if (r.action === "COMPENSATE") return `Compensou ${r.detail.target_label ? `“${String(r.detail.target_label)}”` : "um item que faltou"}`;
  if (r.destination === "GIFT") return "Entrou no estoque como presente da marca";
  if (r.destination === "NF_LINKED") return `Entrou no estoque e foi vinculada à NF${r.detail.linked_receipt_number ? ` (recebimento ${String(r.detail.linked_receipt_number)})` : ""}`;
  if (r.destination === "NF_LATER") return "Entrou no estoque · NF a lançar depois";
  return "Entrou no estoque · a definir (presente da marca ou NF depois)";
}

/** Tudo sobre as sobras de uma ou de todas as notas: pendentes, devoluções, entradas sem NF a definir, concluídas e lixeira. */
export function ExtrasManager({ scope, initial, canWrite, receiptNames = {}, onChanged }: {
  /** notas do escopo; null = todas */ scope: string[] | null; initial: ExtrasOverview; canWrite: boolean; receiptNames?: Record<string, string>; onChanged?: (reload?: boolean) => void;
}) {
  const [data, setData] = useState(initial);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<{ id: string; label: string }[] | null>(null);
  const [pick, setPick] = useState("");

  const reload = useCallback(async () => {
    const out = await extrasOverviewAction(scope);
    if (out.ok) setData(out.data);
  }, [scope]);

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, okText: string, reloadPage = false) => {
    setBusy(key); setMsg(null);
    const out = await fn();
    setBusy(null);
    if (!out.ok) { setMsg({ tone: "err", text: out.error ?? "Não foi possível concluir" }); return; }
    setMsg({ tone: "ok", text: okText });
    await reload();
    if (onChanged) onChanged(reloadPage); else if (reloadPage) window.location.reload();      // compensar muda as linhas da nota: recarrega a tela
  };

  const toReturn = data.resolutions.filter((r) => r.action === "RETURN" && r.status === "OPEN");
  const noNf = data.resolutions.filter((r) => r.action === "ENTRY_NO_NF" && r.status === "OPEN");
  const done = data.resolutions.filter((r) => r.status === "DONE");
  const daysLeft = (iso: string) => Math.max(0, 30 - Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));

  const resRow = (r: ExtraResolution, children?: React.ReactNode) => (
    <li className="flex flex-wrap items-center gap-2.5 px-3 py-2 text-sm">
      <Pic src={photoOf(r.photo)} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{r.label ?? r.code} <span className="font-normal text-muted">×{fmtQty(r.qty)}</span></p>
        <p className="truncate text-xs text-muted">{resolutionText(r)}{r.receipt_number ? ` · recebimento ${r.receipt_number}` : ""} · {dmy(r.created_at)}{r.note ? ` · ${r.note}` : ""}</p>
      </div>
      {canWrite && <div className="flex flex-wrap items-center gap-1">{children}</div>}
    </li>
  );
  const reopenBtn = (r: ExtraResolution) => r.destination === "NF_LINKED" ? null : (
    <Button key="reopen" type="button" variant="ghost" className="h-8 px-2 text-xs" disabled={busy === r.id}
      onClick={() => { if (window.confirm("Reabrir: a peça volta a aparecer como pendente e o que foi feito (estoque, compensação) é desfeito. Continuar?")) void run(r.id, () => reopenResolutionAction(r.id), "A sobra voltou a aparecer como pendente", r.action === "COMPENSATE"); }}>
      <Undo2 size={14} /> Reabrir
    </Button>
  );

  const startLink = async (r: ExtraResolution) => {
    setLinking(r.id); setPick("");
    if (!receipts) { const out = await linkableReceiptsAction(); setReceipts(out.ok ? out.data : []); }
  };

  const section = (title: string, hint: string | null, count: number, body: React.ReactNode, tone?: "warn") => count === 0 ? null : (
    <section className={cn("rounded-xl border bg-surface", tone === "warn" ? "border-warning/60" : "border-border")}>
      <div className="px-3 py-2.5"><p className="text-sm font-semibold">{title} <span className="font-normal text-muted">({count})</span></p>{hint && <p className="text-xs text-muted">{hint}</p>}</div>
      <ul className="divide-y divide-border border-t border-border">{body}</ul>
    </section>
  );

  const empty = data.pending.length + data.resolutions.length + data.trash.length === 0;

  return (
    <div className="space-y-3">
      {msg && <p role={msg.tone === "err" ? "alert" : "status"} className={cn("rounded-lg px-3 py-2 text-sm", msg.tone === "err" ? "bg-danger/10 text-danger" : "bg-success/10 text-success")}>{msg.text}</p>}
      {empty && <p className="rounded-xl border border-border bg-surface px-3 py-6 text-center text-sm text-muted">Nenhuma sobra nem peça fora da NF. Peça lida a mais, peça que não está na nota e código desconhecido aparecem aqui.</p>}

      {section("Pendentes: o que fazer com essas peças", "Sobras e peças que chegaram e não estão na NF. Escolha o destino de cada uma.", data.pending.length,
        data.pending.map((x) => (
          <li key={`${x.kind}:${x.events[0]}`} className="flex flex-wrap items-center gap-2.5 px-3 py-2 text-sm">
            <Pic src={photoOf(x.photo)} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{x.label ?? x.code}</p>
              <p className="truncate text-xs text-muted">{KIND_LABEL[x.kind]} · {x.sku ?? x.code}{x.receipt_id && receiptNames[x.receipt_id] ? ` · ${receiptNames[x.receipt_id]}` : ""}</p>
            </div>
            <span className="shrink-0 text-base font-semibold tabular-nums">×{fmtQty(x.qty)}</span>
            {canWrite && <ExtraRowActions row={x} receiptIds={scope ?? (x.receipt_id ? [x.receipt_id] : [])} onChanged={(reloadPage) => { void reload(); if (onChanged) onChanged(reloadPage); else if (reloadPage) window.location.reload(); }} />}
          </li>
        )), "warn")}

      {section("A devolver", "Não entraram no estoque. Marque como devolvida quando devolver ao fornecedor.", toReturn.length,
        toReturn.map((r) => (
          <Fragment key={r.id}>{resRow(r, <>
            <Button type="button" className="h-8 px-2.5 text-xs" disabled={busy === r.id} onClick={() => void run(r.id, () => markReturnedAction(r.id), "Marcada como devolvida")}><Truck size={14} /> Marcar devolvida</Button>
            {reopenBtn(r)}
          </>)}</Fragment>
        )))}

      {section("Entradas sem NF a definir", "Já estão no estoque. Defina quando puder, sem prazo: presente da marca, ou NF a lançar (e vincule quando a nota chegar).", noNf.length,
        noNf.map((r) => (
          <Fragment key={r.id}>{resRow(r, <>
            <Button type="button" className="h-8 px-2.5 text-xs" disabled={busy === r.id} onClick={() => { if (window.confirm("Lançar como presente da marca? A peça passa a ter entrada como patrocínio em espécie, com custo zero.")) void run(r.id, () => defineNoNfAction(r.id, "GIFT"), "Lançada como presente da marca"); }}><Gift size={14} /> Presente da marca</Button>
            {r.destination !== "NF_LATER" && <Button type="button" variant="secondary" className="h-8 px-2.5 text-xs" disabled={busy === r.id} onClick={() => void run(r.id, () => defineNoNfAction(r.id, "NF_LATER"), "Marcada: NF a lançar depois")}>NF depois</Button>}
            <Button type="button" variant="secondary" className="h-8 px-2.5 text-xs" disabled={busy === r.id} onClick={() => void startLink(r)}>Vincular à NF…</Button>
            {reopenBtn(r)}
            {linking === r.id && (
              <div className="flex w-full flex-wrap items-center gap-1.5 pt-1">
                <select value={pick} onChange={(e) => setPick(e.target.value)} className={cn(inputClass, "h-8 max-w-xs flex-1 text-xs")} aria-label="Nota para vincular">
                  <option value="">Escolha a nota…</option>
                  {(receipts ?? []).map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
                </select>
                <Button type="button" className="h-8 px-2.5 text-xs" disabled={!pick || busy === r.id} onClick={() => void run(r.id, () => linkNoNfAction(r.id, pick), "Vinculada: a peça passa a entrar pelo lançamento da nota")}>Vincular</Button>
                <Button type="button" variant="ghost" className="h-8 px-2 text-xs" onClick={() => setLinking(null)}>Cancelar</Button>
              </div>
            )}
          </>)}</Fragment>
        )))}

      {section("Concluídas", null, done.length, done.map((r) => (
        <Fragment key={r.id}>{resRow(r, <>
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{ACTION_LABEL[r.action]}</span>
          {reopenBtn(r)}
        </>)}</Fragment>
      )))}

      {section("Lixeira", "Itens apagados ficam aqui por 30 dias e podem ser restaurados.", data.trash.length,
        data.trash.map((x) => (
          <li key={`t:${x.events[0]}`} className="flex flex-wrap items-center gap-2.5 px-3 py-2 text-sm">
            <Pic src={photoOf(x.photo)} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{x.label ?? x.code} <span className="font-normal text-muted">×{fmtQty(x.qty)}</span></p>
              <p className="truncate text-xs text-muted">{KIND_LABEL[x.kind]}{x.trashed_at ? ` · apagada em ${dmy(x.trashed_at)} · some em ${daysLeft(x.trashed_at)} dia(s)` : ""}</p>
            </div>
            {canWrite && <Button type="button" variant="secondary" className="h-8 px-2.5 text-xs" disabled={busy === `t:${x.events[0]}`} onClick={() => void run(`t:${x.events[0]}`, () => restoreExtrasAction(x.events), "Restaurada: voltou para as pendentes")}><Undo2 size={14} /> Restaurar</Button>}
          </li>
        )))}
    </div>
  );
}
