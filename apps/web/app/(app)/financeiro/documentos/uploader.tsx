"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";

type Job = { key: string; name: string; state: "fila" | "lendo" | "ok" | "repetido" | "erro"; note?: string };
const PARALLEL = 2;          // a IA de leitura atende duas chamadas por vez
const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.xml,application/xml,text/xml";

/** Solta vários arquivos: cada um é lido e entra na fila abaixo (a lista atualiza a cada leitura). */
export function DocUploader() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [over, setOver] = useState(false);

  const set = (key: string, patch: Partial<Job>) => setJobs((all) => all.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  async function send(files: File[]) {
    const batch = files.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, file: f }));
    setJobs((all) => [...batch.map(({ key, name }) => ({ key, name, state: "fila" as const })), ...all].slice(0, 50));
    let next = 0;
    const worker = async () => {
      while (next < batch.length) {
        const { key, file } = batch[next++];
        set(key, { state: "lendo" });
        try {
          const body = new FormData();
          body.append("file", file);
          const res = await fetch("/api/documentos", { method: "POST", body });
          const out = (await res.json().catch(() => ({}))) as { error?: string; existing?: boolean; item?: { label: string; status: string } };
          if (!res.ok || !out.item) set(key, { state: "erro", note: out.error ?? `erro ${res.status}` });
          else set(key, out.existing ? { state: "repetido", note: `já estava na caixa (${out.item.status === "DONE" ? "lançado" : "na fila"})` } : { state: "ok", note: out.item.label });
        } catch {
          set(key, { state: "erro", note: "sem conexão" });
        }
        router.refresh();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, batch.length) }, worker));
  }

  return (
    <div className="space-y-3">
      <label
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = [...e.dataTransfer.files]; if (f.length) void send(f); }}
        className={cn("flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-border p-6 text-center text-sm", over && "border-brand bg-surface-2")}>
        <span className="font-medium">Solte aqui boletos, Pix, notas, cupons e XML de NF-e</span>
        <span className="text-muted">ou clique para escolher (foto, PDF ou XML, vários de uma vez, até 10 MB cada)</span>
        <input ref={input} type="file" multiple accept={ACCEPT} className="sr-only" aria-label="Escolher documentos"
          onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) void send(f); }} />
      </label>
      {jobs.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border text-sm" aria-label="Envios">
          {jobs.map((j) => (
            <li key={j.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
              <span className="truncate">{j.name}</span>
              <span className={cn("text-xs", j.state === "erro" ? "text-danger" : j.state === "ok" ? "text-success" : "text-muted")}>
                {j.state === "fila" ? "na fila" : j.state === "lendo" ? "lendo…" : j.note}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
