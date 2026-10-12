"use client";

import { useState } from "react";
import {
  Copy,
  CreditCard,
  MessageSquare,
  Play,
  Receipt,
  Settings,
  Smartphone,
  TrendingUp,
} from "lucide-react";
import { Badge, Button, cn } from "@/components/ui";
import {
  CATEGORIES,
  PROVIDERS,
  STATUS_LABEL,
  type IntegrationCategory,
  type ProviderKey,
} from "./providers";
import { IntegrationConfigDialog } from "./integration-config-dialog";
import { StoneTerminalsDialog } from "./stone-terminals-dialog";
import { testIntegrationAction } from "./actions";
import type { StoneTerminal } from "../../vender/stone-actions";

export interface IntegrationRowData {
  key: ProviderKey;
  connId?: string;
  status?: "ACTIVE" | "PENDING" | "ERROR" | "DISABLED";
  hasSecret: boolean;
  secretHint?: string;
  config: Record<string, unknown>;
  details: [string, string][];
  lastSyncAt?: string | null;
  lastError?: string | null;
  checkedAt?: string | null;
  stoneTerminals?: StoneTerminal[];
}

interface IntegrationsTableProps {
  rows: IntegrationRowData[];
  functionsUrl: string;
}

const CATEGORY_ICONS: Record<IntegrationCategory, React.ComponentType<{ size?: number; className?: string }>> = {
  MESSAGING: MessageSquare,
  FISCAL: Receipt,
  PAYMENTS: CreditCard,
  MARKETING: TrendingUp,
};

export function IntegrationsTable({ rows, functionsUrl }: IntegrationsTableProps) {
  const [selectedCategory, setSelectedCategory] = useState<IntegrationCategory | "ALL">("ALL");
  const [activeConfigKey, setActiveConfigKey] = useState<ProviderKey | null>(null);
  const [showStoneTerminals, setShowStoneTerminals] = useState(false);
  const [stoneTerminalsState, setStoneTerminalsState] = useState<StoneTerminal[]>(() => {
    const stoneRow = rows.find((r) => r.key === "STONE");
    return stoneRow?.stoneTerminals ?? [];
  });
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(id);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const filteredRows = rows.filter((r) => {
    if (selectedCategory === "ALL") return true;
    return PROVIDERS[r.key].category === selectedCategory;
  });

  const activeConfigRow = activeConfigKey ? rows.find((r) => r.key === activeConfigKey) : null;

  return (
    <>
      {/* Barra de Filtros / Categorias (Estilo IA Modelos) */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-border pb-3">
        {(Object.entries(CATEGORIES) as [IntegrationCategory | "ALL", { label: string }][]).map(([cat, def]) => {
          const count = cat === "ALL" ? rows.length : rows.filter((r) => PROVIDERS[r.key].category === cat).length;
          const isSelected = selectedCategory === cat;
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                isSelected
                  ? "bg-brand/10 text-brand font-semibold shadow-sm"
                  : "text-muted hover:bg-surface-2 hover:text-text",
              )}
            >
              <span>{def.label}</span>
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.2 text-[10px]",
                  isSelected ? "bg-brand/20 text-brand" : "bg-surface-2 text-muted",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tabela Principal (Estilo /ia/modelos) */}
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className="px-3.5 py-2.5 font-medium">Provedor & Finalidade</th>
              <th className="px-3.5 py-2.5 font-medium">Configuração atual</th>
              <th className="px-3.5 py-2.5 font-medium">Situação</th>
              <th className="px-3.5 py-2.5 font-medium text-right">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredRows.map((r) => {
              const def = PROVIDERS[r.key];
              const CategoryIcon = CATEGORY_ICONS[def.category];
              // conexão criada mas sem credencial: "não configurada" (neutro), nunca alerta
              const st = r.status === "PENDING" && !r.hasSecret ? { label: "Não configurada", tone: "neutral" as const } : r.status ? STATUS_LABEL[r.status] : null;

              // Para a Stone, verifica a quantidade de maquininhas cadastradas
              const stoneCount = r.key === "STONE" ? stoneTerminalsState.length : 0;
              const defaultTerminal = r.key === "STONE"
                ? stoneTerminalsState.find((t) => t.isDefault) || stoneTerminalsState[0]
                : null;

              return (
                <tr key={r.key} className="align-top hover:bg-surface-2/30 transition-colors">
                  {/* Coluna 1: Provedor & Finalidade + Details */}
                  <td className="max-w-md px-3.5 py-3">
                    <div className="flex items-start gap-2.5">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-brand">
                        <CategoryIcon size={16} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-text">{def.label}</p>
                          <Badge tone="neutral" className="text-[10px] px-1.5 py-0">
                            {CATEGORIES[def.category].label}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted leading-relaxed">{def.description}</p>

                        <details className="mt-2 text-xs text-muted">
                          <summary className="cursor-pointer font-medium hover:text-brand">
                            Como configurar e requisitos
                          </summary>
                          <div className="mt-2 space-y-1.5 rounded-lg border border-border/60 bg-surface-2/40 p-2.5">
                            {def.requirements && (
                              <p>
                                <b className="text-text">Requisitos:</b> {def.requirements}
                              </p>
                            )}
                            <p>
                              <b className="text-text">Orientação:</b> {def.help}
                            </p>
                            {r.key === "META_WA" && (
                              <div className="flex items-center justify-between rounded bg-surface p-1.5 text-[11px] font-mono">
                                <span className="truncate">{functionsUrl}/webhooks-meta</span>
                                <button
                                  type="button"
                                  onClick={() => copyToClipboard(`${functionsUrl}/webhooks-meta`, "wa")}
                                  className="text-brand hover:underline ml-2 flex items-center gap-1"
                                >
                                  <Copy size={12} />
                                  {copiedKey === "wa" ? "Copiado!" : "Copiar"}
                                </button>
                              </div>
                            )}
                          </div>
                        </details>
                      </div>
                    </div>
                  </td>

                  {/* Coluna 2: Configuração Atual / Resumo */}
                  <td className="px-3.5 py-3 text-xs">
                    {r.key === "STONE" ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted">Ambiente:</span>
                          <span className="font-medium text-text">
                            {r.config.environment === "sandbox" ? "Sandbox (testes)" : "Produção"}
                          </span>
                        </div>
                        {Boolean(r.config.stone_code) && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-muted">Stonecode:</span>
                            <span className="font-mono font-medium text-text">{String(r.config.stone_code)}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-1.5 pt-0.5">
                          <span className="text-muted">Maquininhas:</span>
                          {stoneCount > 0 ? (
                            <span className="font-semibold text-brand">
                              {stoneCount} cadastrada{stoneCount > 1 ? "s" : ""}
                              {defaultTerminal && ` (${defaultTerminal.name})`}
                            </span>
                          ) : (
                            <span className="text-muted">Nenhuma cadastrada</span>
                          )}
                        </div>
                      </div>
                    ) : r.details.length > 0 ? (
                      <dl className="space-y-0.5">
                        {r.details.map(([k, v]) => (
                          <div key={k} className="flex gap-2">
                            <dt className="text-muted shrink-0">{k}:</dt>
                            <dd className="font-medium text-text truncate max-w-[200px]">{v}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <span className="text-muted">Não configurada</span>
                    )}

                    {r.hasSecret && (
                      <p className="mt-1 text-[11px] text-muted">
                        Chave: <span className="font-mono text-text">•••• {r.secretHint ?? "guardada no cofre"}</span>
                      </p>
                    )}
                  </td>

                  {/* Coluna 3: Situação / Status */}
                  <td className="px-3.5 py-3">
                    <div className="space-y-1">
                      {st ? (
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "h-2 w-2 rounded-full",
                              st.tone === "success" && "bg-success",
                              st.tone === "warning" && "bg-warning",
                              st.tone === "danger" && "bg-danger",
                              st.tone === "neutral" && "bg-muted",
                            )}
                          />
                          <Badge tone={st.tone}>{st.label}</Badge>
                        </div>
                      ) : (
                        <Badge tone="neutral">Não configurada</Badge>
                      )}

                      {r.lastError && (
                        <p className="text-[11px] text-danger max-w-[180px] truncate" title={r.lastError}>
                          {r.lastError}
                        </p>
                      )}

                      {r.checkedAt && (
                        <p className="text-[10px] text-muted">
                          Testado em {new Date(r.checkedAt).toLocaleDateString("pt-BR")}
                        </p>
                      )}
                    </div>
                  </td>

                  {/* Coluna 4: Ações Rápidas */}
                  <td className="px-3.5 py-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {/* Para Stone: Botão dedicado de Gerenciar Maquininhas */}
                      {r.key === "STONE" && (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => setShowStoneTerminals(true)}
                          className="px-2.5 py-1 text-xs font-medium"
                          title="Gerenciar maquininhas Stone com nomes"
                        >
                          <Smartphone size={13} className="mr-1 text-brand" />
                          Maquininhas ({stoneCount})
                        </Button>
                      )}

                      {/* Testar agora (se houver conexão) */}
                      {r.connId && r.hasSecret && (
                        <form action={testIntegrationAction} className="inline">
                          <input type="hidden" name="id" value={r.connId} />
                          <input type="hidden" name="action" value="CHECK" />
                          <Button
                            type="submit"
                            variant="ghost"
                            className="px-2 py-1 text-xs text-muted hover:text-text"
                            title="Testar conexão agora"
                          >
                            <Play size={12} className="mr-0.5" />
                            Testar
                          </Button>
                        </form>
                      )}

                      {/* Configurar / Editar */}
                      <Button
                        type="button"
                        variant={r.hasSecret ? "secondary" : "primary"}
                        onClick={() => setActiveConfigKey(r.key)}
                        className="px-2.5 py-1 text-xs"
                      >
                        <Settings size={12} className="mr-1" />
                        {r.hasSecret ? "Editar" : "Configurar"}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-muted">
        As credenciais sensíveis (chaves secretas e tokens de acesso) são criptografadas e salvas diretamente no
        PostgreSQL Vault, nunca sendo expostas no navegador. Para dúvidas sobre permissões ou homologação SEFAZ,
        consulte o suporte do provedor correspondente.
      </p>

      {/* Modal de Configuração do Provedor Selecionado */}
      {activeConfigRow && (
        <IntegrationConfigDialog
          open={Boolean(activeConfigKey)}
          onClose={() => setActiveConfigKey(null)}
          providerKey={activeConfigRow.key}
          def={PROVIDERS[activeConfigRow.key]}
          config={activeConfigRow.config}
          hasSecret={activeConfigRow.hasSecret}
          secretHint={activeConfigRow.secretHint}
          lastError={activeConfigRow.lastError}
          connId={activeConfigRow.connId}
          status={activeConfigRow.status}
          onOpenTerminals={
            activeConfigRow.key === "STONE"
              ? () => {
                  setActiveConfigKey(null);
                  setShowStoneTerminals(true);
                }
              : undefined
          }
        />
      )}

      {/* Modal de Gerenciamento de Maquininhas Stone */}
      <StoneTerminalsDialog
        open={showStoneTerminals}
        onClose={() => setShowStoneTerminals(false)}
        initialTerminals={stoneTerminalsState}
        onSaved={(updated) => setStoneTerminalsState(updated)}
      />
    </>
  );
}
