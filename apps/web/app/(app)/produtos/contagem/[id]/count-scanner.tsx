"use client";
import { useRef, useState, useTransition, type KeyboardEvent } from "react";
import { ScanBarcode } from "lucide-react";
import { BarcodeScanner, type ScannedCode } from "@/components/central/barcode-scanner";
import { Button, cn, inputClass } from "@/components/ui";
import { countItem, lookupCodes } from "../actions";

export interface CountLine { variant_id: string; sku: string; label: string; counted: number; expected: number }

/** Bipe com o leitor USB (o campo fica sempre em foco) ou com a câmera. Cada bipe soma 1; a quantidade pode ser corrigida à mão. */
export function CountScanner({ countId, initial, editable }: { countId: string; initial: CountLine[]; editable: boolean }) {
  const [lines, setLines] = useState<CountLine[]>(initial);
  const [code, setCode] = useState("");
  const [camera, setCamera] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  const apply = (variant: { id: string; sku: string; label: string }, counted: number) =>
    setLines((p) => {
      const i = p.findIndex((l) => l.variant_id === variant.id);
      if (counted === 0) return p.filter((l) => l.variant_id !== variant.id);
      if (i >= 0) return p.map((l, j) => (j === i ? { ...l, counted } : l));
      return [{ variant_id: variant.id, sku: variant.sku, label: variant.label, counted, expected: 0 }, ...p];
    });

  const scan = (codes: string[]) => start(async () => {
    const { found, missing } = await lookupCodes(codes);
    let last = "";
    for (const c of codes) {
      const hit = found[c.trim()];
      if (!hit) continue;
      const r = await countItem(countId, hit.id, 1, "ADD");
      if (!r.ok) { setMsg({ tone: "err", text: r.error }); return; }
      apply(hit, r.counted);
      last = `${hit.sku} · ${r.counted} contada(s)`;
    }
    setMsg(missing.length ? { tone: "err", text: `Código não encontrado no catálogo: ${missing.join(", ")}` } : last ? { tone: "ok", text: last } : null);
    input.current?.focus();
  });

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const c = code.trim();
    setCode("");
    if (c) scan([c]);
  };

  const setQty = (l: CountLine, qty: number) => start(async () => {
    const r = await countItem(countId, l.variant_id, Math.max(0, qty), "SET");
    if (!r.ok) { setMsg({ tone: "err", text: r.error }); return; }
    apply({ id: l.variant_id, sku: l.sku, label: l.label }, Math.max(0, qty));
  });

  const pieces = lines.reduce((a, l) => a + l.counted, 0);
  const diffs = lines.filter((l) => l.counted !== l.expected).length;

  return (
    <div className="space-y-3">
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <input ref={input} autoFocus value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={onKey} disabled={pending}
            className={`${inputClass} max-w-sm`} placeholder="Bipe a etiqueta ou digite o SKU/EAN e Enter" aria-label="Código da peça" />
          <Button type="button" variant="secondary" onClick={() => setCamera(true)}><ScanBarcode size={16} /> Câmera</Button>
          <span className="text-sm text-muted">{pieces} peça(s) em {lines.length} item(ns) · {diffs} com diferença</span>
        </div>
      )}
      {msg && <p role={msg.tone === "err" ? "alert" : "status"} className={cn("rounded-lg px-3 py-2 text-sm", msg.tone === "err" ? "bg-danger/10 text-danger" : "bg-success/10 text-success")}>{msg.text}</p>}
      {camera && <BarcodeScanner title="Bipar peças da contagem" onClose={() => setCamera(false)} onDone={(codes: ScannedCode[]) => { setCamera(false); scan(codes.map((c) => c.value)); }} />}
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-xs text-muted"><tr><th className="px-3 py-2 text-left">Peça</th><th className="px-3 py-2 text-right">No sistema</th><th className="px-3 py-2 text-right">Contado</th><th className="px-3 py-2 text-right">Diferença</th></tr></thead>
          <tbody className="divide-y divide-border">
            {lines.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-muted">Nenhuma peça bipada ainda.</td></tr>}
            {lines.map((l) => {
              const d = l.counted - l.expected;
              return (
                <tr key={l.variant_id}>
                  <td className="px-3 py-1.5"><span className="font-mono text-xs text-muted">{l.sku}</span> {l.label}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{l.expected}</td>
                  <td className="px-3 py-1.5 text-right">
                    {editable ? <input type="number" min={0} defaultValue={l.counted} key={l.counted} onBlur={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n !== l.counted) setQty(l, n); }}
                      className={`${inputClass} ml-auto w-20 text-right`} aria-label={`Quantidade contada de ${l.sku}`} /> : <span className="tabular-nums">{l.counted}</span>}
                  </td>
                  <td className={cn("px-3 py-1.5 text-right font-medium tabular-nums", d > 0 && "text-success", d < 0 && "text-danger")}>{d > 0 ? `+${d}` : d}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
