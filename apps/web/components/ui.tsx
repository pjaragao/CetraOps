import Link from "next/link";
import { clsx } from "clsx";
import type { ReactNode } from "react";

export function cn(...args: Parameters<typeof clsx>) {
  return clsx(...args);
}

/**
 * Página de formulário ou texto: segura a largura em max-w-form para os campos não esticarem na tela larga.
 * Listas, tabelas e painéis não usam: ocupam a largura toda (que cresce ao recolher a barra lateral).
 */
export function Narrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("max-w-form", className)}>{children}</div>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-4xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, className, action }: { title?: string; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={cn("rounded-xl border border-border bg-surface p-4", className)}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-muted">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "success" | "warning" | "danger" }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold", tone === "success" && "text-success", tone === "warning" && "text-warning", tone === "danger" && "text-danger")}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

const badgeTones = {
  neutral: "bg-surface-2 text-muted",
  brand: "bg-brand/10 text-brand",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
  info: "bg-info/10 text-info",
} as const;

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: keyof typeof badgeTones; className?: string }) {
  return <span className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", badgeTones[tone], className)}>{children}</span>;
}

export function Button({
  children, variant = "primary", className, ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-50",
        variant === "primary" && "bg-brand text-brand-contrast hover:opacity-90",
        variant === "secondary" && "border border-border bg-surface hover:bg-surface-2",
        variant === "ghost" && "hover:bg-surface-2",
        variant === "danger" && "bg-danger text-white hover:opacity-90",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = "secondary" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium",
        variant === "primary" ? "bg-brand text-brand-contrast hover:opacity-90" : "border border-border bg-surface hover:bg-surface-2",
      )}
    >
      {children}
    </Link>
  );
}

/** Paginação de lista: "1–100 de 507" e anterior/próxima, mantendo os filtros da URL (a página vai em ?p=). */
export function Pager({ path, params, page, pageSize, total }: { path: string; params: Record<string, string | undefined>; page: number; pageSize: number; total: number }) {
  if (total <= 0) return null;
  const pages = Math.ceil(total / pageSize);
  const href = (p: number) => {
    const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])));
    if (p > 1) q.set("p", String(p));
    const s = q.toString();
    return s ? `${path}?${s}` : path;
  };
  const step = "rounded-lg border border-border px-3 py-1.5";
  return (
    <nav className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm" aria-label="Paginação">
      <span className="text-muted">{(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} de {total}</span>
      {pages > 1 && (
        <span className="flex items-center gap-1">
          {page > 1 ? <Link href={href(page - 1)} className={cn(step, "hover:bg-surface-2")}>← Anterior</Link> : <span className={cn(step, "opacity-40")}>← Anterior</span>}
          <span className="px-2 text-muted">{page} de {pages}</span>
          {page < pages ? <Link href={href(page + 1)} className={cn(step, "hover:bg-surface-2")}>Próxima →</Link> : <span className={cn(step, "opacity-40")}>Próxima →</span>}
        </span>
      )}
    </nav>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-8 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

/** Tabela simples e responsiva (rolagem horizontal só dentro do cartão). */
/** Tabela padrão (busca, ordenação por coluna e filtros): ver components/data-table.tsx. */
export { Table } from "./data-table";

export const inputClass =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand";
