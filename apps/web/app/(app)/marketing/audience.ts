import type { AudienceDef } from "@centralops/domain";

const s = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const words = (v: FormDataEntryValue | null) => s(v).split(/[,\n;]/).map((x) => x.trim()).filter(Boolean);
const tri = (v: FormDataEntryValue | null): boolean | undefined => (s(v) === "1" ? true : s(v) === "0" ? false : undefined);
const num = (v: FormDataEntryValue | null): number | undefined => { const t = s(v).replace(",", "."); if (!t) return undefined; const n = Number(t); return Number.isFinite(n) ? n : undefined; };

/** Lê os campos do construtor de público (nomes iguais aos de crm.audience; a exclusão usa o prefixo ex_). Campo vazio não vira filtro. */
export function audienceFromForm(fd: FormData): AudienceDef {
  const d: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => { if (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== "") d[k] = v; };
  const all = (k: string) => fd.getAll(k).map(String).filter(Boolean);
  for (const k of ["lifecycle", "tiers", "rsvp", "deal_status", "bought_categories", "bought_collections", "link_ids", "affiliate_ids", "received_campaigns", "not_received_campaigns"]) put(k, all(k));
  for (const k of ["cities", "tags", "sources", "bought_sizes", "lost_reasons", "ad_ids"]) put(k, words(fd.get(k)));
  for (const k of ["min_score", "inactive_days", "inactive_max_days", "birthday_month", "bought_within_days", "period_days", "orders_min", "orders_max", "spent_min", "spent_max", "ticket_min",
                   "bought_period_days", "created_within_days", "created_older_than_days", "no_marketing_days", "replied_within_days"]) put(k, num(fd.get(k)));
  for (const k of ["never_bought", "any_link", "from_ads", "referred", "has_active_coupon", "reachable_whatsapp", "has_email", "ads_consent"]) put(k, tri(fd.get(k)));
  put("event_id", s(fd.get("event_id")));
  put("segment_id", s(fd.get("segment_id")));
  const ex: Record<string, unknown> = {};
  const putEx = (k: string, v: unknown) => { if (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== "") ex[k] = v; };
  putEx("lifecycle", all("ex_lifecycle")); putEx("tiers", all("ex_tiers")); putEx("tags", words(fd.get("ex_tags"))); putEx("received_campaigns", all("ex_received_campaigns"));
  putEx("bought_within_days", num(fd.get("ex_bought_within_days"))); putEx("segment_id", s(fd.get("ex_segment_id"))); putEx("has_active_coupon", tri(fd.get("ex_has_active_coupon")));
  if (Object.keys(ex).length) d.exclude = ex;
  return d as AudienceDef;
}

export interface AudiencePreview {
  total: number; whatsapp: number; no_phone: number; no_consent: number; ads: number; email: number; by_stage: Record<string, number>; by_tier: Record<string, number>; sample: string[]; capped: boolean;
}
export interface AudienceLookups {
  events: { id: string; name: string }[]; categories: { id: string; name: string }[]; collections: { id: string; name: string }[]; links: { id: string; name: string }[];
  affiliates: { id: string; name: string }[]; campaigns: { id: string; name: string }[]; segments: { id: string; name: string }[];
}
