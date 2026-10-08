"use client";
import { useRef, useState } from "react";
import { Sparkles } from "lucide-react";

export interface FinanceRead {
  label: string; checks: string[]; party: { id: string; label: string } | null; party_name: string | null; party_cnpj: string | null;
  fields: Record<string, string | number | null>;
}

/** Botão "Ler com IA": envia o PDF/foto e devolve os campos para preencher o formulário (a pessoa confere antes de salvar). */
export function AiReadButton({ purpose, onRead, label = "Preencher com IA (PDF ou foto)" }: {
  purpose: "titulo" | "recorrencia" | "emprestimo"; onRead: (r: FinanceRead) => void; label?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  async function send(file: File | undefined) {
    if (!file) return;
    setBusy(true); setMsg(null);
    try {
      const fd = new FormData(); fd.set("file", file); fd.set("para", purpose);
      const res = await fetch("/api/financeiro/ler", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Não consegui ler o arquivo");
      const doc = body.document as FinanceRead;
      onRead(doc);
      setMsg({ tone: "ok", text: `${doc.label}: campos preenchidos, confira antes de salvar.${doc.checks.length ? ` ${doc.checks.join(" ")}` : ""}` });
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input ref={ref} type="file" accept="application/pdf,image/*,.xml" className="hidden" aria-label="Arquivo para ler com IA" onChange={(e) => void send(e.target.files?.[0])} />
      <button type="button" disabled={busy} onClick={() => ref.current?.click()}
        className="inline-flex items-center gap-1.5 rounded-lg border border-brand/40 bg-brand/5 px-3 py-1.5 text-sm text-brand hover:bg-brand/10 disabled:opacity-60">
        <Sparkles size={14} /> {busy ? "Lendo…" : label}
      </button>
      {msg && <span className={`text-xs ${msg.tone === "ok" ? "text-success" : "text-danger"}`} role="status">{msg.text}</span>}
    </div>
  );
}
