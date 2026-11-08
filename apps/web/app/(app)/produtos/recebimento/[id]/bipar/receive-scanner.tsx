"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, ArrowLeft, Camera, Check, CheckCircle2, ChevronDown, CircleHelp, CloudOff, Keyboard, Minus, PackageX, Pause, Play, Plus, ScanBarcode, Smartphone, Undo2, Volume2, VolumeX } from "lucide-react";
import { catalogPhoto, formatBRL } from "@centralops/domain";
import { Button, cn, inputClass } from "@/components/ui";
import { AssistPanel, type TeamPhone } from "./assist-panel";
import { cue, unlockAudio } from "./feedback";
import { MiniCamera } from "./mini-camera";
import type { NoteSummary, ScanApi, ScanItem, ScanLink, ScanResult } from "./types";

type Tone = "ok" | "warn" | "err";
interface Read { id: number; code: string; qty: number; at: number; state: "queued" | "done" | "error"; result?: ScanResult; error?: string; undone?: boolean; /** leitura feita em outro aparelho */ remote?: "link" | "other" }
type Tab = "faltando" | "conferidos" | "todos" | "leituras";

const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString("pt-BR", { maximumFractionDigits: 3 }));
const toneOf = (r: Read): Tone => r.state === "error" || r.result?.status === "UNKNOWN" ? "err" : r.result && r.result.status !== "OK" ? "warn" : "ok";

const num = (v: unknown) => (v == null ? undefined : Number(v));
const normalize = (r: ScanResult): ScanResult => ({ ...r, qty_counted: num(r.qty_counted), qty_nfe: num(r.qty_nfe), added: Number(r.added ?? 0), excess: Number(r.excess ?? 0) });
const photoOf = (p: string | null | undefined) => (p ? catalogPhoto(p, 160, process.env.NEXT_PUBLIC_SUPABASE_URL ?? "") : null);

/**
 * Tela de bipagem. mode "staff": no sistema (computador ou celular de quem está logado), com o modo assistido;
 * mode "link": celular aberto pelo link temporário, sem login — as leituras aparecem no computador.
 */
export function ReceiveScanner({ receiptId, summary, initialItems, editable, api, mode = "staff", team = [], leaveAction, expiresAt }: {
  receiptId: string; summary: NoteSummary; initialItems: ScanItem[]; editable: boolean; api: ScanApi; mode?: "staff" | "link";
  team?: TeamPhone[]; leaveAction?: (receiptId: string) => Promise<void>; expiresAt?: string;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [status, setStatus] = useState(summary.status);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [mult, setMult] = useState(1);
  const [reads, setReads] = useState<Read[]>([]);
  const [lastId, setLastId] = useState<number | null>(null);
  const [flash, setFlash] = useState<Tone | null>(null);
  const [offline, setOffline] = useState(false);
  const [tab, setTab] = useState<Tab>("faltando");
  const [manual, setManual] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [links, setLinks] = useState<ScanLink[]>([]);
  const [showAssist, setShowAssist] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const seq = useRef(0);
  const ownEvents = useRef(new Set<number>());
  const lastEvent = useRef(-1);                                   // −1: a primeira consulta só marca onde o registro está
  const linksRef = useRef(links);
  useEffect(() => { linksRef.current = links; }, [links]);
  const queue = useRef<Read[]>([]);
  const working = useRef(false);
  const mutedRef = useRef(muted);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  const storeKey = `bipar:${receiptId}`;
  const canScan = editable && status !== "POSTED" && !linkError;

  // ---------- leituras: fila em série (ordem garantida), guardada no aparelho enquanto não chega ao servidor ----------
  const persist = useCallback(() => {
    try { localStorage.setItem(storeKey, JSON.stringify(queue.current.map((r) => ({ code: r.code, qty: r.qty, at: r.at })))); } catch { /* sem armazenamento */ }
  }, [storeKey]);

  const patchRead = (id: number, patch: Partial<Read>) => setReads((p) => p.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const applyCount = (res: ScanResult) => {
    if (!res.item_id || res.qty_counted == null) return;
    setItems((p) => p.map((i) => (i.id === res.item_id ? { ...i, qty_counted: Number(res.qty_counted) } : i)));
  };

  const pump = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    while (queue.current.length) {
      const r = queue.current[0];
      const out = await api.scan(r.code, r.qty);
      if (!out.ok && out.retry) {
        setOffline(true);
        await new Promise((ok) => setTimeout(ok, 3000));
        continue;                                               // tenta de novo a mesma leitura (sem perder a ordem)
      }
      setOffline(false);
      queue.current.shift();
      persist();
      if (!out.ok) {
        patchRead(r.id, { state: "error", error: out.error });
        if (/lançado/i.test(out.error)) setStatus("POSTED");
        if (mode === "link" && /link/i.test(out.error)) setLinkError(out.error);
        setLastId(r.id); setFlash("err"); cue("ERROR", mutedRef.current);
        continue;
      }
      const res = normalize(out.data);
      if (res.event_id) ownEvents.current.add(res.event_id);
      applyCount(res);
      patchRead(r.id, { state: "done", result: res });
      setLastId(r.id);
      const after = itemsRef.current.map((i) => (i.id === res.item_id ? { ...i, qty_counted: res.qty_counted ?? i.qty_counted } : i));
      const allDone = after.every((i) => i.qty_counted >= i.qty_nfe);
      if (res.status === "OK") {
        const itemDone = res.qty_counted != null && res.qty_nfe != null && res.qty_counted >= res.qty_nfe;
        cue(allDone ? "DONE_ALL" : itemDone ? "COMPLETE" : "OK", mutedRef.current);
        setFlash("ok");
      } else {
        if (res.status !== "ADJUST") cue(res.status, mutedRef.current);
        setFlash(res.status === "UNKNOWN" ? "err" : "warn");
      }
    }
    working.current = false;
  }, [api, mode, persist]);

  const enqueue = useCallback((code: string, qty = mult) => {
    const c = code.trim();
    if (!c || !canScan) return;
    const r: Read = { id: ++seq.current, code: c, qty, at: Date.now(), state: "queued" };
    queue.current.push(r);
    persist();
    setReads((p) => [r, ...p].slice(0, 300));
    setLastId(r.id);
    void pump();
  }, [mult, canScan, persist, pump]);

  // leituras que ficaram no aparelho (sem rede ou página fechada no meio) voltam para a fila
  useEffect(() => {
    const t = setTimeout(() => { try {
      const saved = JSON.parse(localStorage.getItem(storeKey) ?? "[]") as { code: string; qty: number; at: number }[];
      if (saved.length && canScan) {
        setNotice(`${saved.length} leitura(s) que não tinham chegado ao servidor foram reenviadas.`);
        for (const s of saved) {
          const r: Read = { id: ++seq.current, code: s.code, qty: s.qty, at: s.at, state: "queued" };
          queue.current.push(r);
          setReads((p) => [r, ...p]);
        }
        void pump();
      }
    } catch { /* ignora */ } }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 700); return () => clearTimeout(t); }, [flash, lastId]);

  // ---------- leitor USB/Bluetooth (teclado): digita rápido e termina com Enter, fora de qualquer campo ----------
  useEffect(() => {
    if (!canScan) return;
    let buf = "", lastAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const now = Date.now();
      if (now - lastAt > 80) buf = "";
      lastAt = now;
      if (e.key === "Enter") { if (buf.length >= 3) { e.preventDefault(); if (!started) setStarted(true); enqueue(buf); } buf = ""; return; }
      if (e.key.length === 1) buf += e.key;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canScan, enqueue, started]);

  // ---------- tela acesa enquanto bipa ----------
  useEffect(() => {
    if (!running) return;
    let lock: { release(): Promise<void> } | null = null;
    const ask = () => (navigator as unknown as { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen").then((l) => { lock = l; }).catch(() => undefined);
    void ask();
    const onVis = () => { if (document.visibilityState === "visible") void ask(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); void lock?.release().catch(() => undefined); };
  }, [running]);

  // ---------- outros aparelhos na mesma nota (celular do modo assistido, outra pessoa): quantidades e leituras ----------
  useEffect(() => {
    let stop = false, timer: ReturnType<typeof setTimeout> | undefined;
    const sync = async () => {
      if (queue.current.length || working.current || busyItem || document.hidden) return;
      const out = await api.feed(Math.max(0, lastEvent.current));
      if (!out.ok) { if (mode === "link" && /link/i.test(out.error)) setLinkError(out.error); return; }
      if (queue.current.length || working.current) return;
      const f = out.data;
      setStatus(f.status);
      if (f.links) setLinks(f.links);
      const m = new Map(f.items.map((i) => [i.item_id, Number(i.qty_counted)]));
      setItems((p) => p.map((i) => (m.has(i.id) && m.get(i.id) !== i.qty_counted ? { ...i, qty_counted: m.get(i.id)! } : i)));
      const first = lastEvent.current < 0;
      lastEvent.current = Math.max(lastEvent.current, Number(f.last_event) || 0);
      if (first) return;
      const fresh = f.events.filter((e) => !ownEvents.current.has(e.id) && e.result.status !== "ADJUST");
      if (!fresh.length) return;
      const added: Read[] = fresh.map((e) => ({ id: ++seq.current, code: e.code, qty: Number(e.qty), at: new Date(e.at).getTime(), state: "done", result: normalize(e.result), remote: e.by_link ? "link" : "other" }));
      setReads((p) => [...added.reverse(), ...p].slice(0, 300));
      const top = added[0];
      setLastId(top.id);
      const st = top.result!.status;
      if (st === "OK") { const done = (top.result!.qty_counted ?? 0) >= (top.result!.qty_nfe ?? Infinity); cue(done ? "COMPLETE" : "OK", mutedRef.current); setFlash("ok"); }
      else if (st !== "ADJUST") { cue(st, mutedRef.current); setFlash(st === "UNKNOWN" ? "err" : "warn"); }
    };
    const loop = async () => {
      await sync().catch(() => undefined);
      if (stop) return;
      // com celular ligado por link o computador acompanha quase ao vivo
      const ms = mode === "link" ? 4000 : linksRef.current.length ? 1500 : 8000;
      timer = setTimeout(loop, ms);
    };
    void loop();
    const onVis = () => { void sync(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { stop = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [api, mode, busyItem]);

  // ---------- ajustes à mão ----------
  const bump = async (itemId: string, delta: number, readId?: number) => {
    if (!delta) return;
    setBusyItem(itemId);
    const out = await api.bump(itemId, delta);
    setBusyItem(null);
    if (!out.ok) { setNotice(out.error); cue("ERROR", muted); return false; }
    if (out.data.event_id) ownEvents.current.add(Number(out.data.event_id));
    applyCount({ ...out.data, qty_counted: Number(out.data.qty_counted) });
    if (readId) patchRead(readId, { undone: true });
    return true;
  };

  const undoRead = async (r: Read) => {
    if (!r.result?.item_id || !r.result.added || r.undone) return;
    if (await bump(r.result.item_id, -r.result.added, r.id)) setNotice(`Leitura desfeita: ${r.result.label ?? r.result.description ?? r.code} (−${fmtQty(r.result.added)})`);
  };

  const start = () => { unlockAudio(); setStarted(true); setRunning(true); };
  const submitManual = (e: FormEvent) => { e.preventDefault(); if (manual.trim()) { unlockAudio(); enqueue(manual); setManual(""); } };
  // sair: cada leitura já fica salva no banco na hora; só espera as que ainda estão a caminho (sem rede, fica no aparelho)
  const [leaving, setLeaving] = useState(false);
  const leave = async (to: "conferencia" | "lista" = "conferencia") => {
    setLeaving(true);
    for (let i = 0; i < 20 && (queue.current.length || working.current); i++) await new Promise((ok) => setTimeout(ok, 500));
    if (queue.current.length) {
      setLeaving(false);
      setNotice(`${queue.current.length} leitura(s) ainda não chegaram ao servidor (sem conexão). Elas ficam guardadas neste aparelho e vão quando a rede voltar — abra esta nota de novo para enviar.`);
      return;
    }
    if (leaveAction) await leaveAction(receiptId);
    router.push(to === "lista" ? "/produtos/recebimento" : `/produtos/recebimento/${receiptId}`);
  };
  const onlineLinks = links.filter((l) => l.online);

  // ---------- números da nota ----------
  const totals = useMemo(() => {
    const nfe = items.reduce((s, i) => s + i.qty_nfe, 0);
    const counted = items.reduce((s, i) => s + Math.min(i.qty_counted, i.qty_nfe), 0);
    const done = items.filter((i) => i.qty_counted >= i.qty_nfe).length;
    const started = items.filter((i) => i.qty_counted > 0 && i.qty_counted < i.qty_nfe).length;
    const shortage = items.reduce((s, i) => s + (i.qty_counted < i.qty_nfe ? (i.item_total * (i.qty_nfe - i.qty_counted)) / i.qty_nfe : 0), 0);
    const countedValue = items.reduce((s, i) => s + (i.item_total * Math.min(i.qty_counted, i.qty_nfe)) / i.qty_nfe, 0);
    const unlinked = items.filter((i) => !i.variant_id).length;
    return { nfe, counted, done, started, missing: items.length - done, shortage, countedValue, unlinked, pct: nfe ? Math.round((counted / nfe) * 100) : 0 };
  }, [items]);
  const session = useMemo(() => {
    const ok = reads.filter((r) => r.result && r.result.added && !r.undone);
    return {
      pieces: ok.reduce((s, r) => s + (r.result!.added ?? 0), 0),
      excess: reads.reduce((s, r) => s + (r.result?.excess ?? 0), 0),
      problems: reads.filter((r) => r.state === "error" || (r.result && ["UNKNOWN", "NOT_IN_NOTE"].includes(r.result.status))).length,
      queued: reads.filter((r) => r.state === "queued").length,
    };
  }, [reads]);

  const last = reads.find((r) => r.id === lastId) ?? null;
  const lastItem = last?.result?.item_id ? items.find((i) => i.id === last.result!.item_id) : undefined;
  const list = tab === "faltando" ? items.filter((i) => i.qty_counted < i.qty_nfe) : tab === "conferidos" ? items.filter((i) => i.qty_counted >= i.qty_nfe) : items;

  // o item recém-bipado aparece na lista
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => { if (lastItem) rowRefs.current.get(lastItem.id)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [lastItem, lastItem?.qty_counted]);

  return (
    <div className={cn("-mx-4 -my-6 sm:mx-auto sm:my-0 sm:max-w-4xl", mode === "link" && "mx-0 my-0")}>
      {/* ---------- topo fixo: câmera, progresso e o aviso da última leitura ---------- */}
      <div className={cn("sticky top-[var(--topbar-h,49px)] z-20 space-y-2 border-b border-border bg-bg/95 px-3 pb-3 pt-2 backdrop-blur sm:rounded-xl sm:border",
        flash === "ok" && "flash-ok", flash === "warn" && "flash-warn", flash === "err" && "flash-err")}>
        <div className="flex items-center gap-2">
          {mode === "staff" ? <button type="button" onClick={() => void leave("conferencia")} className="rounded-lg p-1.5 hover:bg-surface-2" aria-label="Voltar para a conferência"><ArrowLeft size={18} /></button>
            : <Smartphone size={18} className="mx-1 text-brand" aria-hidden />}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">NF-e {summary.nfNumber} · {summary.supplier}</p>
            <p className="truncate text-xs text-muted">Recebimento {summary.receiptNumber} · entrada em {summary.location}</p>
          </div>
          {mode === "staff" && onlineLinks.length > 0 && (
            <button type="button" onClick={() => setShowAssist(true)} className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] text-success">
              <Smartphone size={12} /> {onlineLinks.length === 1 ? "celular ligado" : `${onlineLinks.length} celulares`}
            </button>
          )}
          {offline && <span className="flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] text-warning"><CloudOff size={12} /> sem conexão</span>}
          <button type="button" onClick={() => { unlockAudio(); setMuted((m) => !m); }} className="rounded-lg p-1.5 hover:bg-surface-2" aria-label={muted ? "Ligar som" : "Tirar som"}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
        </div>

        <div className="flex gap-3">
          {canScan && started ? <MiniCamera active={running} onCode={(c) => enqueue(c)} flash={flash} /> : null}
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-2xl font-bold tabular-nums leading-none">{fmtQty(totals.counted)}<span className="text-base font-medium text-muted"> / {fmtQty(totals.nfe)} peças</span></p>
              <span className={cn("text-sm font-semibold tabular-nums", totals.pct === 100 ? "text-success" : "text-muted")}>{totals.pct}%</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={totals.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Peças conferidas">
              <div className={cn("h-full rounded-full transition-all duration-300", totals.pct === 100 ? "bg-success" : "bg-brand")} style={{ width: `${totals.pct}%` }} />
            </div>
            <div className="flex flex-wrap gap-1 text-[11px]">
              <span className="rounded-full bg-success/15 px-2 py-0.5 text-success">{totals.done} item(ns) ok</span>
              <span className="rounded-full bg-surface-2 px-2 py-0.5">{totals.missing} faltando</span>
              {session.excess > 0 && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-warning">{fmtQty(session.excess)} sobra(s)</span>}
              {session.queued > 0 && <span className="rounded-full bg-brand/15 px-2 py-0.5 text-brand">{session.queued} enviando…</span>}
            </div>
            {canScan && started && (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <Button type="button" variant="secondary" className="h-8 px-2.5 text-xs" onClick={() => setRunning((r) => !r)}>{running ? <><Pause size={14} /> Pausar</> : <><Play size={14} /> Retomar</>}</Button>
                <div className="flex h-8 items-center rounded-lg border border-border bg-surface text-xs" title="Quantas peças cada leitura soma (caixa fechada, pacote)">
                  <button type="button" className="px-2" onClick={() => setMult((m) => Math.max(1, m - 1))} aria-label="Diminuir peças por leitura"><Minus size={13} /></button>
                  <span className="min-w-12 text-center tabular-nums">×{mult}</span>
                  <button type="button" className="px-2" onClick={() => setMult((m) => Math.min(999, m + 1))} aria-label="Aumentar peças por leitura"><Plus size={13} /></button>
                </div>
                <Button type="button" variant="ghost" className="h-8 px-2 text-xs" onClick={() => setShowManual((s) => !s)}><Keyboard size={14} /> Digitar</Button>
              </div>
            )}
          </div>
        </div>

        {canScan && !started && (
          <>
            {/* celular: botão grande para o polegar; computador: botões do tamanho normal e o modo assistido em primeiro */}
            <button type="button" onClick={start} className={cn("flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-4 text-base font-semibold text-brand-contrast shadow-sm active:scale-[.99]", mode === "staff" && "sm:hidden")}>
              <ScanBarcode size={22} /> Começar a bipar
            </button>
            {mode === "staff" && (
              <div className="hidden flex-wrap items-center gap-2 sm:flex">
                <Button type="button" onClick={() => { unlockAudio(); setShowAssist(true); }}><Smartphone size={16} /> Usar o celular como leitor</Button>
                <Button type="button" variant="secondary" onClick={start}><Camera size={16} /> Câmera deste computador</Button>
                <span className="text-xs text-muted">Leitor USB ou Bluetooth? É só bipar, sem clicar em nada.</span>
              </div>
            )}
          </>
        )}
        {mode === "staff" && showAssist && canScan && (
          <AssistPanel receiptId={receiptId} receiptLabel={`NF-e ${summary.nfNumber} · ${summary.supplier}`} team={team} links={links}
            onLinks={setLinks} onClose={() => setShowAssist(false)} />
        )}
        {linkError && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{linkError}</p>}
        {canScan && (showManual || !started) && (
          <form onSubmit={submitManual} className="flex gap-2">
            <input value={manual} onChange={(e) => setManual(e.target.value)} className={inputClass} placeholder="EAN, SKU ou código do fornecedor" aria-label="Digitar código" inputMode="text" autoCapitalize="characters" enterKeyHint="go" />
            <Button disabled={!manual.trim()}>Lançar</Button>
          </form>
        )}
        {!canScan && !linkError && <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">{status === "POSTED" ? "Esta nota já foi lançada no estoque: a bipagem está fechada." : "Você pode ver a conferência, mas não tem permissão para bipar."}</p>}

        {last && <LastRead read={last} item={lastItem} canUndo={canScan && !last.remote} onUndo={() => undoRead(last)} />}
        {notice && <p className="flex items-start justify-between gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-xs" role="status">{notice}<button type="button" className="text-muted" onClick={() => setNotice(null)} aria-label="Fechar aviso">✕</button></p>}
      </div>

      {/* ---------- resumo da nota ---------- */}
      <section className="mx-3 mt-3 rounded-xl border border-border bg-surface sm:mx-0">
        <button type="button" onClick={() => setShowSummary((s) => !s)} className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left">
          <span className="text-sm font-semibold">Resumo da nota</span>
          <span className="flex items-center gap-2 text-xs text-muted">{formatBRL(summary.nfTotal)} · bipado {formatBRL(totals.countedValue)}<ChevronDown size={16} className={cn("transition-transform", showSummary && "rotate-180")} /></span>
        </button>
        {showSummary && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border px-3 py-3 text-sm">
            <dt className="text-muted">Fornecedor</dt><dd className="text-right">{summary.supplier}{summary.supplierCnpj && <span className="block text-xs text-muted">{summary.supplierCnpj}</span>}</dd>
            <dt className="text-muted">Nota / emissão</dt><dd className="text-right">{summary.nfNumber}{summary.issueAt && <span className="block text-xs text-muted">{summary.issueAt}</span>}</dd>
            <dt className="text-muted">Produtos</dt><dd className="text-right tabular-nums">{formatBRL(summary.vProd)}</dd>
            <dt className="text-muted">Frete / desconto</dt><dd className="text-right tabular-nums">{formatBRL(summary.vFrete)} / {formatBRL(summary.vDesc)}</dd>
            <dt className="text-muted">Total da nota</dt><dd className="text-right font-semibold tabular-nums">{formatBRL(summary.nfTotal)}</dd>
            <dt className="text-muted">Itens (linhas)</dt><dd className="text-right tabular-nums">{items.length} · {totals.done} ok · {totals.started} em andamento</dd>
            <dt className="text-muted">Peças na nota</dt><dd className="text-right tabular-nums">{fmtQty(totals.nfe)}</dd>
            <dt className="text-muted">Bipadas (conferidas)</dt><dd className="text-right font-semibold tabular-nums text-success">{fmtQty(totals.counted)} · {formatBRL(totals.countedValue)}</dd>
            <dt className="text-muted">Faltando</dt><dd className={cn("text-right tabular-nums", totals.shortage > 0 && "text-warning")}>{fmtQty(totals.nfe - totals.counted)} · {formatBRL(totals.shortage)}</dd>
            <dt className="text-muted">Nesta sessão</dt><dd className="text-right tabular-nums">{fmtQty(session.pieces)} peça(s) · {reads.length} leitura(s){session.problems ? ` · ${session.problems} problema(s)` : ""}</dd>
            {totals.unlinked > 0 && <dd className="col-span-2 rounded-lg bg-warning/10 px-2 py-1.5 text-xs text-warning">{totals.unlinked} item(ns) ainda sem peça do catálogo: bipam pelo EAN ou código da nota; ligue-os na conferência antes de lançar.</dd>}
            <dd className="col-span-2 pt-1 text-xs text-muted">Faltas viram crédito com o fornecedor ao lançar. Sobras não entram: peça nota complementar.</dd>
          </dl>
        )}
      </section>

      {/* ---------- itens da nota ---------- */}
      <nav className="mx-3 mt-3 flex gap-1 overflow-x-auto text-sm sm:mx-0" aria-label="Filtro dos itens">
        {([["faltando", `Faltando (${totals.missing})`], ["conferidos", `Conferidos (${totals.done})`], ["todos", `Todos (${items.length})`], ["leituras", `Leituras (${reads.length})`]] as [Tab, string][]).map(([v, l]) => (
          <button key={v} type="button" onClick={() => setTab(v)} className={cn("shrink-0 rounded-full px-3 py-1", tab === v ? "bg-brand text-brand-contrast" : "border border-border bg-surface")}>{l}</button>
        ))}
      </nav>

      {tab === "leituras" ? (
        <ul className="mx-3 mb-3 mt-2 divide-y divide-border rounded-xl border border-border bg-surface sm:mx-0">
          {reads.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">Nenhuma leitura nesta sessão.</li>}
          {reads.map((r) => (
            <li key={r.id} className={cn("flex items-center gap-2 px-3 py-2 text-sm", r.undone && "opacity-50")}>
              <StatusIcon read={r} />
              <div className="min-w-0 flex-1">
                <p className="truncate">{r.result?.label ?? r.result?.description ?? r.code}</p>
                <p className="truncate text-xs text-muted">{new Date(r.at).toLocaleTimeString("pt-BR")}{r.remote ? (r.remote === "link" ? " · pelo celular" : " · outro aparelho") : ""} · {r.code}{r.qty > 1 ? ` ×${r.qty}` : ""} · {readText(r)}</p>
              </div>
              {canScan && !r.remote && r.result?.added && !r.undone ? <Button type="button" variant="ghost" className="h-8 px-2 text-xs" onClick={() => undoRead(r)}><Undo2 size={14} /> Desfazer</Button> : null}
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mx-3 mb-3 mt-2 space-y-1.5 sm:mx-0">
          {list.length === 0 && <li className="rounded-xl border border-border bg-surface px-3 py-6 text-center text-sm text-muted">{tab === "faltando" ? "Tudo conferido! 🎉" : "Nada aqui ainda."}</li>}
          {list.map((i) => {
            const done = i.qty_counted >= i.qty_nfe;
            const pct = Math.min(100, Math.round((i.qty_counted / i.qty_nfe) * 100));
            return (
              <li key={i.id} ref={(el) => { if (el) rowRefs.current.set(i.id, el); else rowRefs.current.delete(i.id); }}
                className={cn("flex items-center gap-2.5 rounded-xl border bg-surface p-2 transition-colors", lastItem?.id === i.id ? "border-brand ring-2 ring-brand/30" : "border-border", done && "bg-success/5")}>
                <Thumb src={i.photo} done={done} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{i.label ?? i.description}</p>
                  <p className="truncate text-[11px] text-muted">#{i.n_item} · {i.sku ?? i.cprod ?? "—"}{i.cean && !/^0+$/.test(i.cean) ? ` · ${i.cean}` : ""}{!i.variant_id && <span className="text-warning"> · sem vínculo</span>}</p>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className={cn("h-full rounded-full", done ? "bg-success" : "bg-brand")} style={{ width: `${pct}%` }} /></div>
                </div>
                {canScan ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" disabled={busyItem === i.id || i.qty_counted <= 0} onClick={() => bump(i.id, -1)} className="grid h-9 w-9 place-items-center rounded-lg border border-border disabled:opacity-40" aria-label={`Tirar uma peça de ${i.label ?? i.description}`}><Minus size={16} /></button>
                    {editing === i.id ? (
                      <QtyEditor value={i.qty_counted} max={i.qty_nfe} onCancel={() => setEditing(null)}
                        onSave={async (v) => { setEditing(null); if (v !== i.qty_counted) await bump(i.id, v - i.qty_counted); }} />
                    ) : (
                      <button type="button" onClick={() => setEditing(i.id)} className="min-w-14 rounded-lg px-1 py-1 text-center tabular-nums hover:bg-surface-2" aria-label={`Editar quantidade de ${i.label ?? i.description}`}>
                        <span className={cn("text-base font-semibold", done && "text-success")}>{fmtQty(i.qty_counted)}</span><span className="text-xs text-muted">/{fmtQty(i.qty_nfe)}</span>
                      </button>
                    )}
                    <button type="button" disabled={busyItem === i.id || done} onClick={() => bump(i.id, 1)} className="grid h-9 w-9 place-items-center rounded-lg border border-border disabled:opacity-40" aria-label={`Somar uma peça em ${i.label ?? i.description}`}><Plus size={16} /></button>
                  </div>
                ) : (
                  <span className="shrink-0 tabular-nums"><b>{fmtQty(i.qty_counted)}</b><span className="text-xs text-muted">/{fmtQty(i.qty_nfe)}</span></span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* ---------- rodapé: concluir (no computador) ou aviso (no celular do link) ---------- */}
      <div className="sticky bottom-0 z-20 border-t border-border bg-bg/95 px-3 py-2.5 backdrop-blur sm:rounded-xl sm:border">
        {mode === "link" ? (
          <p className="text-center text-xs text-muted">
            {totals.pct === 100 ? "Todas as peças conferidas! " : `Faltam ${fmtQty(totals.nfe - totals.counted)} peça(s). `}
            As leituras já aparecem no computador.{expiresAt ? ` Link válido até ${new Date(expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.` : ""}
          </p>
        ) : (
          <div className="mx-auto flex max-w-3xl items-center gap-2">
            <div className="min-w-0 flex-1 text-xs">
              <p className="truncate text-muted">{totals.pct === 100 ? "Todas as peças da nota conferidas." : `Faltam ${fmtQty(totals.nfe - totals.counted)} peça(s) · ${formatBRL(totals.shortage)}`}</p>
              <p className={cn("truncate", session.queued ? "text-brand" : "text-success")}>{session.queued ? `Salvando ${session.queued} leitura(s)…` : "✓ Tudo salvo"}</p>
            </div>
            <Button type="button" variant="secondary" disabled={leaving} onClick={() => void leave("lista")} title="As leituras já estão salvas: volta para a lista e continua depois de onde parou">
              {leaving ? "Salvando…" : "Salvar e sair"}
            </Button>
            <Link href={`/produtos/recebimento/${receiptId}`} onClick={(e) => { e.preventDefault(); void leave("conferencia"); }}
              className={cn("inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium", totals.pct === 100 ? "bg-success text-white" : "bg-brand text-brand-contrast")}>
              <Check size={16} /> {totals.pct === 100 ? "Concluir conferência" : "Ir para a conferência"}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function readText(r: Read): string {
  if (r.state === "queued") return "enviando…";
  if (r.state === "error") return r.error ?? "erro";
  const s = r.result!;
  if (r.undone) return "desfeita";
  switch (s.status) {
    case "OK": return `+${fmtQty(s.added ?? 0)} · ${fmtQty(s.qty_counted ?? 0)}/${fmtQty(s.qty_nfe ?? 0)}`;
    case "PARTIAL_EXCESS": return `+${fmtQty(s.added ?? 0)} e ${fmtQty(s.excess ?? 0)} a mais que a nota`;
    case "EXCESS": return "sobra: a nota já está completa para este item";
    case "NOT_IN_NOTE": return "peça do catálogo que não está nesta nota";
    default: return "código não encontrado";
  }
}

function StatusIcon({ read }: { read: Read }) {
  if (read.state === "queued") return <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand border-t-transparent" aria-label="Enviando" />;
  const t = toneOf(read);
  if (read.result?.status === "NOT_IN_NOTE") return <PackageX size={18} className="shrink-0 text-warning" />;
  return t === "ok" ? <CheckCircle2 size={18} className="shrink-0 text-success" /> : t === "warn" ? <AlertTriangle size={18} className="shrink-0 text-warning" /> : <CircleHelp size={18} className="shrink-0 text-danger" />;
}

function Thumb({ src, done }: { src: string | null; done?: boolean }) {
  return (
    <div className="relative h-12 w-10 shrink-0 overflow-hidden rounded-md bg-surface-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" /> : <ScanBarcode size={16} className="absolute inset-0 m-auto text-muted" />}
      {done && <CheckCircle2 size={16} className="absolute bottom-0.5 right-0.5 rounded-full bg-surface text-success" />}
    </div>
  );
}

/** Aviso grande da última leitura: produto, foto e quanto já foi conferido do item (sempre o número atual do item). */
function LastRead({ read, item, canUndo, onUndo }: { read: Read; item?: ScanItem; canUndo: boolean; onUndo(): void }) {
  const t = read.state === "queued" || read.undone ? null : toneOf(read);
  const s = read.result;
  const counted = item?.qty_counted ?? s?.qty_counted ?? 0;
  const total = item?.qty_nfe ?? s?.qty_nfe;
  const title = read.state === "queued" ? "Lendo…" : read.state === "error" ? "Não foi possível lançar" : read.undone ? "Leitura desfeita"
    : s?.status === "OK" ? (total != null && counted >= total ? "Item completo!" : "Lida e somada")
    : s?.status === "PARTIAL_EXCESS" ? "Somada em parte: passou da nota" : s?.status === "EXCESS" ? "Sobra! A nota já está completa" : s?.status === "NOT_IN_NOTE" ? "Esta peça não está nesta nota" : "Código não encontrado";
  const name = s?.label ?? item?.label ?? s?.description ?? item?.description ?? null;
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border-2 p-2.5 transition-colors", t === null && "border-border bg-surface",
      t === "ok" && "border-success bg-success/10", t === "warn" && "border-warning bg-warning/10", t === "err" && "border-danger bg-danger/10")} role="status" aria-live="polite">
      <Thumb src={item?.photo ?? photoOf(s?.photo)} />
      <div className="min-w-0 flex-1">
        <p className={cn("text-xs font-semibold uppercase tracking-wide", t === null && "text-muted", t === "ok" && "text-success", t === "warn" && "text-warning", t === "err" && "text-danger")}>
          {title}{read.remote === "link" ? <span className="ml-1.5 font-normal normal-case text-muted">· pelo celular</span> : null}
        </p>
        <p className="truncate text-sm font-medium">{name ?? read.code}</p>
        <p className="truncate text-xs text-muted">{read.state === "error" ? read.error : s?.sku ?? item?.sku ?? read.code}{s?.status === "UNKNOWN" ? " · confira a etiqueta ou digite o código" : ""}</p>
      </div>
      {total != null && (
        <div className="shrink-0 text-right">
          <p className="text-2xl font-bold tabular-nums leading-none">{fmtQty(counted)}<span className="text-sm font-medium text-muted">/{fmtQty(total)}</span></p>
          {canUndo && s?.added ? !read.undone ? <button type="button" onClick={onUndo} className="mt-1 inline-flex items-center gap-1 text-xs text-brand"><Undo2 size={12} /> desfazer</button> : null : null}
        </div>
      )}
    </div>
  );
}

function QtyEditor({ value, max, onSave, onCancel }: { value: number; max: number; onSave(v: number): void; onCancel(): void }) {
  const [v, setV] = useState(String(value));
  const n = Number(v.replace(",", "."));
  const valid = v !== "" && Number.isFinite(n) && n >= 0 && n <= max;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (valid) onSave(n); }} className="flex items-center gap-1">
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={() => (valid ? onSave(n) : onCancel())} onKeyDown={(e) => e.key === "Escape" && onCancel()}
        inputMode="decimal" className={cn(inputClass, "h-9 w-16 px-1 text-center", !valid && "border-danger")} aria-label={`Quantidade conferida (máximo ${max})`} />
    </form>
  );
}
