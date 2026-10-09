"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { formatBRL, roundCents } from "@centralops/domain";
import { Button, cn, inputClass } from "@/components/ui";
import { Field } from "@/components/form";

interface ItemDiscountDialogProps {
  open: boolean;
  onClose: () => void;
  itemName: string;
  grossAmount: number;
  currentDiscountAmount: number;
  initialType?: "PERCENT" | "FIXED";
  initialValue?: number;
  initialReason?: string;
  canDiscount: boolean;
  onApply: (type: "PERCENT" | "FIXED", value: number, reason?: string) => void;
  onRemove: () => void;
}

export function ItemDiscountDialog(props: ItemDiscountDialogProps) {
  if (!props.open) return null;
  return <ItemDiscountModal key={`${props.itemName}-${props.initialValue ?? ""}`} {...props} />;
}

function ItemDiscountModal({
  onClose,
  itemName,
  grossAmount,
  currentDiscountAmount,
  initialType = "PERCENT",
  initialValue,
  initialReason,
  canDiscount,
  onApply,
  onRemove,
}: Omit<ItemDiscountDialogProps, "open">) {
  const [type, setType] = useState<"PERCENT" | "FIXED">(initialType);
  const [valueStr, setValueStr] = useState(
    initialValue !== undefined ? String(initialValue).replace(".", ",") : "",
  );
  const [reason, setReason] = useState(initialReason || "");
  const [error, setError] = useState<string | null>(null);

  const numVal = Number(valueStr.replace(/\./g, "").replace(",", ".")) || 0;
  let calculatedDisc = 0;
  if (type === "PERCENT") {
    calculatedDisc = roundCents(grossAmount * (Math.min(Math.max(numVal, 0), 100) / 100));
  } else {
    calculatedDisc = roundCents(Math.min(Math.max(numVal, 0), grossAmount));
  }
  const finalItemTotal = roundCents(Math.max(grossAmount - calculatedDisc, 0));

  const handleApply = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canDiscount) {
      setError("Seu perfil de acesso não possui a permissão 'sales.discount'.");
      return;
    }
    if (numVal <= 0) {
      setError("Informe um valor de desconto maior que zero.");
      return;
    }
    if (type === "PERCENT" && numVal > 100) {
      setError("O desconto em porcentagem não pode ser maior que 100%.");
      return;
    }
    if (type === "FIXED" && numVal > grossAmount) {
      setError(`O desconto não pode ser maior que o valor total do item (${formatBRL(grossAmount)}).`);
      return;
    }

    onApply(type, numVal, reason.trim() || undefined);
    onClose();
  };

  const handleRemove = () => {
    onRemove();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl animate-in fade-in zoom-in-95">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Desconto no item</h3>
            <p className="text-xs text-muted truncate max-w-[280px] mt-0.5">{itemName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-text"
          >
            <X size={18} />
          </button>
        </div>

        {!canDiscount && (
          <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
            Seu perfil de acesso não tem permissão para conceder descontos (permissão <b>sales.discount</b> necessária).
          </div>
        )}

        {error && (
          <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}

        <form onSubmit={handleApply} className="space-y-3">
          <div className="rounded-xl border border-border/80 bg-surface-2/40 p-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-muted">Valor original do item:</span>
              <span className="font-semibold">{formatBRL(grossAmount)}</span>
            </div>
            {calculatedDisc > 0 && (
              <>
                <div className="flex justify-between text-success">
                  <span>Desconto a aplicar:</span>
                  <span className="font-semibold">- {formatBRL(calculatedDisc)}</span>
                </div>
                <div className="flex justify-between border-t border-border/60 pt-1 font-semibold">
                  <span>Total com desconto:</span>
                  <span className="text-brand">{formatBRL(finalItemTotal)}</span>
                </div>
              </>
            )}
          </div>

          <div className="flex rounded-lg border border-border p-1 bg-surface-2/60">
            <button
              type="button"
              onClick={() => setType("PERCENT")}
              className={cn(
                "flex-1 rounded-md py-1 text-xs font-semibold transition-colors",
                type === "PERCENT" ? "bg-surface shadow text-brand" : "text-muted hover:text-text",
              )}
            >
              Porcentagem (%)
            </button>
            <button
              type="button"
              onClick={() => setType("FIXED")}
              className={cn(
                "flex-1 rounded-md py-1 text-xs font-semibold transition-colors",
                type === "FIXED" ? "bg-surface shadow text-brand" : "text-muted hover:text-text",
              )}
            >
              Valor em Reais (R$)
            </button>
          </div>

          <Field label={type === "PERCENT" ? "Desconto em %" : "Desconto em R$"}>
            <input
              autoFocus
              disabled={!canDiscount}
              required
              inputMode="decimal"
              value={valueStr}
              onChange={(e) => setValueStr(e.target.value)}
              placeholder={type === "PERCENT" ? "Ex: 10 para 10%" : "Ex: 15,00"}
              className={`${inputClass} mt-1`}
            />
          </Field>

          <Field label="Motivo do desconto (opcional)">
            <input
              disabled={!canDiscount}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex: Peça mostruário / Cortesia gerente"
              className={`${inputClass} mt-1`}
              maxLength={100}
            />
          </Field>

          <div className="flex justify-between items-center pt-2 border-t border-border">
            {currentDiscountAmount > 0 ? (
              <Button
                type="button"
                variant="ghost"
                onClick={handleRemove}
                disabled={!canDiscount}
                className="px-2 py-1 text-xs text-danger hover:bg-danger/10"
              >
                Remover desconto
              </Button>
            ) : <span />}

            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose} className="px-3 py-1.5 text-xs">
                Cancelar
              </Button>
              <Button type="submit" disabled={!canDiscount || numVal <= 0} className="px-3 py-1.5 text-xs">
                Aplicar desconto
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
