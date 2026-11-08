"use client";
/**
 * Avisos da bipagem: som (Web Audio, sem arquivo) e vibração, diferentes para cada resultado — dá para conferir sem olhar a tela.
 * O AudioContext só pode nascer depois de um toque da pessoa (iPhone/Chrome): unlockAudio() vai no botão "Começar".
 */
import type { ScanStatus } from "./types";

let ctx: AudioContext | null = null;

export function unlockAudio() {
  try {
    if (!ctx) ctx = new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === "suspended") void ctx.resume();
  } catch { /* sem áudio: fica a vibração e o aviso na tela */ }
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = "sine", vol = 0.12) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  const t = ctx.currentTime + start;
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(ctx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

export type Cue = ScanStatus | "COMPLETE" | "DONE_ALL" | "ERROR";

export function cue(kind: Cue, muted = false) {
  const vib: Record<Cue, number[]> = {
    OK: [50], COMPLETE: [40, 40, 40], DONE_ALL: [60, 60, 60, 60, 120], PARTIAL_EXCESS: [150, 80, 150],
    EXCESS: [200, 80, 200], NOT_IN_NOTE: [300, 100, 300], UNKNOWN: [400], ERROR: [400],
  };
  try { navigator.vibrate?.(vib[kind]); } catch { /* sem vibração */ }
  if (muted || !ctx) return;
  switch (kind) {
    case "OK": tone(1500, 0, 0.09, "square", 0.06); break;                                  // bipe curto de caixa
    case "COMPLETE": tone(1300, 0, 0.08, "square", 0.06); tone(1900, 0.1, 0.12, "square", 0.06); break;   // item fechou
    case "DONE_ALL": [1046, 1318, 1568, 2093].forEach((f, i) => tone(f, i * 0.11, 0.14, "triangle", 0.14)); break;
    case "PARTIAL_EXCESS":
    case "EXCESS": tone(520, 0, 0.14, "sawtooth", 0.08); tone(520, 0.2, 0.14, "sawtooth", 0.08); break;    // sobra: dois graves
    case "NOT_IN_NOTE": tone(700, 0, 0.12, "triangle", 0.12); tone(440, 0.15, 0.25, "triangle", 0.12); break;
    case "UNKNOWN":
    case "ERROR": tone(180, 0, 0.35, "sawtooth", 0.1); break;                               // erro: zumbido
  }
}

/** Dígito verificador de EAN-8/EAN-13/UPC-A: descarta leitura torta da câmera antes de ir ao banco. */
export function validGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return true;            // não é GTIN (SKU, Code128): o banco decide
  const d = code.split("").map(Number);
  const check = d.pop()!;
  const sum = d.reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}
