"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Recarrega os dados da página algumas vezes (o worker responde em segundos): para depois de `times` tentativas. */
export function AutoRefresh({ every = 3000, times = 8 }: { every?: number; times?: number }) {
  const router = useRouter();
  useEffect(() => {
    let n = 0;
    const id = setInterval(() => { router.refresh(); if (++n >= times) clearInterval(id); }, every);
    return () => clearInterval(id);
  }, [router, every, times]);
  return null;
}
