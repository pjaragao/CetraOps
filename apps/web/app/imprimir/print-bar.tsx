"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Barra da folha de impressão (some ao imprimir): tamanho da etiqueta, folha A4 ou térmica, preço e o botão de imprimir. */
export function PrintBar({ count, capped, size, a4, showPrice, sizes }: { count: number; capped: boolean; size: string; a4: boolean; showPrice: boolean; sizes: string[] }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const set = (k: string, v: string) => { const q = new URLSearchParams(sp.toString()); q.set(k, v); router.replace(`${path}?${q.toString()}`); };
  return (
    <div data-print-hide className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-neutral-300 bg-neutral-50 p-3 text-sm print:hidden">
      <b>{count} etiqueta(s){capped ? " (limite por folha atingido)" : ""}</b>
      <label>Tamanho <select value={size} onChange={(e) => set("tam", e.target.value)} className="rounded border px-2 py-1">{sizes.map((s) => <option key={s} value={s}>{s.replace("x", " × ")} mm</option>)}</select></label>
      <label>Impressora <select value={a4 ? "a4" : "termica"} onChange={(e) => set("folha", e.target.value)} className="rounded border px-2 py-1"><option value="termica">Térmica (uma por etiqueta)</option><option value="a4">Folha A4 (grade)</option></select></label>
      <label className="flex items-center gap-1"><input type="checkbox" checked={showPrice} onChange={(e) => set("preco", e.target.checked ? "1" : "0")} /> Com preço</label>
      <button type="button" onClick={() => window.print()} className="ml-auto rounded bg-black px-4 py-1.5 font-medium text-white">Imprimir</button>
      <button type="button" onClick={() => history.back()} className="rounded border px-3 py-1.5">Voltar</button>
    </div>
  );
}
