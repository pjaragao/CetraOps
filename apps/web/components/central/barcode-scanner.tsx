"use client";
import { useEffect, useRef, useState } from "react";
import { Camera, Check, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui";

/**
 * Câmera como leitor de código de barras, sem IA e sem rede: usa o BarcodeDetector do navegador (Chrome no Android, ChromeOS, macOS) e,
 * onde ele não existe (Safari/iPhone, parte dos desktops), o mesmo leitor em WebAssembly (pacote barcode-detector, carregado só nesse caso).
 * Lê EAN/UPC (produtos), Code 128 (DANFE, SKU), ITF (boleto) e QR (Pix, NFC-e, check-in).
 */
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code"];

interface Detector { detect(source: CanvasImageSource): Promise<{ rawValue: string; format: string }[]> }

export async function makeDetector(): Promise<Detector> {
  const native = (globalThis as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
  if (native) {
    try {
      const supported = await native.getSupportedFormats();
      if (supported.includes("ean_13")) return new native({ formats: FORMATS.filter((f) => supported.includes(f)) });
    } catch { /* cai para o leitor em WebAssembly */ }
  }
  const { BarcodeDetector } = await import("barcode-detector/ponyfill");
  return new BarcodeDetector({ formats: FORMATS as never }) as unknown as Detector;
}

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 1400; g.gain.value = 0.08;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.08);
    o.onended = () => ctx.close();
  } catch { /* sem áudio: segue só com a vibração */ }
  navigator.vibrate?.(60);
}

export interface ScannedCode { value: string; format: string }

export function BarcodeScanner({ onDone, onClose, single = false, title = "Bipar com a câmera" }: {
  onDone(codes: ScannedCode[]): void;
  onClose(): void;
  /** Uma leitura só (boleto, DANFE, Pix) em vez da leitura contínua (peças). */
  single?: boolean;
  title?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [codes, setCodes] = useState<ScannedCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const last = useRef<{ value: string; at: number }>({ value: "", at: 0 });
  const doneRef = useRef(onDone);
  useEffect(() => { doneRef.current = onDone; }, [onDone]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const detector = await makeDetector();
        setReady(true);
        timer = setInterval(async () => {
          if (!video.current || video.current.readyState < 2) return;
          try {
            const found = await detector.detect(video.current);
            const hit = found[0];
            if (!hit) return;
            const now = Date.now();
            if (hit.rawValue === last.current.value && now - last.current.at < 1500) return;   // o mesmo código parado na frente da câmera não conta duas vezes
            last.current = { value: hit.rawValue, at: now };
            beep();
            const code = { value: hit.rawValue.trim(), format: hit.format };
            if (single) { doneRef.current([code]); return; }
            setCodes((c) => [...c, code]);
          } catch { /* quadro ilegível: tenta no próximo */ }
        }, 250);
      } catch (e) {
        setError((e as Error).name === "NotAllowedError" ? "Permita o uso da câmera para bipar." : "Não foi possível abrir a câmera neste aparelho.");
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [single]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/90 text-white" role="dialog" aria-label={title}>
      <div className="flex items-center justify-between p-3">
        <p className="flex items-center gap-2 text-sm font-medium"><Camera size={16} /> {title}</p>
        <button onClick={onClose} className="rounded-lg p-2 hover:bg-white/10" aria-label="Fechar câmera"><X size={18} /></button>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <video ref={video} className="h-full w-full object-cover" playsInline muted />
        <div className="pointer-events-none absolute inset-x-8 top-1/2 h-28 -translate-y-1/2 rounded-xl border-2 border-white/80" />
        {!ready && !error && <p className="absolute inset-x-0 top-1/2 text-center text-sm">Abrindo a câmera…</p>}
        {error && <p className="absolute inset-x-4 top-1/2 rounded-lg bg-black/70 p-3 text-center text-sm">{error}</p>}
      </div>
      {!single && (
        <div className="space-y-2 bg-black p-3">
          <p className="text-sm">{codes.length === 0 ? "Aponte para o código de barras da etiqueta." : `${codes.length} leitura(s) · última: ${codes[codes.length - 1].value}`}</p>
          <div className="flex gap-2">
            <Button variant="secondary" className="text-text" disabled={codes.length === 0} onClick={() => setCodes((c) => c.slice(0, -1))}><Undo2 size={15} /> Desfazer última</Button>
            <Button className="flex-1" disabled={codes.length === 0} onClick={() => onDone(codes)}><Check size={15} /> Concluir ({codes.length})</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "789…(2x), 123…" — agrupa leituras repetidas da mesma peça. */
export function summarizeCodes(codes: ScannedCode[]): string {
  const count = new Map<string, number>();
  codes.forEach((c) => count.set(c.value, (count.get(c.value) ?? 0) + 1));
  return [...count.entries()].map(([v, n]) => (n > 1 ? `${v} (${n}x)` : v)).join(", ");
}
