"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import {
  BadgeCheck, ChevronDown, FileText, Landmark, LayoutDashboard, Megaphone, Menu, MessagesSquare, PanelLeftClose, PanelLeftOpen, Settings, Shirt,
  ShoppingBag, Sparkles, Users, X,
} from "lucide-react";
import type { NavArea } from "@sie/domain";
import { cn } from "@/components/ui";

const ICONS = { BadgeCheck, FileText, Landmark, LayoutDashboard, Megaphone, MessagesSquare, Settings, Shirt, ShoppingBag, Sparkles, Users };
const KEY = "sie:sidebar-collapsed";

/** A escolha de recolher a barra fica no navegador (por pessoa); sem armazenamento disponível, a barra abre expandida. */
function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener("sie:sidebar", cb);
  return () => { window.removeEventListener("storage", cb); window.removeEventListener("sie:sidebar", cb); };
}
function readCollapsed(): boolean {
  try { return window.localStorage.getItem(KEY) === "1"; } catch { return false; }
}
function writeCollapsed(v: boolean) {
  try { window.localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* sem armazenamento: vale só nesta página */ }
  window.dispatchEvent(new Event("sie:sidebar"));
}

export function Sidebar({ nav }: { nav: NavArea[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const collapsed = useSyncExternalStore(subscribe, readCollapsed, () => false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const active = (href: string) => pathname === href || pathname.startsWith(href + "/");

  const render = (rail: boolean) => (
    <nav aria-label="Menu principal" className={cn("flex h-full flex-col gap-1 overflow-y-auto p-3", rail && "items-center px-2")}>
      <Link href="/inicio" className={cn("mb-4 px-2 pt-1", rail && "px-0 text-center")} onClick={() => setOpen(false)} title="Início">
        {rail ? <span className="text-sm font-semibold tracking-wider text-accent">SJ</span> : (
          <>
            <span className="block text-xs tracking-[0.3em] text-accent uppercase">SIÉ JOY</span>
            <span className="text-lg font-semibold">OS</span>
          </>
        )}
      </Link>
      {nav.map((area) => {
        const Icon = ICONS[area.icon as keyof typeof ICONS] ?? LayoutDashboard;
        const areaActive = active(area.href) || area.items.some((i) => active(i.href));
        const isOpen = !rail && area.items.length > 0 && (expanded[area.key] ?? areaActive);
        const toggle = () => setExpanded((e) => ({ ...e, [area.key]: !(e[area.key] ?? areaActive) }));
        return (
          <div key={area.key} className={cn(rail && "w-full")}>
            <div className={cn("flex items-center rounded-lg", areaActive ? "bg-brand/10 text-brand" : "text-text hover:bg-surface-2", rail && "justify-center")}>
              <Link
                href={area.href}
                title={rail ? area.label : undefined}
                aria-label={rail ? area.label : undefined}
                onClick={(e) => {
                  setOpen(false);
                  if (!rail && area.items.length > 0 && pathname === area.href) { e.preventDefault(); toggle(); }   // clicar de novo no grupo aberto recolhe
                }}
                className={cn("flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-sm font-medium", rail && "flex-none justify-center")}
              >
                <Icon size={18} aria-hidden className="shrink-0" /> {!rail && <span className="truncate">{area.label}</span>}
              </Link>
              {!rail && area.items.length > 0 && (
                <button type="button" onClick={toggle} aria-expanded={isOpen} aria-label={`${isOpen ? "Recolher" : "Expandir"} ${area.label}`} className="mr-1 rounded p-1 hover:bg-black/5">
                  <ChevronDown size={15} className={cn("transition-transform", !isOpen && "-rotate-90")} />
                </button>
              )}
            </div>
            {isOpen && (
              <ul className="mt-1 mb-2 ml-9 space-y-0.5 border-l border-border pl-3">
                {area.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className={cn(
                        "flex items-center justify-between rounded-md px-2 py-1 text-sm",
                        pathname === item.href ? "text-brand font-medium" : "text-muted hover:text-text",
                      )}
                    >
                      {item.label}
                      {item.ready === false && <span className="text-[10px] uppercase text-muted/70">em breve</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => writeCollapsed(!rail)}
        className={cn("mt-auto hidden items-center gap-2 rounded-lg px-2 py-2 text-xs text-muted hover:bg-surface-2 hover:text-text lg:flex", rail && "justify-center")}
        aria-label={rail ? "Expandir a barra lateral" : "Recolher a barra lateral"}
        title={rail ? "Expandir a barra lateral" : "Recolher a barra lateral"}
      >
        {rail ? <PanelLeftOpen size={18} /> : <><PanelLeftClose size={18} /> Recolher</>}
      </button>
    </nav>
  );

  return (
    <>
      <button
        className="fixed top-3 left-3 z-40 rounded-lg border border-border bg-surface p-2 lg:hidden"
        onClick={() => setOpen(true)}
        aria-label="Abrir menu"
      >
        <Menu size={18} />
      </button>
      <aside className={cn("sticky top-0 hidden h-dvh shrink-0 border-r border-border bg-surface transition-[width] lg:block", collapsed ? "w-16" : "w-64")}>{render(collapsed)}</aside>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-surface shadow-xl">
            <button className="absolute top-3 right-3 p-2" onClick={() => setOpen(false)} aria-label="Fechar menu">
              <X size={18} />
            </button>
            {render(false)}
          </aside>
        </div>
      )}
    </>
  );
}
