"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Copy, MessageCircle, Smartphone, X } from "lucide-react";
import { Button, cn, inputClass } from "@/components/ui";
import { createScanLinkAction, revokeScanLinkAction } from "./actions";
import type { ScanLink } from "./types";

/** Pessoa da equipe com WhatsApp cadastrado (para mandar o link). */
export interface TeamPhone { name: string; phone: string }

const digitsOf = (p: string) => p.replace(/\D/g, "");
const waNumber = (p: string) => { const d = digitsOf(p); return d.length <= 11 ? `55${d}` : d; };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/**
 * Modo assistido: gera um link temporário desta nota e manda para o celular da pessoa pelo WhatsApp (ou mostra o QR).
 * O celular, apoiado ao lado do computador, vira o leitor; as leituras aparecem nesta tela.
 */
export function AssistPanel({ receiptId, receiptLabel, team, links, onLinks, onClose }: {
  receiptId: string; receiptLabel: string; team: TeamPhone[]; links: ScanLink[]; onLinks(l: ScanLink[]): void; onClose(): void;
}) {
  const [who, setWho] = useState<TeamPhone | null>(team[0] ?? null);
  const [phone, setPhone] = useState(team[0]?.phone ?? "");
  const [hours, setHours] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; url: string; expires_at: string; qr: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const message = (url: string, exp: string) =>
    `Link para bipar a entrada da ${receiptLabel} pelo celular (válido até ${hhmm(exp)}):\n${url}\n\nAbra no celular, toque em "Começar a bipar" e deixe o celular apoiado ao lado do computador.`;

  const generate = async () => {
    setBusy(true); setError(null);
    const out = await createScanLinkAction(receiptId, who?.name ?? (digitsOf(phone) ? `WhatsApp ${phone}` : "Celular"), hours);
    setBusy(false);
    if (!out.ok) { setError(out.error); return null; }
    const url = `${window.location.origin}/bipar/${out.data.token}`;
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: "M" }).catch(() => null);
    const m = { id: out.data.id, url, expires_at: out.data.expires_at, qr };
    setMade(m);
    onLinks([...links, { id: out.data.id, label: who?.name ?? null, expires_at: out.data.expires_at, last_seen_at: null, online: false }]);
    return m;
  };

  const sendWhatsApp = async () => {
    const d = digitsOf(phone);
    if (d.length < 10) { setError("Informe o WhatsApp com DDD"); return; }
    // abre a janela já no clique (o navegador bloqueia janela aberta depois de esperar o servidor)
    const win = window.open("about:blank", "_blank");
    const m = made ?? (await generate());
    if (!m) { win?.close(); return; }
    const href = `https://wa.me/${waNumber(d)}?text=${encodeURIComponent(message(m.url, m.expires_at))}`;
    if (win) win.location.href = href; else window.location.href = href;
  };

  const copy = async () => {
    if (!made) return;
    try { await navigator.clipboard.writeText(made.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setError("Não foi possível copiar: selecione o link e copie à mão"); }
  };

  const revoke = async (id: string | null) => {
    const out = await revokeScanLinkAction(receiptId, id);
    if (!out.ok) { setError(out.error); return; }
    onLinks(id ? links.filter((l) => l.id !== id) : []);
    if (!id || made?.id === id) setMade(null);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="assist-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-xl">
        <div className="mb-3 flex items-start gap-2">
          <Smartphone size={20} className="mt-0.5 text-brand" />
          <div className="min-w-0 flex-1">
            <h2 id="assist-title" className="font-semibold">Usar o celular como leitor</h2>
            <p className="text-xs text-muted">O celular abre o link sem entrar no sistema e bipa esta nota. Cada leitura aparece aqui no computador, com som.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-surface-2" aria-label="Fechar"><X size={18} /></button>
        </div>

        {!made ? (
          <div className="space-y-3">
            {team.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted">Mandar para</p>
                <div className="flex flex-wrap gap-1.5">
                  {team.map((t) => (
                    <button key={t.phone} type="button" onClick={() => { setWho(t); setPhone(t.phone); }}
                      className={cn("rounded-full border px-3 py-1 text-sm", who?.phone === t.phone ? "border-brand bg-brand/10 text-brand" : "border-border")}>
                      {t.name.split(" ")[0]}
                    </button>
                  ))}
                  <button type="button" onClick={() => { setWho(null); setPhone(""); }} className={cn("rounded-full border px-3 py-1 text-sm", !who ? "border-brand bg-brand/10 text-brand" : "border-border")}>Outro número</button>
                </div>
              </div>
            )}
            <label className="block text-xs font-medium text-muted">WhatsApp
              <input value={phone} onChange={(e) => { setPhone(e.target.value); setWho(null); }} className={cn(inputClass, "mt-1")} placeholder="(48) 99999-9999" inputMode="tel" />
            </label>
            <label className="block text-xs font-medium text-muted">Validade do link
              <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className={cn(inputClass, "mt-1")}>
                {[2, 4, 8, 12].map((h) => <option key={h} value={h}>{h} horas</option>)}
              </select>
            </label>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button type="button" onClick={sendWhatsApp} disabled={busy}><MessageCircle size={16} /> Gerar e mandar pelo WhatsApp</Button>
              <Button type="button" variant="secondary" onClick={() => void generate()} disabled={busy}>Só gerar (QR)</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {made.qr && <img src={made.qr} alt="QR do link para o celular" className="h-40 w-40 rounded-lg bg-white p-1.5" />}
              <div className="min-w-0 flex-1 space-y-2 text-sm">
                <p>Aponte a câmera do celular para o QR <span className="text-muted">ou</span> mande o link pelo WhatsApp.</p>
                <p className="text-xs text-muted">Válido até {hhmm(made.expires_at)}. Encerre quando terminar.</p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={sendWhatsApp}><MessageCircle size={16} /> WhatsApp</Button>
                  <Button type="button" variant="secondary" onClick={copy}><Copy size={16} /> {copied ? "Copiado!" : "Copiar link"}</Button>
                </div>
              </div>
            </div>
            <Button type="button" variant="ghost" className="text-xs" onClick={() => setMade(null)}>Gerar outro link</Button>
          </div>
        )}

        {error && <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        {links.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-xs font-medium text-muted">Links ativos desta nota</p>
              {links.length > 1 && <button type="button" onClick={() => revoke(null)} className="text-xs text-danger">Encerrar todos</button>}
            </div>
            <ul className="space-y-1">
              {links.map((l) => {
                const on = l.online;
                return (
                  <li key={l.id} className="flex items-center gap-2 text-sm">
                    <span className={cn("h-2 w-2 shrink-0 rounded-full", on ? "bg-success" : "bg-muted/50")} />
                    <span className="min-w-0 flex-1 truncate">{l.label ?? "Celular"} <span className="text-xs text-muted">· {on ? "ligado agora" : l.last_seen_at ? `visto às ${hhmm(l.last_seen_at)}` : "ainda não abriu"} · até {hhmm(l.expires_at)}</span></span>
                    <button type="button" onClick={() => revoke(l.id)} className="text-xs text-danger">Encerrar</button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
