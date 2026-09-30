import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { createCampaignAction } from "./actions";
import { CAMPAIGN_STATUS } from "./campaign-status";

export const metadata = { title: "Campanhas" };

export default async function CampanhasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const supabase = await createClient();
  const [{ data: campaigns }, { data: recipients }, { data: templates }, { data: accounts }] = await Promise.all([
    supabase.schema("mkt").from("campaigns").select("id, name, status, template_id, created_at, scheduled_at, channel_account_id").order("created_at", { ascending: false }).limit(100),
    supabase.schema("mkt").from("campaign_recipients").select("campaign_id, status").limit(20000),
    supabase.schema("omni").from("templates").select("id, name, category, channel_account_id").eq("status", "APPROVED").order("name"),
    supabase.schema("omni").from("channel_accounts").select("id, display_name").eq("channel", "WHATSAPP"),
  ]);
  const tpl = new Map((templates ?? []).map((t) => [t.id, t]));
  const acc = new Map((accounts ?? []).map((a) => [a.id, a.display_name]));
  const prog = new Map<string, { total: number; sent: number; skipped: number }>();
  for (const r of recipients ?? []) {
    const p = prog.get(r.campaign_id) ?? { total: 0, sent: 0, skipped: 0 };
    p.total++;
    if (r.status === "QUEUED" || r.status === "SENT") p.sent++;
    if (r.status === "SKIPPED") p.skipped++;
    prog.set(r.campaign_id, p);
  }

  return (
    <>
      <PageHeader title="Campanhas" description="Disparo de template de marketing no WhatsApp. Só recebe quem aceitou marketing no WhatsApp; há intervalo entre mensagens e limite diário por número." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(campaigns ?? []).length === 0 ? <Empty title="Nenhuma campanha ainda">Crie o rascunho abaixo: escolha o template aprovado e depois defina o público.</Empty> : (
        <Table head={["Campanha", "Template", "Número", "Situação", "Enviadas", ""]}>
          {(campaigns ?? []).map((c) => {
            const st = CAMPAIGN_STATUS[c.status];
            const p = prog.get(c.id);
            return (
              <tr key={c.id}>
                <td className="px-3 py-2 font-medium"><Link href={`/marketing/campanhas/${c.id}`} className="hover:underline">{c.name}</Link></td>
                <td className="px-3 py-2 font-mono text-xs">{tpl.get(c.template_id)?.name ?? "—"}</td>
                <td className="px-3 py-2 text-xs">{acc.get(c.channel_account_id)}</td>
                <td className="px-3 py-2"><Badge tone={st.tone}>{st.label}</Badge>{c.scheduled_at && c.status === "SCHEDULED" && <span className="ml-1 text-[11px] text-muted">{new Date(c.scheduled_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>}</td>
                <td className="px-3 py-2 tabular-nums text-xs">{p ? `${p.sent} de ${p.total - p.skipped}${p.skipped ? ` (${p.skipped} de fora)` : ""}` : "—"}</td>
                <td className="px-3 py-2"><Link className="rounded-lg px-2 py-1 text-xs text-brand hover:bg-surface-2" href={`/marketing/campanhas/${c.id}`}>Abrir</Link></td>
              </tr>
            );
          })}
        </Table>
      )}
      {canWrite && (
        <Card className="mt-4" title="Nova campanha">
          {(templates ?? []).length === 0 ? <p className="text-sm text-muted">Nenhum template aprovado ainda. Crie e envie para aprovação em <Link className="text-brand" href="/atendimento/templates">Atendimento › Templates</Link>.</p> : (
            <form action={createCampaignAction} className="grid gap-3 sm:grid-cols-[1.5fr_1.5fr_auto] sm:items-end">
              <Field label="Nome"><input name="name" required minLength={3} maxLength={120} className={inputClass} placeholder="Coleção de outono" /></Field>
              <Field label="Template aprovado" hint="Campanha de marketing usa template da categoria Marketing">
                <select name="template_id" required defaultValue="" className={inputClass}><option value="" disabled>Escolha…</option>
                  {(templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} · {t.category === "MARKETING" ? "marketing" : "utilidade"} · {acc.get(t.channel_account_id)}</option>)}</select>
              </Field>
              <Button>Criar rascunho</Button>
            </form>
          )}
        </Card>
      )}
    </>
  );
}
