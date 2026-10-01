"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

/** Assina mudanças em conversas, mensagens e rascunhos (RLS aplicado no Realtime) e atualiza a tela. */
export function RealtimeRefresh({ conversationId }: { conversationId?: string }) {
  const router = useRouter();
  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => router.refresh(), 250); };
    const channel = supabase
      .channel("inbox")
      .on("postgres_changes", { event: "*", schema: "omni", table: "conversations" }, refresh)
      .on("postgres_changes", { event: "*", schema: "omni", table: "messages", ...(conversationId ? { filter: `conversation_id=eq.${conversationId}` } : {}) }, refresh)
      .on("postgres_changes", { event: "*", schema: "omni", table: "message_drafts" }, refresh)
      .subscribe();
    return () => { clearTimeout(timer); supabase.removeChannel(channel); };
  }, [router, conversationId]);
  return null;
}
