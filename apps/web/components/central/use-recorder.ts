"use client";
import { useCallback, useRef, useState } from "react";

const MAX_SECONDS = 60;

/** Grava áudio do microfone (até 60 s). webm/opus no Chrome, mp4/aac no Safari: o Whisper aceita os dois. */
export function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const resolver = useRef<((b: Blob | null) => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const supported = typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported(t));
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timer.current) clearTimeout(timer.current);
        const blob = chunks.current.length ? new Blob(chunks.current, { type: r.mimeType || "audio/webm" }) : null;
        resolver.current?.(blob);
        resolver.current = null;
        setRecording(false);
      };
      rec.current = r;
      r.start();
      setRecording(true);
      timer.current = setTimeout(() => { if (r.state === "recording") r.stop(); }, MAX_SECONDS * 1000);
    } catch (e) {
      setError((e as Error).name === "NotAllowedError" ? "Permita o uso do microfone para falar com a Central." : "Não foi possível usar o microfone.");
    }
  }, []);

  const stop = useCallback(() => new Promise<Blob | null>((resolve) => {
    const r = rec.current;
    if (!r || r.state !== "recording") { resolve(null); return; }
    resolver.current = resolve;
    r.stop();
  }), []);

  return { supported, recording, error, start, stop };
}
