"use client";
import { useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui";

/** Copia um texto para a área de transferência (para colar no app oficial). Mostra "Copiado" por 2 s. */
export function CopyButton({ text, label = "Copiar" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button type="button" variant="secondary" className="px-2 py-1 text-xs" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 2000); } catch { setDone(false); }
    }}>
      <Copy size={13} aria-hidden /> {done ? "Copiado" : label}
    </Button>
  );
}
