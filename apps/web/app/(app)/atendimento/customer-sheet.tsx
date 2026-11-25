"use client";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/components/ui";

/** Cartão do cliente (dados, carrinho e "Para ela agora"). Em tela larga (xl) fica ao lado da conversa; em telas menores abre
 *  como gaveta ao tocar no nome do cliente no cabeçalho da conversa (evento "customer-sheet:open"). */
export function CustomerSheet({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("customer-sheet:open", show);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("customer-sheet:open", show); window.removeEventListener("keydown", onKey); };
  }, []);
  return (
    <div className={cn(open ? "fixed inset-0 z-50 flex justify-end bg-black/50 xl:static xl:z-auto xl:block xl:bg-transparent" : "hidden xl:block")}
      onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <aside role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-label="Cliente"
        className={cn("space-y-3 overflow-y-auto bg-surface p-4 text-sm xl:rounded-xl xl:border xl:border-border",
          open && "h-full w-[min(92vw,360px)] pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl xl:h-auto xl:w-auto xl:shadow-none")}>
        <button type="button" onClick={() => setOpen(false)} className="float-right rounded-full p-1 text-muted hover:bg-surface-2 xl:hidden" aria-label="Fechar"><X size={18} /></button>
        {children}
      </aside>
    </div>
  );
}
