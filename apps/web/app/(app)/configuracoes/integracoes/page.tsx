import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, PageHeader, Table } from "@/components/ui";
import { Flash } from "@/components/form";
import { AutoRefresh } from "@/components/auto-refresh";
import { toggleChannelAction } from "./actions";
import { ChannelForm, type ConnOption } from "./channel-form";
import { MODE_LABEL, PROVIDERS, PROVIDER_KEYS, STATUS_LABEL, type ProviderKey } from "./providers";
import { IntegrationsTable, type IntegrationRowData } from "./integrations-table";
import type { StoneTerminal } from "../../vender/stone-actions";

export const metadata = { title: "Integrações" };

type Health = { ok?: boolean; checked_at?: string; detail?: Record<string, unknown> } | undefined;
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** O que a última verificação encontrou, em linguagem de gente. */
function describe(provider: ProviderKey, d: Record<string, unknown>, terminals?: StoneTerminal[]): [string, string][] {
  const row = (label: string, v: unknown): [string, string][] => (v === null || v === undefined || v === "" ? [] : [[label, String(v)]]);
  switch (provider) {
    case "META_WA":
      return [...row("Número", d.display_phone_number), ...row("Nome verificado", d.verified_name), ...row("Qualidade", d.quality_rating), ...row("Nome de exibição", d.name_status)];
    case "META_IG":
      return [...row("Conta", d.username ? `@${d.username}` : undefined), ...row("Tipo", d.account_type), ...row("ID da conta", d.user_id)];
    case "TELEGRAM":
      return [...row("Bot", d.username ? `@${d.username}` : undefined), ...row("ID do bot", d.bot_id), ...row("Webhook", d.webhook_url), ...row("Pendentes", d.pending_update_count), ...row("Último erro", d.last_error_message)];
    case "META_ADS":
      return [...row("Conta de anúncios", d.name), ...row("Moeda", d.currency)];
    case "META_CAPI":
      return [...row("Conjunto de dados", d.name), ...row("ID", d.dataset_id)];
    case "FOCUS_NFE":
      return [...row("Ambiente", d.environment === "producao" ? "Produção" : d.environment === "homologacao" ? "Homologação" : d.environment)];
    case "BRASIL_NFE":
      return [...row("Ambiente", d.environment === "producao" ? "Produção" : d.environment === "homologacao" ? "Homologação" : d.environment), ...row("Situação", d.status)];
    case "STONE": {
      const count = terminals ? terminals.length : 0;
      const defT = terminals?.find((t) => t.isDefault) || terminals?.[0];
      return [
        ...row("Ambiente", d.environment === "sandbox" ? "Sandbox (testes)" : "Produção"),
        ...row("Stonecode", d.stone_code),
        ...row("Maquininhas", count > 0 ? `${count} cadastrada(s)${defT ? ` · Padrão: ${defT.name}` : ""}` : d.default_serial_number ? `1 maquininha (serial ${d.default_serial_number})` : undefined),
      ];
    }
  }
}

export default async function IntegracoesPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("core.admin");
  const sp = await searchParams;
  const supabase = await createClient();
  const [{ data: conns }, { data: channels }, { data: stores }, { data: personas }] = await Promise.all([
    supabase.schema("core").from("integration_connections").select("id, provider, capability, status, config, secret_ref, last_sync_at, last_error, updated_at"),
    supabase.schema("omni").from("channel_accounts").select("id, channel, provider_account_id, display_name, store_id, default_persona_id, default_ai_mode, connection_id, status").order("channel").order("display_name"),
    supabase.schema("core").from("stores").select("id, name").order("name"),
    supabase.schema("ai").from("personas").select("id, name").order("name"),
  ]);

  const byProvider = new Map((conns ?? []).map((c) => [c.provider, c]));
  const connById = new Map((conns ?? []).map((c) => [c.id, c]));
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));
  const functionsUrl = `${(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "")}/functions/v1`;

  const options: ConnOption[] = (conns ?? []).filter((c) => c.secret_ref && ["META_WA", "META_IG", "TELEGRAM"].includes(c.provider)).map((c) => {
    const cfg = asObj(c.config);
    const detail = asObj(asObj(cfg.health).detail);
    const suggested = c.provider === "META_WA" ? cfg.phone_number_id : c.provider === "TELEGRAM" ? detail.bot_id : detail.user_id;
    return { id: c.id, provider: c.provider, label: `${PROVIDERS[c.provider as ProviderKey].label}${cfg.secret_hint ? ` · ${String(cfg.secret_hint)}` : ""}`, suggestedAccountId: suggested ? String(suggested) : undefined };
  });

  // Linhas formatadas para a tabela de integrações (estilo /ia/modelos)
  const rows: IntegrationRowData[] = PROVIDER_KEYS.map((key) => {
    const c = byProvider.get(key);
    const cfg = asObj(c?.config);
    const health = cfg.health as Health;

    let stoneTerminals: StoneTerminal[] = [];
    if (key === "STONE") {
      if (Array.isArray(cfg.terminals)) {
        stoneTerminals = (cfg.terminals as Array<Record<string, unknown>>).map((t, i) => ({
          id: String(t.id || `term_${i}`),
          name: String(t.name || `Maquininha ${i + 1}`),
          serial: String(t.serial || ""),
          isDefault: Boolean(t.is_default || t.isDefault),
        }));
      } else if (cfg.default_serial_number) {
        stoneTerminals = [
          { id: "default", name: "Maquininha Padrão", serial: String(cfg.default_serial_number), isDefault: true },
        ];
      }
    }

    const details = describe(key, asObj(health?.detail || cfg), key === "STONE" ? stoneTerminals : undefined);

    return {
      key,
      connId: c?.id,
      status: (c?.status as "ACTIVE" | "PENDING" | "ERROR" | "DISABLED") || undefined,
      hasSecret: Boolean(c?.secret_ref),
      secretHint: cfg.secret_hint ? String(cfg.secret_hint) : undefined,
      config: cfg,
      details,
      lastSyncAt: c?.last_sync_at,
      lastError: c?.last_error,
      checkedAt: health?.checked_at,
      stoneTerminals: key === "STONE" ? stoneTerminals : undefined,
    };
  });

  return (
    <>
      <PageHeader
        title="Integrações & Conexões"
        description="Gerencie os provedores externos de mensageria, fiscal, pagamentos e marketing. As credenciais são salvas criptografadas no Vault com validação automática."
      />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {str(sp.wait) && <AutoRefresh />}

      {/* Tabela de Integrações (Estilo /ia/modelos) */}
      <IntegrationsTable rows={rows} functionsUrl={functionsUrl} />

      {/* Canais de Atendimento */}
      <div className="mt-8 mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Canais de atendimento</h2>
          <p className="text-xs text-muted">Contas e números conectados que direcionam para o atendimento e a IA.</p>
        </div>
      </div>

      {(channels ?? []).length === 0 ? (
        <Empty title="Nenhum canal cadastrado">
          Configure a conexão acima e cadastre o número/bot/conta: é ele que liga as mensagens recebidas à caixa de entrada.
        </Empty>
      ) : (
        <Table head={["Canal", "Nome", "Identificador", "Loja", "Conversa nova", "Conexão", "Situação", ""]}>
          {(channels ?? []).map((ch) => {
            const conn = ch.connection_id ? connById.get(ch.connection_id) : undefined;
            const st = conn ? STATUS_LABEL[conn.status] : undefined;
            return (
              <tr key={ch.id} className={ch.status === "ACTIVE" ? "" : "opacity-60"}>
                <td className="px-3 py-2">
                  {ch.channel === "WHATSAPP" ? "WhatsApp" : ch.channel === "INSTAGRAM" ? "Instagram" : ch.channel === "TELEGRAM" ? "Telegram" : ch.channel}
                </td>
                <td className="px-3 py-2 font-medium">{ch.display_name}</td>
                <td className="px-3 py-2 font-mono text-xs">{ch.provider_account_id}</td>
                <td className="px-3 py-2">{ch.store_id ? storeName.get(ch.store_id) ?? "—" : "—"}</td>
                <td className="px-3 py-2 text-xs">{MODE_LABEL[ch.default_ai_mode] ?? ch.default_ai_mode}</td>
                <td className="px-3 py-2">
                  {conn ? <Badge tone={st?.tone}>{st?.label}</Badge> : <Badge tone="warning">sem conexão</Badge>}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={ch.status === "ACTIVE" ? "success" : "neutral"}>
                    {ch.status === "ACTIVE" ? "ativo" : "desativado"}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <Link href={`/configuracoes/integracoes/horario/${ch.id}`} className="rounded-lg px-2 py-1 text-xs hover:bg-surface-2">
                      Horário
                    </Link>
                    <form action={toggleChannelAction}>
                      <input type="hidden" name="id" value={ch.id} />
                      <Button variant="ghost" className="px-2 py-1 text-xs">
                        {ch.status === "ACTIVE" ? "Desativar" : "Reativar"}
                      </Button>
                    </form>
                  </div>
                </td>
              </tr>
            );
          })}
        </Table>
      )}

      {/* Cadastro de Novo Canal */}
      <Card className="mt-6" title="Novo canal de atendimento">
        <ChannelForm
          connections={options}
          stores={(stores ?? []).map((s) => ({ id: s.id, label: s.name }))}
          personas={(personas ?? []).map((p) => ({ id: p.id, label: p.name }))}
        />
      </Card>

      {/* Webhooks de Callback */}
      <Card className="mt-4" title="Webhooks (para colar no painel de cada provedor)">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">Meta — WhatsApp e Instagram (URL de callback)</dt>
            <dd className="mt-0.5 break-all font-mono text-xs">{functionsUrl}/webhooks-meta</dd>
            <dd className="mt-1 text-xs text-muted">
              Token de verificação: o valor do segredo <code>META_VERIFY_TOKEN</code> das Edge Functions. Assine os campos <code>messages</code> (WhatsApp) e <code>messages</code>, <code>comments</code> (Instagram).
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Telegram</dt>
            <dd className="mt-0.5 break-all font-mono text-xs">{functionsUrl}/webhooks-telegram/&lt;ID do bot&gt;</dd>
            <dd className="mt-1 text-xs text-muted">
              Use o botão “Registrar webhook” no cartão do Telegram: ele chama o <code>setWebhook</code> com o segredo correto.
            </dd>
          </div>
        </dl>
      </Card>
    </>
  );
}
