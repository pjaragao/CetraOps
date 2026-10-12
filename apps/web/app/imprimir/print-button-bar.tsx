"use client";

/** Botões de imprimir e voltar (não saem na impressão). */
export function PrintButtonBar() {
  return (
    <div data-print-hide className="mb-4 flex gap-2 print:hidden">
      <button type="button" onClick={() => window.print()} className="rounded bg-black px-4 py-1.5 text-sm font-medium text-white">Imprimir</button>
      <button type="button" onClick={() => history.back()} className="rounded border px-3 py-1.5 text-sm">Voltar</button>
    </div>
  );
}
