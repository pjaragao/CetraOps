import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL, renderTemplate, templateParts, templatePlaceholders, type TemplateComponent } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge, Button, Card, inputClass, PageHeader, Stat } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { cancelCampaignAction, deleteCampaignAction, launchCampaignAction, saveCampaignAction } from "../../actions";
import { CAMPAIGN_STATUS } from "../../campaign-status";

export const metadata = { title: "Campanha" };

const LIFECYCLE: Record<string, string> = { LEAD: "Lead", PROSPECT: "Prospect", CUSTOMER: "Cliente", VIP: "VIP", INACTIVE: "Inativa" };
const TIERS: Record<string, string> = { STANDARD: "Padrão", VIP: "VIP", VIP_BLACK: "VIP black" };
const RSVP: Record<string, string> = { INVITED: "convidada", CONFIRMED: "confirmada", ATTENDED: "compareceu", WAITLIST: "lista de espera", DECLINED: "recusou", NO_SHOW: "não veio" };
const REASON: Record<string, string> = { NO_CONSENT: "sem consentimento de marketing no WhatsApp", NO_PHONE: "sem telefone", FREQUENCY_CAP: "já recebeu marketing há pouco", TEMPLATE_NOT_APPROVED: "template deixou de estar aprovado", IDENTITY_CONFLICT: "número ligado a outra pessoa", CAMPAIGN_CANCELLED: "campanha cancelada" };
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const local = (iso: string | null) => (iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace(" ", "T").slice(0, 16) : "");

interface Audience { lifecycle?: string[]; tiers?: string[]; min_score?: number; inactive_days?: number; birthday_month?: number; cities?: string[]; tags?: string[]; event_id?: string; rsvp?: string[] }
interface Preview { audience: number; eligible: number; excluded: Record<string, number>; sample: string[]; days_needed: number }
interface Results { recipients: Record<string, number>; skipped: Record<string, number>; delivered: number; read: number; replied: number; buyers: number; orders: number; revenue: number }
interface Variable { source: string; text?: string }

export default async function CampanhaPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const { id } = await params;
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const supabase = await createClient();
  const { data: c } = await supabase.schema("mkt").from("campaigns").select("*").eq("id", id).maybeSingle();
  if (!c) notFound();
  const draft = c.status === "DRAFT";
  const [{ data: tpl }, { data: acc }, { data: events }, previewRes, resultsRes] = await Promise.all([
    supabase.schema("omni").from("templates").select("id, name, category, components").eq("id", c.template_id).maybeSingle(),
    supabase.schema("omni").from("channel_accounts").select("display_name").eq("id", c.channel_account_id).maybeSingle(),
    supabase.schema("mkt").from("events").select("id, name, starts_at").order("starts_at", { ascending: false }).limit(50),
    draft ? supabase.schema("mkt").rpc("campaign_preview", { p_id: id }) : Promise.resolve({ data: null }),
    draft ? Promise.resolve({ data: null }) : supabase.schema("mkt").rpc("campaign_results", { p_id: id }),
  ]);
  const body = templateParts((tpl?.components ?? []) as unknown as TemplateComponent[]).body;
  const nVars = templatePlaceholders(body).length;
  const vars = (c.variables ?? []) as unknown as Variable[];
  const aud = (c.audience ?? {}) as Audience;
  const preview = previewRes.data as unknown as Preview | null;
  const results = resultsRes.data as unknown as Results | null;
  const sample = preview?.sample?.[0]?.split(" ")[0] ?? "Ana";
  const rendered = renderTemplate(body, vars.map((v) => (v.source === "FIRST_NAME" ? sample : v.source === "FULL_NAME" ? `${sample} Souza` : v.text ?? "…")));
  const st = CAMPAIGN_STATUS[c.status];
  const r = results?.recipients ?? {};
  const total = Object.values(r).reduce((a, b) => a + b, 0);
  const skipped = r.SKIPPED ?? 0;
  const sent = (r.QUEUED ?? 0) + (r.SENT ?? 0);

  return (
    <>
      <PageHeader title={c.name} description={`${acc?.display_name ?? ""} · template ${tpl?.name ?? "—"}`} actions={<div className="flex items-center gap-2"><Badge tone={st.tone}>{st.label}</Badge><Link href="/marketing" className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Campanhas</Link></div>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(c.status === "SENDING" || str(sp.wait)) && <AutoRefresh />}

      <Card title="Mensagem" className="mb-4">
        <p className="max-w-md whitespace-pre-line rounded-2xl rounded-tl-sm bg-surface-2 px-3 py-2 text-sm">{rendered}</p>
        {tpl?.category !== "MARKETING" && <p className="mt-2 text-xs text-warning">Este template é de utilidade: confira se a campanha realmente não é promocional (a Meta pode reclassificar).</p>}
      </Card>

      {!draft && results && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Enviadas" value={`${sent} de ${total - skipped}`} hint={skipped ? `${skipped} ficaram de fora` : undefined} />
            <Stat label="Entregues" value={results.delivered} hint={`${results.read} leram`} />
            <Stat label="Responderam (72 h)" value={results.replied} />
            <Stat label="Compraram (7 dias)" value={results.buyers} hint={`${results.orders} pedido(s)`} />
            <Stat label="Vendas" value={formatBRL(results.revenue)} tone={results.revenue > 0 ? "success" : undefined} />
          </div>
          {Object.keys(results.skipped).length > 0 && (
            <Card title="Quem ficou de fora" className="mb-4">
              <ul className="text-sm">{Object.entries(results.skipped).map(([k, n]) => <li key={k}>{n} · {REASON[k] ?? k}</li>)}</ul>
            </Card>
          )}
          {canWrite && (c.status === "SENDING" || c.status === "SCHEDULED") && (
            <form action={cancelCampaignAction} className="mb-4"><input type="hidden" name="id" value={id} /><Button variant="ghost" className="text-danger">Cancelar campanha (quem ainda não recebeu não receberá)</Button></form>
          )}
        </>
      )}

      {draft && (
        <>
          {preview && (
            <Card title="Prévia do público" className="mb-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="No público" value={preview.audience} />
                <Stat label="Podem receber" value={preview.eligible} tone={preview.eligible > 0 ? "success" : "warning"} hint={preview.eligible ? `Levaria ${preview.days_needed} dia(s) com o limite de ${c.daily_limit}/dia` : undefined} />
                <Stat label="Ficam de fora" value={preview.audience - preview.eligible} />
              </div>
              {Object.keys(preview.excluded).length > 0 && <ul className="mt-2 text-xs text-muted">{Object.entries(preview.excluded).map(([k, n]) => <li key={k}>{n} · {REASON[k] ?? k}</li>)}</ul>}
              {preview.sample.length > 0 && <p className="mt-2 text-xs text-muted">Exemplo de quem recebe: {preview.sample.join(", ")}</p>}
            </Card>
          )}
          {canWrite && (
            <Card title="Definir campanha" className="mb-4">
              <form action={saveCampaignAction} className="space-y-4">
                <input type="hidden" name="id" value={id} /><input type="hidden" name="channel_account_id" value={c.channel_account_id} /><input type="hidden" name="template_id" value={c.template_id} /><input type="hidden" name="var_count" value={nVars} />
                <Field label="Nome"><input name="name" required minLength={3} maxLength={120} defaultValue={c.name} className={inputClass} /></Field>
                {nVars > 0 && (
                  <fieldset className="grid gap-3 sm:grid-cols-2"><legend className="mb-1 text-xs font-medium text-muted">Variáveis do template</legend>
                    {Array.from({ length: nVars }, (_, i) => (
                      <div key={i} className="flex gap-2"><span className="self-center text-xs text-muted">{`{{${i + 1}}}`}</span>
                        <select name={`var_${i}_source`} defaultValue={vars[i]?.source ?? "FIRST_NAME"} className={inputClass} aria-label={`Variável ${i + 1}`}><option value="FIRST_NAME">Primeiro nome da pessoa</option><option value="FULL_NAME">Nome completo</option><option value="TEXT">Texto fixo</option></select>
                        <input name={`var_${i}_text`} defaultValue={vars[i]?.text ?? ""} maxLength={200} className={inputClass} placeholder="Texto fixo" aria-label={`Texto da variável ${i + 1}`} />
                      </div>))}
                  </fieldset>
                )}
                <fieldset className="space-y-3"><legend className="mb-1 text-xs font-medium text-muted">Público (fornecedoras, funcionárias e prestadoras nunca entram)</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">{Object.entries(LIFECYCLE).map(([k, v]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" name="lifecycle" value={k} defaultChecked={aud.lifecycle?.includes(k)} /> {v}</label>)}</div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">{Object.entries(TIERS).map(([k, v]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" name="tiers" value={k} defaultChecked={aud.tiers?.includes(k)} /> {v}</label>)}</div>
                  <div className="grid gap-3 sm:grid-cols-4">
                    <Field label="Pontuação mínima"><input name="min_score" type="number" min={0} max={100} defaultValue={aud.min_score ?? ""} className={inputClass} /></Field>
                    <Field label="Sem comprar há (dias)"><input name="inactive_days" type="number" min={1} defaultValue={aud.inactive_days ?? ""} className={inputClass} /></Field>
                    <Field label="Aniversário em"><select name="birthday_month" defaultValue={aud.birthday_month ?? ""} className={inputClass}><option value="">—</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Field>
                    <Field label="Cidades" hint="Separadas por vírgula"><input name="cities" defaultValue={(aud.cities ?? []).join(", ")} className={inputClass} /></Field>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Etiquetas" hint="Separadas por vírgula"><input name="tags" defaultValue={(aud.tags ?? []).join(", ")} className={inputClass} /></Field>
                    <Field label="Convidadas de um evento"><select name="event_id" defaultValue={aud.event_id ?? ""} className={inputClass}><option value="">—</option>{(events ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm"><span className="text-xs text-muted">Só quem estiver como:</span>{Object.entries(RSVP).map(([k, v]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" name="rsvp" value={k} defaultChecked={aud.rsvp?.includes(k)} /> {v}</label>)}</div>
                </fieldset>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Intervalo entre mensagens de marketing (dias)" hint="Não manda de novo antes disso"><input name="frequency_cap_days" type="number" min={0} max={90} defaultValue={c.frequency_cap_days} className={inputClass} /></Field>
                  <Field label="Limite por dia neste número" hint="Faixa da Meta: números novos começam com 250"><input name="daily_limit" type="number" min={1} max={10000} defaultValue={c.daily_limit} className={inputClass} /></Field>
                  <Field label="Enviar em (vazio = agora)"><input name="scheduled_at" type="datetime-local" defaultValue={local(c.scheduled_at)} className={inputClass} /></Field>
                </div>
                <Button variant="secondary">Salvar rascunho</Button>
              </form>
            </Card>
          )}
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              <form action={launchCampaignAction}><input type="hidden" name="id" value={id} /><Button disabled={!preview || preview.eligible === 0}>Lançar campanha</Button></form>
              <form action={deleteCampaignAction}><input type="hidden" name="id" value={id} /><Button variant="ghost" className="text-danger">Excluir rascunho</Button></form>
              <p className="self-center text-xs text-muted">Salve as mudanças antes de lançar: a prévia mostra o último rascunho salvo.</p>
            </div>
          )}
        </>
      )}
    </>
  );
}
