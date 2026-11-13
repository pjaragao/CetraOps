"use client";
import { useEffect, useRef, useState } from "react";
import { Flashlight, FlashlightOff, Maximize2, Minimize2, SwitchCamera } from "lucide-react";
import { makeDetector } from "@/components/central/barcode-scanner";
import { cn } from "@/components/ui";
import { validGtin } from "./feedback";

/**
 * Câmera pequena que fica lendo o tempo todo (BarcodeDetector nativo ou o mesmo leitor em WebAssembly).
 * Regra contra leitura dupla: o mesmo código só conta de novo depois de SAIR do quadro (tirar a peça e passar a próxima);
 * código diferente conta na hora. Assim, segurar a etiqueta parada não soma peças a mais.
 */
export function MiniCamera({ active, onCode, flash }: { active: boolean; onCode(code: string): void; flash: "ok" | "warn" | "err" | null }) {
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<MediaStreamTrack | null>(null);
  const [state, setState] = useState<"starting" | "on" | "error">("starting");
  const [error, setError] = useState("");
  const [big, setBig] = useState(false);
  const [torch, setTorch] = useState<boolean | null>(null);           // null = aparelho sem lanterna
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [hasMany, setHasMany] = useState(false);
  const onCodeRef = useRef(onCode);
  useEffect(() => { onCodeRef.current = onCode; }, [onCode]);

  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Cada código tem um estado: quando foi visto pela última vez e quantos quadros seguidos ficou fora da imagem.
    // Só conta de novo depois de SAIR do quadro (≥ 2 quadros e ≥ 0,5 s sem aparecer). Não depende do tempo entre quadros: num aparelho lento
    // (quadro a cada 1 s) ou que travou, a etiqueta parada na frente da câmera continua sendo a mesma leitura.
    const state = new Map<string, { lastSeen: number; absent: number }>();
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(), { name: "NoMedia" });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (stopped || !video.current) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.current.srcObject = stream;
        await video.current.play().catch(() => undefined);
        const t = stream.getVideoTracks()[0];
        track.current = t;
        const caps = (t.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] };
        setTorch(caps.torch ? false : null);
        if (caps.focusMode?.includes("continuous")) t.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => undefined);
        navigator.mediaDevices.enumerateDevices().then((d) => setHasMany(d.filter((x) => x.kind === "videoinput").length > 1)).catch(() => undefined);
        const detector = await makeDetector();
        if (stopped) return;
        setState("on");
        const loop = async () => {
          if (stopped) return;
          const v = video.current;
          if (v && v.readyState >= 2 && !document.hidden) {
            try {
              const found = await detector.detect(v);
              const now = Date.now();
              const present = new Set<string>();
              for (const hit of found) {
                const code = hit.rawValue.trim();
                if (!code || ((hit.format.startsWith("ean") || hit.format.startsWith("upc")) && !validGtin(code))) continue;
                present.add(code);
              }
              for (const code of present) {
                const st = state.get(code);
                // conta se é novo ou se SAIU do quadro (≥ 2 quadros e ≥ 0,5 s fora). Etiqueta parada na frente não conta de novo, nem em aparelho lento
                if (st === undefined || (st.absent >= 2 && now - st.lastSeen >= 500)) onCodeRef.current(code);
                state.set(code, { lastSeen: now, absent: 0 });
              }
              for (const [code, st] of state) if (!present.has(code)) st.absent += 1;
            } catch { /* quadro ilegível: segue */ }
          }
          timer = setTimeout(loop, 120);
        };
        void loop();
      } catch (e) {
        const n = (e as Error).name;
        setError(n === "NotAllowedError" ? "Libere a câmera nas permissões do navegador." : n === "NoMedia" ? "Câmera indisponível: abra o sistema em https ou use o campo de código." : "Não foi possível abrir a câmera.");
        setState("error");
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      track.current = null;
      setState("starting");                                               // próxima abertura (retomar, trocar de câmera)
    };
  }, [active, facing]);

  const toggleTorch = async () => {
    if (torch === null || !track.current) return;
    try { await track.current.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] }); setTorch(!torch); } catch { setTorch(null); }
  };

  return (
    <div className={cn("relative shrink-0 overflow-hidden rounded-xl bg-black transition-all", big ? "h-56 w-full" : "h-28 w-36 sm:h-32 sm:w-44",
      flash === "ok" && "ring-4 ring-success", flash === "warn" && "ring-4 ring-warning", flash === "err" && "ring-4 ring-danger")}>
      <video ref={video} className="h-full w-full object-cover" playsInline muted aria-label="Imagem da câmera" />
      {active && state === "on" && <div className="scan-line pointer-events-none absolute inset-x-2 h-0.5 rounded bg-danger/80 shadow-[0_0_8px_2px] shadow-danger/60" />}
      {!active && <p className="absolute inset-0 grid place-items-center text-center text-xs text-white/80">Câmera pausada</p>}
      {active && state === "starting" && <p className="absolute inset-0 grid place-items-center text-xs text-white/80">Abrindo…</p>}
      {state === "error" && <p className="absolute inset-0 grid place-items-center p-2 text-center text-[11px] leading-tight text-white">{error}</p>}
      <div className="absolute bottom-1 right-1 flex gap-1">
        {torch !== null && active && <button type="button" onClick={toggleTorch} className="rounded-md bg-black/60 p-1.5 text-white" aria-label={torch ? "Desligar lanterna" : "Ligar lanterna"}>{torch ? <FlashlightOff size={14} /> : <Flashlight size={14} />}</button>}
        {hasMany && active && <button type="button" onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))} className="rounded-md bg-black/60 p-1.5 text-white" aria-label="Trocar câmera"><SwitchCamera size={14} /></button>}
        <button type="button" onClick={() => setBig((b) => !b)} className="rounded-md bg-black/60 p-1.5 text-white" aria-label={big ? "Diminuir câmera" : "Aumentar câmera"}>{big ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
      </div>
    </div>
  );
}
