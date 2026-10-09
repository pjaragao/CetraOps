"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { CheckCircle2, CreditCard, Loader2, Smartphone, XCircle } from "lucide-react";
import { formatBRL } from "@centralops/domain";
import { Badge, Button, cn, inputClass } from "@/components/ui";
import {
  cancelStonePosOrderAction,
  checkStonePosPaymentAction,
  getStoneConfigAction,
  sendToStonePosAction,
} from "./stone-actions";

interface StonePosDialogProps {
  open: boolean;
  onClose: () => void;
  amount: number;
  orderId?: string;
  orderNumber?: string;
  initialMethod?: "CREDIT" | "DEBIT" | "PIX";
  initialInstallments?: number;
  customerName?: string;
  customerDoc?: string;
  onPaymentConfirmed?: (res: {
    nsu: string;
    authCode?: string;
    cardBrand?: string;
    method: "CREDIT" | "DEBIT" | "PIX";
    amount: number;
    installments: number;
  }) => void;
}

export function StonePosDialog(props: StonePosDialogProps) {
  if (!props.open) return null;
  return <StonePosModalInner {...props} />;
}

function StonePosModalInner({
  onClose,
  amount,
  orderId,
  orderNumber,
  initialMethod = "CREDIT",
  initialInstallments = 1,
  customerName,
  customerDoc,
  onPaymentConfirmed,
}: StonePosDialogProps) {
  const [method, setMethod] = useState<"CREDIT" | "DEBIT" | "PIX">(initialMethod);
  const [installments, setInstallments] = useState(initialInstallments);
  const [terminalSerial, setTerminalSerial] = useState("");
  const [hasIntegration, setHasIntegration] = useState<boolean | null>(null);

  // Estados do envio
  const [stoneOrderId, setStoneOrderId] = useState<string | null>(null);
  const [status, setStatus] = useState<"IDLE" | "SENDING" | "WAITING_PAYMENT" | "PAID" | "CANCELED" | "ERROR">("IDLE");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [paidInfo, setPaidInfo] = useState<{ nsu?: string; brand?: string; authCode?: string } | null>(null);

  const [pending, startTransition] = useTransition();
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // Carrega configuração e serial padrão ao abrir
  useEffect(() => {
    let active = true;
    getStoneConfigAction().then((cfg) => {
      if (!active) return;
      setHasIntegration(cfg.hasIntegration);
      if (cfg.defaultSerialNumber) {
        setTerminalSerial((prev) => prev || cfg.defaultSerialNumber || "");
      }
    });
    return () => {
      active = false;
    };
  }, []);

  // Polling a cada 2.5s enquanto estiver aguardando na maquininha
  useEffect(() => {
    if (status !== "WAITING_PAYMENT" || !stoneOrderId) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    const check = async () => {
      const res = await checkStonePosPaymentAction(stoneOrderId, orderId);
      if (res.ok && res.paid) {
        setStatus("PAID");
        setPaidInfo({ nsu: res.nsu, brand: res.cardBrand, authCode: res.authCode });
        if (pollRef.current) clearInterval(pollRef.current);
        if (onPaymentConfirmed) {
          onPaymentConfirmed({
            nsu: res.nsu || "STONE-PAID",
            authCode: res.authCode,
            cardBrand: res.cardBrand,
            method,
            amount,
            installments,
          });
        }
      } else if (res.ok && res.canceled) {
        setStatus("CANCELED");
        if (pollRef.current) clearInterval(pollRef.current);
      }
    };

    pollRef.current = setInterval(check, 2500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status, stoneOrderId, orderId, method, amount, installments, onPaymentConfirmed]);

  const handleSend = () => {
    setErrorMsg(null);
    setStatus("SENDING");
    startTransition(async () => {
      const res = await sendToStonePosAction({
        orderId,
        orderNumber,
        amount,
        method,
        installments,
        terminalSerial,
        customerName,
        customerDoc,
      });

      if (!res.ok) {
        setStatus("ERROR");
        setErrorMsg(res.error || "Erro ao conectar com a maquininha Stone");
        return;
      }

      setStoneOrderId(res.stoneOrderId);
      setStatus("WAITING_PAYMENT");
    });
  };

  const handleCancel = async () => {
    if (stoneOrderId) {
      await cancelStonePosOrderAction(stoneOrderId);
    }
    if (pollRef.current) clearInterval(pollRef.current);
    setStatus("CANCELED");
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm animate-in fade-in"
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 text-brand font-bold text-sm">
              <Smartphone size={20} />
            </div>
            <div>
              <h2 className="text-base font-semibold">Maquininha Stone</h2>
              <p className="text-xs text-muted">Smart POS presencial (Connect 2.0)</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-text"
            aria-label="Fechar"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 space-y-4">
          {hasIntegration === false && (
            <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
              <p className="font-semibold">Integração Stone não configurada</p>
              <p className="mt-0.5">
                Para enviar cobranças automaticamente para o POS, acesse Configurações › Integrações e informe sua chave da Stone.
              </p>
            </div>
          )}

          {status === "IDLE" && (
            <>
              <div className="rounded-xl bg-surface-2 p-3 text-center">
                <span className="text-xs uppercase tracking-wider text-muted font-medium">Valor da cobrança</span>
                <p className="text-2xl font-bold tracking-tight text-brand">{formatBRL(amount)}</p>
                {orderNumber && <p className="text-xs text-muted mt-0.5">Pedido #{orderNumber}</p>}
              </div>

              <div className="grid grid-cols-3 gap-2">
                {(["CREDIT", "DEBIT", "PIX"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMethod(m)}
                    className={cn(
                      "rounded-xl border p-2.5 text-center text-xs font-medium transition-all",
                      method === m
                        ? "border-brand bg-brand/10 text-brand shadow-sm font-semibold"
                        : "border-border hover:border-brand/40 hover:bg-surface-2",
                    )}
                  >
                    {m === "CREDIT" ? "Crédito" : m === "DEBIT" ? "Débito" : "Pix"}
                  </button>
                ))}
              </div>

              {method === "CREDIT" && (
                <div>
                  <label className="text-xs font-medium text-muted mb-1 block">Parcelamento</label>
                  <select
                    value={installments}
                    onChange={(e) => setInstallments(Number(e.target.value))}
                    className={inputClass}
                  >
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}x de {formatBRL(amount / n)} {n === 1 ? "(à vista)" : "sem juros"}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="text-xs font-medium text-muted mb-1 block">
                  Serial da maquininha (traseira do POS)
                </label>
                <input
                  value={terminalSerial}
                  onChange={(e) => setTerminalSerial(e.target.value)}
                  placeholder="Ex: ST-88492019 ou 123456789"
                  className={inputClass}
                />
                <p className="mt-1 text-[11px] text-muted">
                  A maquininha Stone Smart POS deve estar ligada e conectada ao Wi-Fi ou 4G.
                </p>
              </div>

              {errorMsg && (
                <div className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
                  {errorMsg}
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button variant="secondary" onClick={onClose} className="flex-1">
                  Cancelar
                </Button>
                <Button
                  onClick={handleSend}
                  disabled={pending || !terminalSerial.trim()}
                  className="flex-1"
                >
                  {pending ? "Enviando…" : "Enviar para Maquininha"}
                </Button>
              </div>
            </>
          )}

          {status === "SENDING" && (
            <div className="py-8 text-center space-y-3">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-brand" />
              <p className="text-sm font-medium">Enviando cobrança para a Stone…</p>
              <p className="text-xs text-muted">Aguarde a maquininha responder.</p>
            </div>
          )}

          {status === "WAITING_PAYMENT" && (
            <div className="py-6 text-center space-y-4">
              <div className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-brand/10 text-brand">
                <CreditCard className="h-8 w-8 animate-pulse" />
                <span className="absolute -top-1 -right-1 flex h-4 w-4">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-4 w-4 bg-brand"></span>
                </span>
              </div>

              <div>
                <p className="text-base font-semibold text-text">Aguardando cliente no POS</p>
                <p className="text-xs text-muted mt-1">
                  Terminal: <b className="font-mono text-text">{terminalSerial}</b> · Valor:{" "}
                  <b className="text-brand">{formatBRL(amount)}</b>
                  {method === "CREDIT" && ` (${installments}x)`}
                </p>
                <p className="mt-2 text-xs text-muted">
                  Peça para a cliente aproximar ou inserir o cartão na maquininha Stone.
                </p>
              </div>

              <div className="flex justify-center gap-2">
                <Badge tone="warning">Aguardando aprovação…</Badge>
              </div>

              <div className="pt-2">
                <Button variant="ghost" onClick={handleCancel} className="text-xs text-danger">
                  Cancelar cobrança no terminal
                </Button>
              </div>
            </div>
          )}

          {status === "PAID" && (
            <div className="py-6 text-center space-y-3">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-success/10 text-success">
                <CheckCircle2 className="h-8 w-8" />
              </div>
              <p className="text-base font-semibold text-success">Pagamento Confirmado!</p>
              <div className="rounded-xl bg-surface-2 p-3 text-xs space-y-1">
                <p className="text-muted">Valor: <b className="text-text">{formatBRL(amount)}</b></p>
                {paidInfo?.nsu && <p className="text-muted">NSU: <b className="font-mono text-text">{paidInfo.nsu}</b></p>}
                {paidInfo?.brand && <p className="text-muted">Bandeira: <b className="text-text">{paidInfo.brand}</b></p>}
                {paidInfo?.authCode && <p className="text-muted">Autorização: <b className="font-mono text-text">{paidInfo.authCode}</b></p>}
              </div>
              <Button onClick={onClose} className="w-full mt-2">
                Concluir
              </Button>
            </div>
          )}

          {status === "CANCELED" && (
            <div className="py-6 text-center space-y-3">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral/10 text-muted">
                <XCircle className="h-8 w-8" />
              </div>
              <p className="text-sm font-semibold">Cobrança cancelada</p>
              <p className="text-xs text-muted">A operação foi cancelada no terminal.</p>
              <Button variant="secondary" onClick={() => setStatus("IDLE")} className="w-full">
                Tentar novamente
              </Button>
            </div>
          )}

          {status === "ERROR" && (
            <div className="py-4 text-center space-y-3">
              <p className="text-sm font-semibold text-danger">Falha na operação</p>
              <p className="text-xs text-danger">{errorMsg}</p>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={onClose} className="flex-1">
                  Fechar
                </Button>
                <Button onClick={() => setStatus("IDLE")} className="flex-1">
                  Tentar novamente
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
