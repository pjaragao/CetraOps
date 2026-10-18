"use client";

import { useEffect, useState, useTransition } from "react";
import { KeyRound, RefreshCw, ShieldOff, Tablet } from "lucide-react";
import { Badge, Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { createPairingCodeAction, listPosDevicesAction, revokePosDeviceAction, type PosDeviceRow } from "./pos-devices-actions";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "—");

/**
 * App do PDV instalado na própria maquininha (Deeplink da Stone): o sócio gera um código, digita no app e a maquininha fica ligada à loja.
 * Só uma maquininha pareada consegue confirmar pagamento feito no terminal.
 */
export function PosDevicesPanel() {
  const [devices, setDevices] = useState<PosDeviceRow[]>([]);
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [storeId, setStoreId] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState<{ code: string; expiresAt: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = () => startTransition(async () => {
    const r = await listPosDevicesAction();
    if (!r.ok) { setError(r.error); return; }
    setDevices(r.devices);
    setStores(r.stores);
    setStoreId((cur) => cur || r.defaultStoreId || r.stores[0]?.id || "");
  });
  useEffect(load, []);

  const pair = (device?: PosDeviceRow) => {
    setError(null);
    const n = device?.name ?? name.trim();
    if (!n) { setError("Dê um nome para a maquininha (ex.: Caixa 1)."); return; }
    startTransition(async () => {
      const r = await createPairingCodeAction({ storeId: device?.store_id ?? storeId, name: n, deviceId: device?.id });
      if (!r.ok) { setError(r.error); return; }
      setCode({ code: r.code, expiresAt: r.expiresAt, name: n });
      setName("");
      const l = await listPosDevicesAction();
      if (l.ok) setDevices(l.devices);
    });
  };

  const revoke = (d: PosDeviceRow) => {
    if (!confirm(`Desativar "${d.name}"? O app nessa maquininha deixa de vender até ser pareado de novo.`)) return;
    startTransition(async () => {
      const r = await revokePosDeviceAction(d.id);
      if (!r.ok) setError(r.error);
      const l = await listPosDevicesAction();
      if (l.ok) setDevices(l.devices);
    });
  };

  return (
    <div className="mt-5 rounded-xl border border-border p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><Tablet size={16} className="text-brand" /> App do PDV na maquininha</p>
        <button type="button" onClick={load} disabled={pending} className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-text" title="Atualizar">
          <RefreshCw size={14} className={pending ? "animate-spin" : undefined} />
        </button>
      </div>
      <p className="mb-3 text-xs text-muted">
        Vende direto no terminal: lê o código de barras pela câmera, cobra no app de pagamento da Stone e imprime o cupom e a NFC-e.
        Gere o código, abra o app na maquininha e digite-o em até 15 minutos.
      </p>

      {error && <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

      {code && (
        <div className="mb-3 rounded-xl border border-brand/40 bg-brand/5 p-3 text-center">
          <p className="text-xs text-muted">Código para “{code.name}” — vale até {when(code.expiresAt)}</p>
          <p className="mt-1 font-mono text-2xl font-bold tracking-widest text-text">{code.code}</p>
          <p className="mt-1 text-[11px] text-muted">Aparece só agora. Se vencer, gere outro.</p>
        </div>
      )}

      <div className="mb-3 space-y-2">
        {devices.length === 0 && <p className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted">Nenhuma maquininha com o app ainda.</p>}
        {devices.map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-2/40 p-2.5">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium">
                <span className="truncate">{d.name}</span>
                {d.revoked ? <Badge tone="danger">Desativada</Badge> : d.paired ? <Badge tone="success">Pareada</Badge> : d.pairing_pending ? <Badge tone="warning">Aguardando código</Badge> : <Badge>Código vencido</Badge>}
              </p>
              <p className="truncate text-xs text-muted">
                {d.store_name}{d.serial ? ` · série ${d.serial}` : ""}{d.model ? ` · ${d.model}` : ""}{d.app_version ? ` · app ${d.app_version}` : ""} · último contato {when(d.last_seen_at)}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button type="button" variant="ghost" onClick={() => pair(d)} disabled={pending} className="px-2 py-1 text-xs" title="Gerar novo código (troca de aparelho ou app reinstalado)">
                <KeyRound size={14} className="mr-1" /> Novo código
              </Button>
              {!d.revoked && (
                <button type="button" onClick={() => revoke(d)} disabled={pending} className="rounded-lg p-1.5 text-muted hover:bg-danger/10 hover:text-danger" title="Desativar">
                  <ShieldOff size={15} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Loja">
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={inputClass} disabled={pending}>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Nome da maquininha">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Caixa 1" className={inputClass} disabled={pending} maxLength={60} />
        </Field>
        <Button type="button" onClick={() => pair()} disabled={pending || !storeId} className="px-3 py-2 text-xs">Gerar código</Button>
      </div>
    </div>
  );
}
