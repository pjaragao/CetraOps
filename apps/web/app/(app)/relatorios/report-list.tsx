"use client";
import Link from "next/link";
import { useState } from "react";
import { ChevronRight, Search, Sparkles } from "lucide-react";
import { Badge, cn, inputClass } from "@/components/ui";

export interface ReportEntry {
  href: string;
  title: string;
  description: string;
  area: string;
  kind: "pronto" | "equipe";
  meta?: string;
}

const AREAS = ["Vendas", "Clientes", "Atendimento", "Financeiro", "Estoque"];
const KINDS = [["todos", "Todos"], ["pronto", "Prontos"], ["equipe", "Criados pela equipe"]] as const;
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Lista de relatórios por área, com busca e filtro entre os prontos e os criados pela equipe. */
export function ReportList({ entries }: { entries: ReportEntry[] }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>("todos");
  const words = fold(q).split(/\s+/).filter(Boolean);
  const shown = entries.filter((e) => (kind === "todos" || e.kind === kind) && words.every((w) => fold(`${e.title} ${e.description} ${e.area} ${e.meta ?? ""}`).includes(w)));
  const areas = [...AREAS, ...new Set(entries.map((e) => e.area).filter((a) => !AREAS.includes(a)))];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative min-w-60 flex-1 sm:max-w-sm">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar relatório…" aria-label="Buscar relatório" className={cn(inputClass, "pl-9")} />
        </label>
        <div className="flex gap-1 rounded-lg border border-border p-0.5 text-sm" role="tablist" aria-label="Tipo de relatório">
          {KINDS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
              className={cn("rounded-md px-3 py-1", kind === k ? "bg-brand/10 font-medium text-brand" : "text-muted hover:text-text")}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 && (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted">
          Nenhum relatório encontrado. <Link href="/relatorios/novo" className="font-medium text-brand">Criar um novo</Link>, descrevendo para a IA o que você quer ver.
        </p>
      )}

      <div className="space-y-6">
        {areas.map((area) => {
          const items = shown.filter((e) => e.area === area);
          if (!items.length) return null;
          return (
            <section key={area} aria-labelledby={`area-${area}`}>
              <h2 id={`area-${area}`} className="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">{area}</h2>
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
                {items.map((e) => (
                  <li key={e.href}>
                    <Link href={e.href} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{e.title}</span>
                          {e.kind === "equipe" && <Badge tone="info"><Sparkles size={11} className="mr-1" aria-hidden />Da equipe</Badge>}
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-sm text-muted">{e.description}</p>
                        {e.meta && <p className="mt-0.5 text-xs text-muted/80">{e.meta}</p>}
                      </div>
                      <ChevronRight size={16} className="shrink-0 text-muted" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
