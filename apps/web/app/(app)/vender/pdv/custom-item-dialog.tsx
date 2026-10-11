"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";

interface CustomItemDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (description: string, price: number, qty: number, ncm?: string) => void;
}

export function CustomItemDialog({ open, onClose, onAdd }: CustomItemDialogProps) {
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState(1);
  const [ncm, setNcm] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const desc = description.trim();
    if (!desc) {
      setError("Informe a descrição do item avulso.");
      return;
    }

    const numPrice = Number(price.replace(/\./g, "").replace(",", "."));
    if (isNaN(numPrice) || numPrice <= 0) {
      setError("Informe um preço unitário válido maior que zero.");
      return;
    }

    if (qty <= 0) {
      setError("A quantidade deve ser de pelo menos 1.");
      return;
    }

    const ncmDigits = ncm.replace(/\D/g, "");
    if (ncmDigits && ncmDigits.length !== 8) {
      setError("O NCM tem 8 dígitos (ou deixe em branco para usar o NCM padrão da matriz fiscal).");
      return;
    }

    onAdd(desc, numPrice, qty, ncmDigits || undefined);
    setNcm("");
    setDescription("");
    setPrice("");
    setQty(1);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl animate-in fade-in zoom-in-95">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Adicionar item avulso</h3>
            <p className="text-xs text-muted mt-0.5">
              Item ou serviço fora do estoque com preço definido manualmente.
            </p>
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

        {error && (
          <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <Field label="Descrição do item ou serviço">
            <input
              autoFocus
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ex: Ajuste de barra / Embalagem para presente"
              className={`${inputClass} mt-1`}
              maxLength={150}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Preço unitário (R$)">
              <input
                required
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0,00"
                className={`${inputClass} mt-1`}
              />
            </Field>

            <Field label="Quantidade">
              <input
                type="number"
                min={1}
                max={999}
                value={qty}
                onChange={(e) => setQty(Number(e.target.value) || 1)}
                className={`${inputClass} mt-1`}
              />
            </Field>
          </div>

          <Field label="NCM (opcional)" hint="8 dígitos. Em branco: usa o NCM padrão da matriz fiscal; sem nenhum, a NFC-e não é emitida">
            <input inputMode="numeric" maxLength={10} value={ncm} onChange={(e) => setNcm(e.target.value)} placeholder="ex.: 61091000" className={`${inputClass} mt-1`} />
          </Field>

          <p className="text-[11px] text-muted">
            Este item não baixará estoque de produto de catálogo e entrará diretamente no total e na nota fiscal do pedido.
          </p>

          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <Button type="button" variant="secondary" onClick={onClose} className="px-3 py-1.5 text-xs">
              Cancelar
            </Button>
            <Button type="submit" className="px-3 py-1.5 text-xs">
              Adicionar ao carrinho
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
