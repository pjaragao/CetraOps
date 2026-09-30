"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/** Recarrega os dados da página algumas vezes (o worker responde em segundos). O contador vive numa ref: mesmo que o efeito reinicie, nunca passa de `times`. */
export function AutoRefresh({ every = 3000, times = 8 }: { every?: number; times?: number }) {
  const router = useRouter();
  const done = useRef(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (done.current >= times) { clearInterval(id); return; }
      done.current += 1;
      router.refresh();
    }, every);
    return () => clearInterval(id);
  }, [router, every, times]);
  return null;
}
