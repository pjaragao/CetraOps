"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  BadgeCheck, FileText, Landmark, LayoutDashboard, Megaphone, Menu, MessagesSquare, Settings, Shirt,
  ShoppingBag, Sparkles, Users, X,
} from "lucide-react";
import type { NavArea } from "@sie/domain";
import { cn } from "@/components/ui";

const ICONS = { BadgeCheck, FileText, Landmark, LayoutDashboard, Megaphone, MessagesSquare, Settings, Shirt, ShoppingBag, Sparkles, Users };

export function Sidebar({ nav }: { nav: NavArea[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const active = (href: string) => pathname === href || pathname.startsWith(href + "/");

  const content = (
    <nav aria-label="Menu principal" className="flex h-full flex-col gap-1 overflow-y-auto p-3">
      <Link href="/inicio" className="mb-4 px-2 pt-1" onClick={() => setOpen(false)}>
        <span className="block text-xs tracking-[0.3em] text-accent uppercase">SIÉ JOY</span>
        <span className="text-lg font-semibold">OS</span>
      </Link>
      {nav.map((area) => {
        const Icon = ICONS[area.icon as keyof typeof ICONS] ?? LayoutDashboard;
        const areaActive = active(area.href) || area.items.some((i) => active(i.href));
        return (
          <div key={area.key}>
            <Link
              href={area.href}
              onClick={() => setOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-2 py-2 text-sm font-medium",
                areaActive ? "bg-brand/10 text-brand" : "text-text hover:bg-surface-2",
              )}
            >
              <Icon size={18} aria-hidden /> {area.label}
            </Link>
            {areaActive && area.items.length > 0 && (
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
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-border bg-surface lg:block">{content}</aside>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-surface shadow-xl">
            <button className="absolute top-3 right-3 p-2" onClick={() => setOpen(false)} aria-label="Fechar menu">
              <X size={18} />
            </button>
            {content}
          </aside>
        </div>
      )}
    </>
  );
}
