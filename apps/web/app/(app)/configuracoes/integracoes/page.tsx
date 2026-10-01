import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, PageHeader, Table } from "@/components/ui";
import { Flash } from "@/components/form";
import { AutoRefresh } from "@/components/auto-refresh";
import { removeSecretAction, testIntegrationAction, toggleChannelAction, toggleIntegrationAction } from "./actions";
import { ChannelForm, type ConnOption } from "./channel-form";
import { IntegrationForm } from "./integration-form";
import { MODE_LABEL, PROVIDERS, PROVIDER_KEYS, STATUS_LABEL, type ProviderKey } from "./providers";

export const metadata = { title: "Integrações" };

type Health = { ok?: boolean; checked_at?: string; detail?: Record<string, unknown> } | undefined;
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const fmtWhen = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "—");

/** O que a última verificação encontrou, em linguagem de gente. */
function describe(provider: ProviderKey, d: Record<string, unknown>): [string, string][] {
  const row = (label: string, v: unknown): [string, string][] => (v === null || v === undefined || v === "" ? [] : [[label, String(v)]]);
  switch (provider) {
    case "META_WA": return [...row("Número", d.display_phone_number), ...row("Nome verificado", d.verified_name), ...row("Qualidade", d.quality_rating), ...row("Nome de exibição", d.name_status)];
    case "META_IG": return [...row("Conta", d.username ? `@${d.username}` : undefined), ...row("Tipo", d.account_type), ...row("ID da conta", d.user_id)];
    case "TELEGRAM": return [...row("Bot", d.username ? `@${d.username}` : undefined), ...row("ID do bot", d.bot_id), ...row("Webhook", d.webhook_url), ...row("Pendentes", d.pending_update_count), ...row("Último erro do Telegram", d.last_error_message)];
    case "META_ADS": return [...row("Conta de anúncios", d.name), ...row("Moeda", d.currency)];
    case "META_CAPI": return [...row("Conjunto de dados", d.name), ...row("ID", d.dataset_id)];
    case "FOCUS_NFE": return [...row("Ambiente", d.environment === "producao" ? "Produção" : d.environment === "homologacao" ? "Homologação" : d.environment)];
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

  return (
    <>
      <PageHeader title="Integrações" description="Credenciais dos serviços externos. O segredo vai direto para o cofre (Vault) e nunca é exibido de novo; o worker testa a credencial e mostra aqui o resultado." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {str(sp.wait) && <AutoRefresh />}

      <div className="grid gap-4 lg:grid-cols-2">
        {PROVIDER_KEYS.map((key) => {
          const def = PROVIDERS[key];
          const c = byProvider.get(key);
          const cfg = asObj(c?.config);
          const health = cfg.health as Health;
          const status = c ? STATUS_LABEL[c.status] ?? STATUS_LABEL.PENDING : undefined;
          const detail = describe(key, asObj(health?.detail));
          return (
            <Card key={key} title={def.label} action={status ? <Badge tone={status.tone}>{status.label}</Badge> : <Badge>Não configurada</Badge>}>
              <p className="mb-3 text-xs text-muted">{def.description}</p>

              {c?.last_error && <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{c.last_error}</p>}
              {detail.length > 0 && (
                <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  {detail.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="break-all font-medium">{v}</dd></div>)}
                </dl>
              )}
              {c && <p className="mb-3 text-xs text-muted">Última verificação: {fmtWhen(health?.checked_at)}{c.last_sync_at ? ` · última vez funcionando: ${fmtWhen(c.last_sync_at)}` : ""}</p>}

              <IntegrationForm providerKey={key} def={def} config={cfg} hasSecret={Boolean(c?.secret_ref)} secretHint={cfg.secret_hint ? String(cfg.secret_hint) : undefined} />
              <p className="mt-3 text-xs text-muted">{def.help}</p>

              {c?.secret_ref && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                  <form action={testIntegrationAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="action" value="CHECK" /><Button variant="secondary" className="px-2 py-1 text-xs">Testar agora</Button></form>
                  {key === "TELEGRAM" && <form action={testIntegrationAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="action" value="TELEGRAM_WEBHOOK" /><Button variant="secondary" className="px-2 py-1 text-xs">Registrar webhook</Button></form>}
                  <form action={toggleIntegrationAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="enabled" value={c.status === "DISABLED" ? "1" : "0"} /><Button variant="ghost" className="px-2 py-1 text-xs">{c.status === "DISABLED" ? "Reativar" : "Desativar"}</Button></form>
                  <form action={removeSecretAction}><input type="hidden" name="id" value={c.id} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Remover credencial</Button></form>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <h2 className="mb-2 mt-8 text-sm font-semibold">Canais de atendimento</h2>
      {(channels ?? []).length === 0 ? <Empty title="Nenhum canal cadastrado">Configure a conexão acima e cadastre o número/bot/conta: é ele que liga as mensagens recebidas à caixa de entrada.</Empty> : (
        <Table head={["Canal", "Nome", "Identificador", "Loja", "Conversa nova", "Conexão", "Situação", ""]}>
          {(channels ?? []).map((ch) => {
            const conn = ch.connection_id ? connById.get(ch.connection_id) : undefined;
            const st = conn ? STATUS_LABEL[conn.status] : undefined;
            return (
              <tr key={ch.id} className={ch.status === "ACTIVE" ? "" : "opacity-60"}>
                <td className="px-3 py-2">{ch.channel === "WHATSAPP" ? "WhatsApp" : ch.channel === "INSTAGRAM" ? "Instagram" : ch.channel === "TELEGRAM" ? "Telegram" : ch.channel}</td>
                <td className="px-3 py-2 font-medium">{ch.display_name}</td>
                <td className="px-3 py-2 font-mono text-xs">{ch.provider_account_id}</td>
                <td className="px-3 py-2">{ch.store_id ? storeName.get(ch.store_id) ?? "—" : "—"}</td>
                <td className="px-3 py-2 text-xs">{MODE_LABEL[ch.default_ai_mode] ?? ch.default_ai_mode}</td>
                <td className="px-3 py-2">{conn ? <Badge tone={st?.tone}>{st?.label}</Badge> : <Badge tone="warning">sem conexão: não envia</Badge>}</td>
                <td className="px-3 py-2"><Badge tone={ch.status === "ACTIVE" ? "success" : "neutral"}>{ch.status === "ACTIVE" ? "ativo" : "desativado"}</Badge></td>
                <td className="px-3 py-2"><form action={toggleChannelAction}><input type="hidden" name="id" value={ch.id} /><Button variant="ghost" className="px-2 py-1 text-xs">{ch.status === "ACTIVE" ? "Desativar" : "Reativar"}</Button></form></td>
              </tr>
            );
          })}
        </Table>
      )}
      <Card className="mt-4" title="Novo canal">
        <ChannelForm connections={options} stores={(stores ?? []).map((s) => ({ id: s.id, label: s.name }))} personas={(personas ?? []).map((p) => ({ id: p.id, label: p.name }))} />
      </Card>

      <Card className="mt-4" title="Webhooks (para colar no painel de cada provedor)">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">Meta — WhatsApp e Instagram (URL de callback)</dt>
            <dd className="mt-0.5 break-all font-mono text-xs">{functionsUrl}/webhooks-meta</dd>
            <dd className="mt-1 text-xs text-muted">Token de verificação: o valor do segredo <code>META_VERIFY_TOKEN</code> das Edge Functions. Assine os campos <code>messages</code> (WhatsApp) e <code>messages</code>, <code>comments</code> (Instagram). A assinatura é conferida com o App Secret (<code>META_APP_SECRETS</code>).</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Telegram</dt>
            <dd className="mt-0.5 break-all font-mono text-xs">{functionsUrl}/webhooks-telegram/&lt;ID do bot&gt;</dd>
            <dd className="mt-1 text-xs text-muted">Use o botão “Registrar webhook” no cartão do Telegram: ele chama o <code>setWebhook</code> com o segredo correto.</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted">Canais de IA (Hermes/OpenRouter) e transcrição de áudio usam chaves do servidor (variáveis de ambiente do worker), não esta tela. Se a VPS ficar fora do ar, o Supabase continua recebendo e enfileirando os webhooks.</p>
      </Card>
    </>
  );
}
