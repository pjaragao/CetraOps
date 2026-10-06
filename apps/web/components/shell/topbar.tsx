"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { LogOut, Plus, Search, Sparkles } from "lucide-react";
import { ASSISTANT_NAME, PERIODS } from "@centralops/domain";
import { setStoreContext } from "@/app/(app)/actions";
import { signOut } from "@/app/login/actions";
import { NotificationBell } from "./notification-bell";

interface Props {
  name: string;
  memberId: string;
  unreadNotifications: number;
  stores: { id: string; name: string }[];
  storeId: string | null;
  canAllStores: boolean;
  central?: boolean;
}

export function Topbar({ name, memberId, unreadNotifications, stores, storeId, canAllStores, central = false }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const setPeriod = (p: string) => {
    const next = new URLSearchParams(params);
    next.set("periodo", p);
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <header className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-border bg-bg/90 px-4 py-2 pl-16 backdrop-blur lg:pl-4">
      <label className="sr-only" htmlFor="ctx-store">Loja</label>
      <select
        id="ctx-store"
        value={storeId ?? "ALL"}
        disabled={pending}
        onChange={(e) => start(async () => { await setStoreContext(e.target.value); router.refresh(); })}
        className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
      >
        {canAllStores && <option value="ALL">Todas as lojas</option>}
        {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>

      <label className="sr-only" htmlFor="ctx-period">Período</label>
      <select
        id="ctx-period"
        value={params.get("periodo") ?? "mes"}
        onChange={(e) => setPeriod(e.target.value)}
        className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
      >
        {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>

      <button
        onClick={() => window.dispatchEvent(new CustomEvent("centralops:palette"))}
        className="ml-auto flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-muted hover:text-text"
      >
        <Search size={15} /> <span className="hidden sm:inline">Buscar ou executar…</span>
        <kbd className="hidden rounded border border-border px-1 text-[10px] sm:inline">Ctrl K</kbd>
      </button>
      {central && !pathname.startsWith("/central") && (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent("centralops:central"))}
          className="flex items-center gap-1 rounded-lg border border-brand/40 bg-surface px-3 py-1.5 text-sm font-medium text-brand hover:bg-surface-2"
          aria-label={`Abrir a ${ASSISTANT_NAME} (Ctrl+/)`}
          title={`${ASSISTANT_NAME} — Ctrl+/`}
        >
          <Sparkles size={15} /> <span className="hidden sm:inline">{ASSISTANT_NAME}</span>
        </button>
      )}
      <button
        onClick={() => router.push("/vender/pdv")}
        className="flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-contrast"
      >
        <Plus size={15} /> <span className="hidden sm:inline">Nova venda</span>
      </button>
      <NotificationBell memberId={memberId} initialUnread={unreadNotifications} />
      <Link href="/conta" className="hidden text-sm text-muted hover:underline md:inline" title="Minha conta: trocar a senha">{name}</Link>
      <form action={signOut}>
        <button className="rounded-lg p-2 text-muted hover:bg-surface-2" aria-label="Sair" title="Sair"><LogOut size={16} /></button>
      </form>
    </header>
  );
}
