import Link from "next/link";
import { CAMPAIGN_STATUS_LABEL, OBJECTIVE_LABEL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Empty, PageHeader, Table } from "@/components/ui";
import { Flash } from "@/components/form";

export const metadata = { title: "Campanhas" };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" }) : "—");

export default async function CampanhasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const supabase = await createClient();
  const [{ data: campaigns }, { data: progress }, { data: segments }] = await Promise.all([
    supabase.schema("mkt").from("campaigns").select("id, name, status, objective, starts_at, ends_at, segment_id, audience_scope, code").order("created_at", { ascending: false }).limit(100),
    supabase.schema("mkt").rpc("campaign_progress"),
    supabase.schema("mkt").from("segments").select("id, name"),
  ]);
  const prog = new Map((progress ?? []).map((p) => [p.campaign_id, p]));
  const seg = new Map((segments ?? []).map((s) => [s.id, s.name]));

  return (
    <>
      <PageHeader title="Campanhas" description="Cada campanha reúne público, oferta (cupom), canais (WhatsApp, links, anúncios) e o resultado com grupo de controle."
        actions={canWrite ? <Link href="/marketing/campanhas/nova" className="inline-flex items-center rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-contrast hover:opacity-90">Nova campanha</Link> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(campaigns ?? []).length === 0 ? <Empty title="Nenhuma campanha ainda">Use “Nova campanha”: o assistente leva do objetivo ao lançamento em 5 passos.</Empty> : (
        <Table head={["Campanha", "Objetivo", "Período", "Público", "Situação", "Envio", ""]}>
          {(campaigns ?? []).map((c) => {
            const st = CAMPAIGN_STATUS_LABEL[c.status] ?? { label: c.status, tone: "neutral" as const };
            const p = prog.get(c.id);
            const href = c.status === "DRAFT" ? `/marketing/campanhas/${c.id}/montar` : `/marketing/campanhas/${c.id}`;
            return (
              <tr key={c.id}>
                <td className="px-3 py-2 font-medium"><Link href={href} className="hover:underline">{c.name}</Link>{c.code && <span className="block font-mono text-[11px] text-muted">[c:{c.code}]</span>}</td>
                <td className="px-3 py-2 text-xs">{OBJECTIVE_LABEL[c.objective] ?? c.objective}</td>
                <td className="px-3 py-2 text-xs tabular-nums">{c.starts_at || c.ends_at ? `${fmt(c.starts_at)} → ${fmt(c.ends_at)}` : "—"}</td>
                <td className="px-3 py-2 text-xs">{c.segment_id ? seg.get(c.segment_id) ?? "público salvo" : "filtros próprios"}{c.audience_scope !== "LOCAL" && <span className="ml-1"><Badge tone="info">{c.audience_scope === "META" ? "Meta" : "base + Meta"}</Badge></span>}</td>
                <td className="px-3 py-2"><Badge tone={st.tone}>{st.label}</Badge></td>
                <td className="px-3 py-2 text-xs tabular-nums">{p && p.total > 0 ? `${p.sent} de ${p.total - p.skipped}${p.skipped ? ` (${p.skipped} de fora)` : ""}` : p?.members ? `${p.members} no público` : "—"}</td>
                <td className="px-3 py-2"><Link className="rounded-lg px-2 py-1 text-xs text-brand hover:bg-surface-2" href={href}>{c.status === "DRAFT" ? "Continuar" : "Abrir"}</Link></td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
