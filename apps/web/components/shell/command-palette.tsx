"use client";
import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { NavArea } from "@centralops/domain";
import { globalSearch, type SearchHit } from "@/app/(app)/actions";

/** Ctrl+K: navegação, ações rápidas, busca de clientes, produtos (SKU/EAN) e pedidos, e pergunta direta à Central. */
export function CommandPalette({ nav, central = false }: { nav: NavArea[]; central?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [, start] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("centralops:palette", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("centralops:palette", onOpen); };
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = setTimeout(() => start(async () => setHits(await globalSearch(q))), 200);
    return () => clearTimeout(t);
  }, [q]);
  const shownHits = q.trim().length < 2 ? [] : hits;

  const go = (href: string) => { setOpen(false); setQ(""); router.push(href); };
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-center bg-black/40 px-4 pt-[12vh]" onClick={() => setOpen(false)}>
      <Command
        label="Paleta de comandos"
        shouldFilter={false}
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Command.Input
          autoFocus value={q} onValueChange={setQ}
          placeholder="Cliente, telefone, SKU, pedido… ou uma tela"
          className="w-full border-b border-border bg-transparent px-4 py-3 outline-none"
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        />
        <Command.List className="max-h-[60vh] overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-sm text-muted">Nada encontrado.</Command.Empty>
          {shownHits.length > 0 && (
            <Command.Group heading="Resultados" className="text-xs text-muted [&_[cmdk-group-items]]:mt-1">
              {shownHits.map((h) => (
                <Command.Item key={h.href} onSelect={() => go(h.href)} className="flex cursor-pointer justify-between rounded-lg px-3 py-2 text-sm text-text aria-selected:bg-surface-2">
                  <span>{h.title}</span><span className="text-xs text-muted">{h.kind}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Ações" className="mt-2 text-xs text-muted">
            {central && (
              <Command.Item onSelect={() => { setOpen(false); setQ(""); window.dispatchEvent(new CustomEvent("centralops:central", { detail: { text: q.trim() } })); }}
                            className="cursor-pointer rounded-lg px-3 py-2 text-sm text-text aria-selected:bg-surface-2">
                {q.trim() ? `Perguntar à Central: “${q.trim()}”` : "Abrir a Central (Ctrl+/)"}
              </Command.Item>
            )}
            <Command.Item onSelect={() => go("/vender/pdv")} className="cursor-pointer rounded-lg px-3 py-2 text-sm text-text aria-selected:bg-surface-2">Nova venda no PDV</Command.Item>
            <Command.Item onSelect={() => go("/atendimento?filtro=aguardando")} className="cursor-pointer rounded-lg px-3 py-2 text-sm text-text aria-selected:bg-surface-2">Conversas aguardando humano</Command.Item>
          </Command.Group>
          <Command.Group heading="Ir para" className="mt-2 text-xs text-muted">
            {nav.flatMap((a) => [{ label: a.label, href: a.href }, ...a.items.map((i) => ({ label: `${a.label} › ${i.label}`, href: i.href }))])
              .filter((i, idx, arr) => arr.findIndex((x) => x.href === i.href) === idx)
              .filter((i) => !q || i.label.toLowerCase().includes(q.toLowerCase()))
              .map((i) => (
                <Command.Item key={i.href} onSelect={() => go(i.href)} className="cursor-pointer rounded-lg px-3 py-2 text-sm text-text aria-selected:bg-surface-2">
                  {i.label}
                </Command.Item>
              ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
