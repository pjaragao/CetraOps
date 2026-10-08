"use client";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { describeAudience, type AudienceDef } from "@centralops/domain";
import { Badge, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { audienceFromForm, type AudienceLookups, type AudiencePreview } from "./audience";

const LIFECYCLE: Record<string, string> = { LEAD: "Lead", PROSPECT: "Prospect", CUSTOMER: "Cliente", VIP: "VIP", INACTIVE: "Inativa", LOST: "Perdida" };
const TIERS: Record<string, string> = { STANDARD: "Padrão", VIP: "VIP", VIP_BLACK: "VIP black" };
const RSVP: Record<string, string> = { INVITED: "convidada", CONFIRMED: "confirmada", ATTENDED: "compareceu", WAITLIST: "lista de espera", DECLINED: "recusou", NO_SHOW: "não veio" };
const DEAL: Record<string, string> = { OPEN: "em negociação", WON: "ganho", LOST: "perdido" };
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

type Preview = AudiencePreview | { error: string };

const Checks = ({ name, options, value }: { name: string; options: Record<string, string>; value?: string[] }) => (
  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
    {Object.entries(options).map(([k, v]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" name={name} value={k} defaultChecked={value?.includes(k)} /> {v}</label>)}
  </div>
);
const Tri = ({ name, label, value, hint, yes = "Sim", no = "Não" }: { name: string; label: string; value?: boolean; hint?: string; yes?: string; no?: string }) => (
  <Field label={label} hint={hint}><select name={name} defaultValue={value === undefined ? "" : value ? "1" : "0"} className={inputClass}><option value="">—</option><option value="1">{yes}</option><option value="0">{no}</option></select></Field>
);
const Num = ({ name, label, value, hint, step }: { name: string; label: string; value?: number; hint?: string; step?: string }) => (
  <Field label={label} hint={hint}><input name={name} type="number" min={0} step={step} defaultValue={value ?? ""} className={inputClass} /></Field>
);
const Multi = ({ name, label, options, value }: { name: string; label: string; options: { id: string; name: string }[]; value?: string[] }) => (
  <Field label={label} hint="Segure Ctrl (ou ⌘) para escolher mais de um">
    <select name={name} multiple defaultValue={value ?? []} size={Math.min(5, Math.max(3, options.length))} className={inputClass}>{options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
  </Field>
);
const Section = ({ title, hint, open, children }: { title: string; hint?: string; open?: boolean; children: React.ReactNode }) => (
  <details open={open} className="rounded-lg border border-border">
    <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">{title}{hint && <span className="ml-2 text-xs font-normal text-muted">{hint}</span>}</summary>
    <div className="space-y-3 border-t border-border p-3">{children}</div>
  </details>
);

/**
 * Construtor de público: todos os filtros que o banco entende, com a contagem ao vivo (quantas pessoas, quantas dá para alcançar no WhatsApp e na Meta).
 * Vive dentro de um <form>: os campos são lidos pela ação do servidor (audienceFromForm). `previewAction` recebe o mesmo FormData.
 */
export function AudienceBuilder({ def, lookups, previewAction, hideSaved }: { def: AudienceDef; lookups: AudienceLookups; previewAction: (fd: FormData) => Promise<Preview>; hideSaved?: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<string[]>(() => describeAudience(def));
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ex = def.exclude ?? {};

  const run = useCallback(() => {
    const form = root.current?.closest("form");
    if (!form) return;
    const fd = new FormData(form);
    setSummary(describeAudience(audienceFromForm(fd)));
    start(async () => setPreview(await previewAction(fd)));
  }, [previewAction]);
  const schedule = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(run, 700); }, [run]);
  useEffect(() => { const t = setTimeout(run, 0); return () => { clearTimeout(t); if (timer.current) clearTimeout(timer.current); }; }, [run]);
  const segments = lookups.segments.filter((s) => s.id !== hideSaved);

  return (
    <div ref={root} onChange={schedule} className="space-y-3">
      <Section title="Quem é" open>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2"><span className="text-xs text-muted">Etapa</span><Checks name="lifecycle" options={LIFECYCLE} value={def.lifecycle} /></div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2"><span className="text-xs text-muted">Nível</span><Checks name="tiers" options={TIERS} value={def.tiers} /></div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Num name="min_score" label="Pontuação mínima" value={def.min_score} />
          <Field label="Aniversário em"><select name="birthday_month" defaultValue={def.birthday_month ?? ""} className={inputClass}><option value="">—</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Field>
          <Field label="Cidades" hint="Separadas por vírgula"><input name="cities" defaultValue={(def.cities ?? []).join(", ")} className={inputClass} /></Field>
          <Field label="Etiquetas" hint="Separadas por vírgula"><input name="tags" defaultValue={(def.tags ?? []).join(", ")} className={inputClass} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Convidadas de um evento"><select name="event_id" defaultValue={def.event_id ?? ""} className={inputClass}><option value="">—</option>{lookups.events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
          <div className="sm:col-span-2"><span className="text-xs text-muted">Só quem estiver como</span><div className="mt-2"><Checks name="rsvp" options={RSVP} value={def.rsvp} /></div></div>
        </div>
        {segments.length > 0 && <Field label="Dentro de um público salvo" hint="Combina com os outros filtros"><select name="segment_id" defaultValue={def.segment_id ?? ""} className={inputClass}><option value="">—</option>{segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
      </Section>

      <Section title="Compras" hint="quanto, quando e o quê">
        <div className="grid gap-3 sm:grid-cols-4">
          <Tri name="never_bought" label="Compras" value={def.never_bought} yes="Nunca comprou" no="Já comprou" />
          <Num name="bought_within_days" label="Comprou nos últimos (dias)" value={def.bought_within_days} />
          <Num name="inactive_days" label="Sem comprar há mais de (dias)" value={def.inactive_days} />
          <Num name="inactive_max_days" label="…mas comprou há até (dias)" value={def.inactive_max_days} hint="Faixa: 60 a 180 dias sem comprar" />
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Num name="orders_min" label="Pedidos (mín.)" value={def.orders_min} />
          <Num name="orders_max" label="Pedidos (máx.)" value={def.orders_max} />
          <Num name="spent_min" label="Gastou (mín. R$)" value={def.spent_min} />
          <Num name="spent_max" label="Gastou (máx. R$)" value={def.spent_max} />
          <Num name="ticket_min" label="Ticket médio (mín. R$)" value={def.ticket_min} />
          <Num name="period_days" label="Período de pedidos e gasto (dias)" value={def.period_days} hint="Vazio = desde sempre" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Multi name="bought_categories" label="Comprou da categoria" options={lookups.categories} value={def.bought_categories} />
          <Multi name="bought_collections" label="Comprou da coleção" options={lookups.collections} value={def.bought_collections} />
          <div className="space-y-3">
            <Field label="Comprou tamanho" hint="Ex.: P, M, 38"><input name="bought_sizes" defaultValue={(def.bought_sizes ?? []).join(", ")} className={inputClass} /></Field>
            <Num name="bought_period_days" label="…nos últimos (dias)" value={def.bought_period_days} />
          </div>
        </div>
      </Section>

      <Section title="Leads e origem">
        <div className="grid gap-3 sm:grid-cols-4">
          <Num name="created_within_days" label="Entrou há até (dias)" value={def.created_within_days} />
          <Num name="created_older_than_days" label="Entrou há mais de (dias)" value={def.created_older_than_days} />
          <Field label="Origem" hint="Ex.: instagram, importacao"><input name="sources" defaultValue={(def.sources ?? []).join(", ")} className={inputClass} /></Field>
          <Tri name="from_ads" label="Chegou por anúncio?" value={def.from_ads} />
          <Tri name="any_link" label="Chegou por link ou QR?" value={def.any_link} />
          <Tri name="referred" label="Veio por indicação/afiliada?" value={def.referred} />
          <Multi name="link_ids" label="Link ou QR específico" options={lookups.links} value={def.link_ids} />
          <Multi name="affiliate_ids" label="Indicada por" options={lookups.affiliates} value={def.affiliate_ids} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><span className="text-xs text-muted">Negócio no funil</span><div className="mt-2"><Checks name="deal_status" options={DEAL} value={def.deal_status} /></div></div>
          <Field label="Motivo da perda" hint="Separados por vírgula"><input name="lost_reasons" defaultValue={(def.lost_reasons ?? []).join(", ")} className={inputClass} /></Field>
        </div>
      </Section>

      <Section title="Relacionamento e canal">
        <div className="grid gap-3 sm:grid-cols-4">
          <Tri name="has_active_coupon" label="Tem cupom ativo sem usar?" value={def.has_active_coupon} />
          <Num name="no_marketing_days" label="Sem marketing há (dias)" value={def.no_marketing_days} />
          <Num name="replied_within_days" label="Respondeu nos últimos (dias)" value={def.replied_within_days} />
          <Tri name="reachable_whatsapp" label="Alcançável no WhatsApp?" value={def.reachable_whatsapp} hint="telefone + aceite" />
          <Tri name="has_email" label="Tem e-mail?" value={def.has_email} />
          <Tri name="ads_consent" label="Aceitou receber anúncios?" value={def.ads_consent} />
          <Multi name="received_campaigns" label="Recebeu a campanha" options={lookups.campaigns} value={def.received_campaigns} />
          <Multi name="not_received_campaigns" label="Não recebeu a campanha" options={lookups.campaigns} value={def.not_received_campaigns} />
        </div>
      </Section>

      <Section title="Menos quem…" hint="tira do público quem se encaixa">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2"><span className="text-xs text-muted">Etapa</span><Checks name="ex_lifecycle" options={LIFECYCLE} value={ex.lifecycle} /></div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2"><span className="text-xs text-muted">Nível</span><Checks name="ex_tiers" options={TIERS} value={ex.tiers} /></div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Num name="ex_bought_within_days" label="Comprou nos últimos (dias)" value={ex.bought_within_days} />
          <Field label="Etiquetas" hint="Separadas por vírgula"><input name="ex_tags" defaultValue={(ex.tags ?? []).join(", ")} className={inputClass} /></Field>
          <Tri name="ex_has_active_coupon" label="Tem cupom ativo?" value={ex.has_active_coupon} />
          <Field label="Público salvo"><select name="ex_segment_id" defaultValue={ex.segment_id ?? ""} className={inputClass}><option value="">—</option>{segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Multi name="ex_received_campaigns" label="Recebeu a campanha" options={lookups.campaigns} value={ex.received_campaigns} />
        </div>
      </Section>

      <div className="rounded-lg border border-border bg-surface-2/50 p-3" aria-live="polite">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Quem entra</span>
          {pending && <span className="text-xs text-muted">contando…</span>}
        </div>
        {summary.length > 0 ? <p className="mt-1 text-xs text-muted">{summary.join(" · ")}</p> : <p className="mt-1 text-xs text-muted">Sem filtros: todas as pessoas elegíveis (fornecedoras, funcionárias e prestadoras nunca entram).</p>}
        {preview && "error" in preview && <p role="alert" className="mt-2 text-sm text-danger">{preview.error}</p>}
        {preview && !("error" in preview) && (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-2">
              <Badge tone="brand">{preview.total}{preview.capped ? "+" : ""} pessoa(s)</Badge>
              <Badge tone={preview.whatsapp > 0 ? "success" : "warning"}>{preview.whatsapp} alcançáveis no WhatsApp</Badge>
              {preview.no_consent > 0 && <Badge>{preview.no_consent} sem aceite de marketing</Badge>}
              {preview.no_phone > 0 && <Badge>{preview.no_phone} sem telefone</Badge>}
              <Badge tone={preview.ads > 0 ? "info" : "neutral"}>{preview.ads} podem ir para a Meta</Badge>
            </div>
            {preview.sample.length > 0 && <p className="text-xs text-muted">Exemplo: {preview.sample.join(", ")}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
