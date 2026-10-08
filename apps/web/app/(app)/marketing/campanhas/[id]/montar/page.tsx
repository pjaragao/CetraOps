import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DISPATCH_FILTERS, DISPATCH_STATUS_LABEL, OFFER_MODES, VARIABLE_SOURCES, SKIP_REASON_LABEL, presetByKey, renderTemplate, suggestVariables, templateParts, templatePlaceholders, type AudienceDef, type TemplateComponent } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, PageHeader, Stat } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { AudienceBuilder } from "../../../audience-builder";
import { loadLookups } from "../../../lookups";
import { previewAudienceAction } from "../../../publicos/actions";
import { deleteCampaignAction, deleteDispatchAction, launchCampaignAction, saveAudienceStepAction, saveDispatchAction, saveOfferStepAction } from "../../../actions";

export const metadata = { title: "Montar campanha" };

const STEPS = ["Objetivo", "Público", "Oferta", "Canais", "Revisão"];
const local = (iso: string | null) => (iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace(" ", "T").slice(0, 16) : "");
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }) : "");

interface Check { key: string; ok: boolean; blocking: boolean; message: string }
interface Checklist { items: Check[]; can_launch: boolean; preview: { audience: number; eligible: number; holdout: number; ads: number; excluded: Record<string, number>; sample: string[]; days_needed: number } }
interface Variable { source: string; text?: string }

export default async function MontarPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("crm.write");
  const { id } = await params;
  const sp = await searchParams;
  const passo = Math.min(5, Math.max(2, Number(str(sp.passo)) || 2));
  const supabase = await createClient();
  const { data: c } = await supabase.schema("mkt").from("campaigns").select("*").eq("id", id).maybeSingle();
  if (!c) notFound();
  if (c.status !== "DRAFT") redirect(`/marketing/campanhas/${id}`);
  const preset = presetByKey(str(sp.preset) ?? "");
  const [{ data: offer }, { data: dispatches }, { data: templates }, { data: accounts }, lookups, checkRes] = await Promise.all([
    supabase.schema("mkt").from("campaign_offers").select("*").eq("campaign_id", id).maybeSingle(),
    supabase.schema("mkt").from("campaign_dispatches").select("*").eq("campaign_id", id).neq("status", "CANCELLED").order("seq"),
    supabase.schema("omni").from("templates").select("id, name, category, channel_account_id, components").eq("status", "APPROVED").order("name"),
    supabase.schema("omni").from("channel_accounts").select("id, display_name").eq("channel", "WHATSAPP").eq("status", "ACTIVE"),
    passo === 2 ? loadLookups(supabase) : Promise.resolve(null),
    passo === 5 ? supabase.schema("mkt").rpc("campaign_checklist", { p_id: id }) : Promise.resolve({ data: null }),
  ]);
  const acc = new Map((accounts ?? []).map((a) => [a.id, a.display_name]));
  const mode = offer?.mode ?? "NONE";
  const check = checkRes.data as unknown as Checklist | null;
  const tplId = str(sp.tpl) ?? "";
  const tpl = (templates ?? []).find((t) => t.id === tplId);
  const body = tpl ? templateParts(tpl.components as unknown as TemplateComponent[]).body : "";
  const nVars = tpl ? templatePlaceholders(body).length : 0;
  const sugg = suggestVariables(nVars, mode, !!c.ends_at);
  const canWrite = can(session, "crm.write");

  return (
    <>
      <PageHeader title={c.name} description={`Passo ${passo} de 5 · ${STEPS[passo - 1]}`} actions={<Link href="/marketing/campanhas" className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">Salvar e sair</Link>} />
      <nav aria-label="Passos" className="mb-4 flex flex-wrap gap-2">
        {STEPS.map((s, i) => (i === 0 ? <Badge key={s} tone="success">1 · {s}</Badge> : <Link key={s} href={`/marketing/campanhas/${id}/montar?passo=${i + 1}`}><Badge tone={i + 1 === passo ? "brand" : "neutral"}>{i + 1} · {s}</Badge></Link>))}
      </nav>
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      {passo === 2 && lookups && (
        <form action={saveAudienceStepAction} className="space-y-4">
          <input type="hidden" name="id" value={id} />
          <Card title="Quem participa">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Onde alcançar" hint="Base local = WhatsApp; Meta = anúncios"><select name="audience_scope" defaultValue={c.audience_scope} className={inputClass}><option value="LOCAL">Base local (WhatsApp)</option><option value="META">Meta (anúncios)</option><option value="BOTH">Os dois</option></select></Field>
              <Field label="Grupo de controle (%)" hint={`Quem não recebe, para medir o efeito real. Padrão do modelo: ${preset.holdout_pct}%`}><input name="holdout_pct" type="number" min={0} max={50} defaultValue={c.holdout_pct} className={inputClass} /></Field>
              <Field label="Janela de atribuição (dias)" hint="WhatsApp: 7 · anúncio: 14"><input name="attribution_days" type="number" min={1} max={60} defaultValue={c.attribution_days} className={inputClass} /></Field>
            </div>
          </Card>
          <AudienceBuilder def={(c.audience ?? {}) as unknown as AudienceDef} lookups={lookups} previewAction={previewAudienceAction} />
          <Field label="Salvar estes filtros como público (opcional)"><input name="save_as" maxLength={80} className={inputClass} placeholder="Nome do público" /></Field>
          <div className="flex gap-2"><Button>Salvar e continuar</Button></div>
        </form>
      )}

      {passo === 3 && (
        <form action={saveOfferStepAction} className="space-y-4">
          <input type="hidden" name="id" value={id} />
          <Card title="Oferta">
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.entries(OFFER_MODES).map(([k, v]) => (
                <label key={k} className="flex gap-2 rounded-lg border border-border p-3 text-sm"><input type="radio" name="mode" value={k} defaultChecked={mode === k} /><span><span className="font-medium">{v.label}</span><span className="block text-xs text-muted">{v.hint}</span></span></label>
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <Field label="Tipo"><select name="kind" defaultValue={offer?.kind ?? "PERCENT"} className={inputClass}><option value="PERCENT">Porcentagem</option><option value="AMOUNT">Valor (R$)</option></select></Field>
              <Field label="Desconto"><input name="value" type="number" step="0.01" min={0} defaultValue={offer?.value ?? ""} className={inputClass} /></Field>
              <Field label="Pedido mínimo (R$)"><input name="min_order" type="number" step="0.01" min={0} defaultValue={offer?.min_order ?? ""} className={inputClass} /></Field>
              <Field label="Usos por cliente"><input name="per_customer_limit" type="number" min={1} defaultValue={offer?.per_customer_limit ?? ""} className={inputClass} /></Field>
              <Field label="Código único" hint="Só para “código único”"><input name="code" defaultValue={offer?.code ?? ""} className={inputClass} placeholder="OUTONO10" /></Field>
              <Field label="Máx. de usos" hint="Código único"><input name="max_uses" type="number" min={1} defaultValue={offer?.max_uses ?? ""} className={inputClass} /></Field>
              <Field label="Prefixo do cupom pessoal" hint="Ex.: VOLTA-ANA4X"><input name="code_prefix" defaultValue={offer?.code_prefix ?? ""} className={inputClass} placeholder="VOLTA" /></Field>
              <Field label="Validade do cupom pessoal (dias)"><input name="valid_days" type="number" min={1} defaultValue={offer?.valid_days ?? ""} className={inputClass} /></Field>
            </div>
          </Card>
          <Card title="Período e página">
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Nome"><input name="name" required minLength={3} maxLength={120} defaultValue={c.name} className={inputClass} /></Field>
              <Field label="Início (vazio = ao lançar)"><input name="starts_at" type="datetime-local" defaultValue={local(c.starts_at)} className={inputClass} /></Field>
              <Field label="Fim"><input name="ends_at" type="datetime-local" defaultValue={local(c.ends_at)} className={inputClass} /></Field>
              <Field label="Orçamento (R$)"><input name="budget" type="number" step="0.01" min={0} defaultValue={c.budget ?? ""} className={inputClass} /></Field>
              <Field label="Página da campanha (opcional)" hint="Vira a variável “link” e um link rastreado"><input name="landing_url" type="url" defaultValue={c.landing_url ?? ""} className={inputClass} placeholder="https://" /></Field>
              <Field label="Valid. do código único até"><input name="valid_to" type="date" defaultValue={day(offer?.valid_to ?? null)} className={inputClass} /></Field>
            </div>
          </Card>
          <Button>Salvar e continuar</Button>
        </form>
      )}

      {passo === 4 && (
        <div className="space-y-4">
          <Card title="WhatsApp">
            {(dispatches ?? []).length === 0 ? <p className="text-sm text-muted">Nenhum disparo ainda. Adicione o disparo principal e, se quiser, um lembrete.</p> : (
              <ul className="divide-y divide-border text-sm">
                {(dispatches ?? []).map((d) => {
                  const st = DISPATCH_STATUS_LABEL[d.status];
                  return (
                    <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                      <span>{d.filter === "ALL" ? "Disparo principal" : `Lembrete · ${DISPATCH_FILTERS[d.filter]}`} <span className="text-xs text-muted">· {acc.get(d.channel_account_id)} · {d.scheduled_at ? new Date(d.scheduled_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "ao lançar"}</span> <Badge tone={st.tone}>{st.label}</Badge></span>
                      {canWrite && <form action={deleteDispatchAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="dispatch_id" value={d.id} /><Button variant="ghost" className="text-danger">Remover</Button></form>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card title="Adicionar disparo ou lembrete">
            <form method="get" className="mb-3 flex flex-wrap items-end gap-2">
              <input type="hidden" name="passo" value="4" />
              <Field label="Template aprovado"><select name="tpl" defaultValue={tplId} className={inputClass}><option value="">Escolha…</option>{(templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} · {acc.get(t.channel_account_id)}</option>)}</select></Field>
              <Button variant="secondary">Usar</Button>
            </form>
            {tpl && (
              <form action={saveDispatchAction} className="space-y-3">
                <input type="hidden" name="id" value={id} /><input type="hidden" name="template_id" value={tpl.id} /><input type="hidden" name="channel_account_id" value={tpl.channel_account_id} /><input type="hidden" name="var_count" value={nVars} />
                <p className="max-w-md whitespace-pre-line rounded-2xl rounded-tl-sm bg-surface-2 px-3 py-2 text-sm">{renderTemplate(body, sugg.map((v) => (v.source === "TEXT" ? "…" : VARIABLE_SOURCES[v.source]?.sample ?? "…")))}</p>
                {nVars > 0 && (
                  <fieldset className="grid gap-3 sm:grid-cols-2"><legend className="mb-1 text-xs font-medium text-muted">Variáveis</legend>
                    {Array.from({ length: nVars }, (_, i) => (
                      <div key={i} className="flex gap-2"><span className="self-center text-xs text-muted">{`{{${i + 1}}}`}</span>
                        <select name={`var_${i}_source`} defaultValue={(sugg[i] as Variable).source} className={inputClass} aria-label={`Variável ${i + 1}`}>{Object.entries(VARIABLE_SOURCES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
                        <input name={`var_${i}_text`} placeholder="se texto fixo" className={inputClass} />
                      </div>
                    ))}
                  </fieldset>
                )}
                <div className="grid gap-3 sm:grid-cols-4">
                  <Field label="Quem recebe"><select name="filter" defaultValue={(dispatches ?? []).some((d) => d.filter === "ALL") ? "NOT_BOUGHT" : "ALL"} className={inputClass}>{Object.entries(DISPATCH_FILTERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                  <Field label="Enviar em" hint="Lembrete: 24 h ou mais após o principal"><input name="scheduled_at" type="datetime-local" className={inputClass} /></Field>
                  <Field label="Intervalo entre marketing (dias)"><input name="frequency_cap_days" type="number" min={0} max={90} defaultValue={7} className={inputClass} /></Field>
                  <Field label="Limite por dia"><input name="daily_limit" type="number" min={1} max={10000} defaultValue={250} className={inputClass} /></Field>
                </div>
                <Button>Salvar disparo</Button>
              </form>
            )}
          </Card>
          <Card title="Links, QR e anúncios">
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
              <li>Ao lançar, o sistema cria sozinho os links <span className="font-mono">{c.code}-story</span>, <span className="font-mono">-bio</span> e <span className="font-mono">-qr</span>{mode === "AFFILIATE" ? " e um link por afiliada" : ""}, com contagem de cliques.</li>
              <li>Para ligar anúncios da Meta, coloque <span className="font-mono">[c:{c.code}]</span> no nome da campanha na Meta.</li>
              {c.audience_scope !== "LOCAL" && <li>O público segue para a Meta ao lançar (só quem aceitou receber anúncios).</li>}
            </ul>
          </Card>
          <Link href={`/marketing/campanhas/${id}/montar?passo=5`} className="inline-flex rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-contrast hover:opacity-90">Continuar para a revisão</Link>
        </div>
      )}

      {passo === 5 && check && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="No público" value={check.preview.audience} />
            <Stat label="Recebem no WhatsApp" value={check.preview.eligible} tone={check.preview.eligible > 0 ? "success" : "warning"} hint={check.preview.eligible ? `~${check.preview.days_needed} dia(s) de envio` : undefined} />
            <Stat label="Grupo de controle" value={check.preview.holdout} hint={`${c.holdout_pct}%`} />
            <Stat label="Podem ir para a Meta" value={check.preview.ads} />
          </div>
          <Card title="Antes de lançar">
            <ul className="space-y-1 text-sm">
              {check.items.map((i) => <li key={i.key} className={i.ok ? "text-success" : i.blocking ? "text-danger" : "text-warning"}>{i.ok ? "✓" : i.blocking ? "✕" : "!"} {i.ok && i.key.startsWith("public_address") ? "Número público do WhatsApp configurado" : i.message}</li>)}
            </ul>
            {Object.keys(check.preview.excluded).length > 0 && <ul className="mt-2 text-xs text-muted">{Object.entries(check.preview.excluded).map(([k, n]) => <li key={k}>{n} · {SKIP_REASON_LABEL[k] ?? k}</li>)}</ul>}
            {check.preview.sample.length > 0 && <p className="mt-2 text-xs text-muted">Exemplo de quem recebe: {check.preview.sample.join(", ")}</p>}
          </Card>
          <div className="flex flex-wrap gap-2">
            <form action={launchCampaignAction}><input type="hidden" name="id" value={id} /><Button disabled={!check.can_launch}>Lançar campanha</Button></form>
            <form action={deleteCampaignAction}><input type="hidden" name="id" value={id} /><Button variant="ghost" className="text-danger">Excluir rascunho</Button></form>
          </div>
        </div>
      )}
    </>
  );
}
