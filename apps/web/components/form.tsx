import type { ReactNode } from "react";
import { cn } from "./ui";

/** Mensagens de retorno das ações (?ok= / ?erro=). */
export function Flash({ ok, erro }: { ok?: string; erro?: string }) {
  return (
    <>
      {erro && <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{erro}</p>}
      {ok && <p role="status" className="mb-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">{ok}</p>}
    </>
  );
}

/** Rótulo + campo no padrão do sistema. */
export function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <label className={cn("block text-xs text-muted", className)}>
      {label}
      {children}
      {hint && <span className="mt-0.5 block text-[11px] opacity-80">{hint}</span>}
    </label>
  );
}

/** Formata data ISO (yyyy-mm-dd) como dd/mm/aaaa. */
export const fmtDate = (d: string | null | undefined) => (d ? d.split("-").reverse().join("/") : "—");

/** Mês por extenso a partir de yyyy-mm-dd: "outubro/2026". */
export const fmtMonth = (d: string) => {
  const [y, m] = d.split("-");
  return `${["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"][Number(m) - 1]}/${y}`;
};
