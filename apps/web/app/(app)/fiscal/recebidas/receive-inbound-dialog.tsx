"use client";

import { useState, useTransition } from "react";
import { formatBRL } from "@centralops/domain";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { importInboundDfeAction } from "./actions";

interface LocationOption {
  id: string;
  name: string;
  legal_entity_id: string;
}

interface InboundReceiveButtonProps {
  dfe: {
    id: string;
    access_key: string;
    issuer_name: string | null;
    issuer_cnpj: string | null;
    amount: number;
    legal_entity_id: string;
  };
  locations: LocationOption[];
}

export function InboundReceiveButton({ dfe, locations }: InboundReceiveButtonProps) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const entityLocs = locations.filter((l) => l.legal_entity_id === dfe.legal_entity_id);
  const availableLocs = entityLocs.length > 0 ? entityLocs : locations;
  const defaultLocId = availableLocs[0]?.id ?? "";

  return (
    <>
      <Button
        type="button"
        variant="primary"
        onClick={() => setOpen(true)}
        className="px-2 py-1 text-xs whitespace-nowrap"
      >
        Dar entrada no estoque
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl animate-in fade-in zoom-in-95">
            <div className="mb-4">
              <h3 className="text-base font-semibold">Dar entrada no estoque</h3>
              <p className="text-xs text-muted mt-1">
                Importar XML autorizado da SEFAZ para conferência e entrada de mercadorias.
              </p>
            </div>

            <div className="mb-4 rounded-xl border border-border/80 bg-surface-2/40 p-3 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-muted">Fornecedor:</span>
                <span className="font-medium text-right max-w-[240px] truncate">{dfe.issuer_name || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">CNPJ:</span>
                <span className="font-mono">{dfe.issuer_cnpj || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Valor Total:</span>
                <span className="font-semibold text-brand">{formatBRL(dfe.amount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Chave:</span>
                <span className="font-mono text-[10px] text-muted truncate max-w-[240px]">{dfe.access_key}</span>
              </div>
            </div>

            <form
              action={(formData) => {
                startTransition(async () => {
                  await importInboundDfeAction(formData);
                });
              }}
              className="space-y-4"
            >
              <input type="hidden" name="dfe_id" value={dfe.id} />

              <Field label="Local de estoque (onde as mercadorias serão guardadas)">
                <select
                  name="location_id"
                  required
                  defaultValue={defaultLocId}
                  className={`${inputClass} mt-1`}
                  disabled={pending}
                >
                  {availableLocs.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>
              </Field>

              <p className="text-[11px] text-muted">
                O sistema lerá todos os produtos, tributos e duplicatas do XML e abrirá direto a tela de conferência física para conferir as quantidades e abastecer o estoque.
              </p>

              <div className="flex justify-end gap-2 pt-2 border-t border-border">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                  className="px-3 py-1.5 text-xs"
                >
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  disabled={pending || !defaultLocId}
                  className="px-3 py-1.5 text-xs"
                >
                  {pending ? "Importando..." : "Importar e conferir itens"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
