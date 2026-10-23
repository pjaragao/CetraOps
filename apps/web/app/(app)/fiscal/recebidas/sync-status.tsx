"use client";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** Status da busca na SEFAZ: enquanto há pedido em andamento recarrega os dados a cada poucos segundos e, ao terminar, mostra a hora da última atualização e limpa a URL. */
export function SyncStatus({ active, updatedAt, every = 3000, times = 10 }: { active: boolean; updatedAt: string | null; every?: number; times?: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const [busy, setBusy] = useState(active);
  const [wasActive, setWasActive] = useState(active);
  const done = useRef(0);

  // novo pedido de busca (active voltou a true): recomeça a acompanhar, ajustando o estado na própria renderização
  if (active !== wasActive) { setWasActive(active); if (active) setBusy(true); }

  useEffect(() => {
    if (!busy) return;
    done.current = 0;
    const id = setInterval(() => {
      done.current += 1;
      if (done.current > times) { clearInterval(id); setBusy(false); router.replace(pathname); return; }
      router.refresh();
    }, every);
    return () => clearInterval(id);
  }, [busy, router, pathname, every, times]);

  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted">
      <span className={`h-2 w-2 rounded-full ${busy ? "animate-pulse bg-warning" : "bg-success"}`} />
      {busy ? "Buscando na SEFAZ…" : updatedAt ? `Atualizado às ${updatedAt}` : "Aguardando a primeira busca"}
    </span>
  );
}
