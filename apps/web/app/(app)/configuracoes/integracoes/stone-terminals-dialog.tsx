"use client";

import { useState, useTransition } from "react";
import { Edit2, Plus, Smartphone, Star, Trash2, X } from "lucide-react";
import { Badge, Button, cn, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { saveStoneTerminalsAction, type StoneTerminal } from "../../vender/stone-actions";
import { PosDevicesPanel } from "./pos-devices-panel";

interface StoneTerminalsDialogProps {
  open: boolean;
  onClose: () => void;
  initialTerminals: StoneTerminal[];
  onSaved?: (terminals: StoneTerminal[]) => void;
}

export function StoneTerminalsDialog(props: StoneTerminalsDialogProps) {
  if (!props.open) return null;
  return <StoneTerminalsModal {...props} />;
}

function StoneTerminalsModal({
  onClose,
  initialTerminals,
  onSaved,
}: Omit<StoneTerminalsDialogProps, "open">) {
  const [terminals, setTerminals] = useState<StoneTerminal[]>(initialTerminals);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form states for adding or editing
  const [name, setName] = useState("");
  const [serial, setSerial] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleStartEdit = (t: StoneTerminal) => {
    setEditingId(t.id);
    setName(t.name);
    setSerial(t.serial);
    setIsDefault(Boolean(t.isDefault));
    setError(null);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setName("");
    setSerial("");
    setIsDefault(false);
    setError(null);
  };

  const handleSaveTerminal = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    const cleanSerial = serial.trim();

    if (!cleanName) {
      setError("Dê um nome para a maquininha (ex: Caixa 1 - Balcão).");
      return;
    }
    if (!cleanSerial) {
      setError("Informe o número de série que fica atrás da maquininha.");
      return;
    }

    let updated: StoneTerminal[];
    if (editingId) {
      // Editando existente
      updated = terminals.map((t) => {
        if (t.id === editingId) {
          return { ...t, name: cleanName, serial: cleanSerial, isDefault };
        }
        return isDefault ? { ...t, isDefault: false } : t;
      });
    } else {
      // Adicionando nova
      const newTerminal: StoneTerminal = {
        id: `term_${Date.now()}`,
        name: cleanName,
        serial: cleanSerial,
        isDefault: isDefault || terminals.length === 0,
      };
      if (isDefault) {
        updated = [...terminals.map((t) => ({ ...t, isDefault: false })), newTerminal];
      } else {
        updated = [...terminals, newTerminal];
      }
    }

    // Se nenhuma estiver como default, a primeira vira default
    if (!updated.some((t) => t.isDefault) && updated.length > 0) {
      updated[0].isDefault = true;
    }

    setTerminals(updated);
    handleCancelEdit();

    // Persiste no banco de dados
    startTransition(async () => {
      const res = await saveStoneTerminalsAction(updated);
      if (!res.ok) {
        setError(res.error || "Erro ao salvar maquininhas");
      } else {
        onSaved?.(updated);
      }
    });
  };

  const handleSetDefault = (id: string) => {
    const updated = terminals.map((t) => ({
      ...t,
      isDefault: t.id === id,
    }));
    setTerminals(updated);

    startTransition(async () => {
      const res = await saveStoneTerminalsAction(updated);
      if (res.ok) onSaved?.(updated);
    });
  };

  const handleDelete = (id: string) => {
    if (terminals.length === 1) {
      if (!confirm("Esta é a única maquininha cadastrada. Deseja realmente remover?")) return;
    }
    const filtered = terminals.filter((t) => t.id !== id);
    if (filtered.length > 0 && !filtered.some((t) => t.isDefault)) {
      filtered[0].isDefault = true;
    }
    setTerminals(filtered);
    if (editingId === id) handleCancelEdit();

    startTransition(async () => {
      const res = await saveStoneTerminalsAction(filtered);
      if (res.ok) onSaved?.(filtered);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-black/60 p-4 backdrop-blur-sm animate-in fade-in sm:items-center">
      <div className="max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto overscroll-contain rounded-2xl border border-border bg-surface p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Smartphone size={20} />
            </div>
            <div>
              <h2 className="text-base font-semibold">Maquininhas Stone (Smart POS)</h2>
              <p className="text-xs text-muted">
                Cadastre seus terminais Stone com nome para escolher no PDV com 1 clique.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-text"
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <p role="alert" className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}

        {/* Lista de Maquininhas cadastradas */}
        <div className="mb-5 space-y-2 max-h-64 overflow-y-auto pr-1">
          {terminals.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted">
              Nenhuma maquininha Stone cadastrada ainda. Adicione a primeira abaixo.
            </div>
          ) : (
            terminals.map((t) => (
              <div
                key={t.id}
                className={cn(
                  "flex items-center justify-between rounded-xl border p-3 transition-colors",
                  t.isDefault ? "border-brand/40 bg-brand/5" : "border-border bg-surface-2/40 hover:bg-surface-2",
                )}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-bold text-xs",
                      t.isDefault ? "bg-brand text-white" : "bg-surface-2 text-muted",
                    )}
                  >
                    <Smartphone size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-sm truncate text-text">{t.name}</p>
                      {t.isDefault && (
                        <Badge tone="brand" className="text-[10px] px-1.5 py-0 font-medium">
                          Padrão da loja
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs font-mono text-muted">Serial: {t.serial}</p>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0 ml-2">
                  {!t.isDefault && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => handleSetDefault(t.id)}
                      disabled={pending}
                      className="px-2 py-1 text-xs text-muted hover:text-brand"
                      title="Definir como maquininha padrão"
                    >
                      <Star size={14} className="mr-1" />
                      Tornar padrão
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleStartEdit(t)}
                    disabled={pending}
                    className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-text"
                    title="Editar maquininha"
                  >
                    <Edit2 size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(t.id)}
                    disabled={pending}
                    className="rounded-lg p-1.5 text-muted hover:bg-danger/10 hover:text-danger"
                    title="Excluir maquininha"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Formulário para Adicionar ou Editar Maquininha */}
        <form onSubmit={handleSaveTerminal} className="rounded-xl border border-border bg-surface-2/60 p-4">
          <p className="mb-3 text-xs font-semibold text-text flex items-center gap-1.5">
            {editingId ? <Edit2 size={14} className="text-brand" /> : <Plus size={14} className="text-brand" />}
            {editingId ? "Editar maquininha" : "Adicionar nova maquininha Stone"}
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nome da maquininha" hint="Ex: Caixa 1 - Balcão, Salão, Móvel 2">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Caixa 1 - Balcão"
                className={inputClass}
                disabled={pending}
              />
            </Field>

            <Field label="Número de série (Serial)" hint="Número atrás do POS (ex: ST-88492019)">
              <input
                required
                value={serial}
                onChange={(e) => setSerial(e.target.value)}
                placeholder="Ex: ST-88492019 ou 123456789"
                className={inputClass}
                disabled={pending}
              />
            </Field>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                disabled={pending}
                className="rounded border-border"
              />
              Definir como maquininha padrão no PDV
            </label>

            <div className="flex gap-2">
              {editingId && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleCancelEdit}
                  disabled={pending}
                  className="px-3 py-1.5 text-xs"
                >
                  Cancelar
                </Button>
              )}
              <Button type="submit" disabled={pending} className="px-3 py-1.5 text-xs">
                {pending ? "Salvando…" : editingId ? "Salvar alterações" : "+ Adicionar maquininha"}
              </Button>
            </div>
          </div>
        </form>

        <PosDevicesPanel />

        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={onClose} className="px-4 py-1.5 text-xs">
            Fechar
          </Button>
        </div>
      </div>
    </div>
  );
}
