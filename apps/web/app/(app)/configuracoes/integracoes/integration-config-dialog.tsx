"use client";

import { X } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { IntegrationForm } from "./integration-form";
import { removeSecretAction, testIntegrationAction, toggleIntegrationAction } from "./actions";
import type { ProviderDef, ProviderKey } from "./providers";

interface IntegrationConfigDialogProps {
  open: boolean;
  onClose: () => void;
  providerKey: ProviderKey;
  def: ProviderDef;
  config: Record<string, unknown>;
  hasSecret: boolean;
  secretHint?: string;
  lastError?: string | null;
  connId?: string;
  status?: string;
  onOpenTerminals?: () => void;
}

export function IntegrationConfigDialog(props: IntegrationConfigDialogProps) {
  if (!props.open) return null;
  return <IntegrationConfigModal {...props} />;
}

function IntegrationConfigModal({
  onClose,
  providerKey,
  def,
  config,
  hasSecret,
  secretHint,
  lastError,
  connId,
  status,
  onOpenTerminals,
}: Omit<IntegrationConfigDialogProps, "open">) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-black/60 p-4 backdrop-blur-sm animate-in fade-in sm:items-center">
      {/* formulário longo (ex.: SEFAZ direta): a caixa tem altura máxima e rola por dentro */}
      <div className="flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col overflow-y-auto overscroll-contain rounded-2xl border border-border bg-surface p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">{def.label}</h2>
              {hasSecret ? (
                <Badge tone="success">Conectada</Badge>
              ) : (
                <Badge tone="neutral">Não configurada</Badge>
              )}
            </div>
            <p className="text-xs text-muted mt-0.5">{def.description}</p>
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

        {lastError && (
          <p role="alert" className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            {lastError}
          </p>
        )}

        {def.requirements && (
          <div className="mb-4 rounded-xl border border-border/80 bg-surface-2/40 p-3 text-xs">
            <span className="font-semibold text-text">Requisitos para esta integração: </span>
            <span className="text-muted">{def.requirements}</span>
          </div>
        )}

        {/* Formulário de Configuração e Credencial */}
        <div className="rounded-xl border border-border bg-surface-2/30 p-4">
          <IntegrationForm
            providerKey={providerKey}
            def={def}
            config={config}
            hasSecret={hasSecret}
            secretHint={secretHint}
          />
        </div>

        {providerKey === "STONE" && onOpenTerminals && (
          <div className="mt-4 flex items-center justify-between rounded-xl border border-brand/20 bg-brand/5 p-3">
            <div>
              <p className="text-xs font-semibold text-text">Maquininhas Stone cadastradas</p>
              <p className="text-[11px] text-muted">
                Adicione múltiplos terminais com nomes personalizados (ex: Caixa 1, Salão, Móvel 2).
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={onOpenTerminals}
              className="text-xs px-3 py-1.5"
            >
              Gerenciar maquininhas
            </Button>
          </div>
        )}

        <p className="mt-4 text-xs text-muted">{def.help}</p>

        {/* Ações adicionais se possuir conexão */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
          <div className="flex flex-wrap gap-2">
            {connId && (
              <>
                <form action={testIntegrationAction}>
                  <input type="hidden" name="id" value={connId} />
                  <input type="hidden" name="action" value="CHECK" />
                  <Button variant="secondary" className="px-2.5 py-1 text-xs">
                    Testar agora
                  </Button>
                </form>

                {providerKey === "TELEGRAM" && (
                  <form action={testIntegrationAction}>
                    <input type="hidden" name="id" value={connId} />
                    <input type="hidden" name="action" value="TELEGRAM_WEBHOOK" />
                    <Button variant="secondary" className="px-2.5 py-1 text-xs">
                      Registrar webhook
                    </Button>
                  </form>
                )}

                <form action={toggleIntegrationAction}>
                  <input type="hidden" name="id" value={connId} />
                  <input type="hidden" name="enabled" value={status === "DISABLED" ? "1" : "0"} />
                  <Button variant="ghost" className="px-2.5 py-1 text-xs">
                    {status === "DISABLED" ? "Reativar" : "Desativar"}
                  </Button>
                </form>

                <form action={removeSecretAction}>
                  <input type="hidden" name="id" value={connId} />
                  <Button variant="ghost" className="px-2.5 py-1 text-xs text-danger">
                    Remover credencial
                  </Button>
                </form>
              </>
            )}
          </div>

          <Button variant="secondary" onClick={onClose} className="px-4 py-1.5 text-xs">
            Fechar
          </Button>
        </div>
      </div>
    </div>
  );
}
