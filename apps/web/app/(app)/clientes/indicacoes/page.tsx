import Link from "next/link";
import { formatBRL, trackingUrl } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { referralLinkAction, saveReferralSettingsAction } from "./actions";

export const metadata = { title: "Indicações" };

const STATUS: Record<string, { label: string; tone: "warning" | "success" | "danger" }> = { PENDING: { label: "aguardando", tone: "warning" }, REWARDED: { label: "vale emitido", tone: "success" }, REJECTED: { label: "não premiada", tone: "danger" } };
const REASON: Record<string, string> = { RETURNED: "pedido devolvido", CAP: "teto mensal atingido", NO_PURCHASE: "não comprou no prazo", MANUAL: "manual" };

export default async function IndicacoesPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const isAdmin = can(session, "core.admin");
  const supabase = await createClient();
  const [{ data: setting }, { data: refs }] = await Promise.all([
    supabase.schema("core").from("settings").select("value").eq("key", "referral").maybeSingle(),
    supabase.schema("crm").from("referrals").select("id, referrer_party, friend_party, status, reject_reason, reward_amount, created_at, order_id").order("created_at", { ascending: false }).limit(100),
  ]);
  const cfg = { enabled: false, reward_amount: 50, wait_days: 7, monthly_cap: 5, ...(setting?.value as Record<string, unknown> | undefined) } as { enabled: boolean; reward_amount: number; wait_days: number; monthly_cap: number };
  const ids = [...new Set((refs ?? []).flatMap((r) => [r.referrer_party, r.friend_party]))];
  const { data: parties } = ids.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", ids) : { data: [] as { id: string; display_name: string }[] };
  const who = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
  const linkId = str(sp.link);
  let linkUrl: string | null = null;
  let linkName = "";
  if (linkId) {
    const { data: l } = await supabase.schema("mkt").from("tracking_links").select("name, code, prefill_text, channel_account_id").eq("id", linkId).maybeSingle();
    if (l) {
      const { data: ca } = await supabase.schema("omni").from("channel_accounts").select("channel, public_address").eq("id", l.channel_account_id).maybeSingle();
      linkUrl = ca ? trackingUrl(ca.channel, ca.public_address, l.code, l.prefill_text) : null;
      linkName = l.name;
    }
  }

  return (
    <>
      <PageHeader title="Indique uma amiga" description="Cada cliente tem um link pessoal. Quando a amiga chega por ele e faz a primeira compra, quem indicou ganha um vale-troca depois do prazo de troca. A amiga precisa ser nova (sem compra antes) e só pode ser indicada uma vez." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <Card title="Regras">
        <form action={saveReferralSettingsAction} className="space-y-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={cfg.enabled} disabled={!isAdmin} /> Programa ligado (sem isso o vale não é emitido)</label>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Vale para quem indicou (R$)"><input name="reward_amount" inputMode="decimal" defaultValue={String(cfg.reward_amount)} disabled={!isAdmin} className={inputClass} /></Field>
            <Field label="Esperar após a compra (dias)"><input name="wait_days" type="number" min={0} max={60} defaultValue={cfg.wait_days} disabled={!isAdmin} className={inputClass} /></Field>
            <Field label="Máximo de vales por mês, por cliente"><input name="monthly_cap" type="number" min={1} max={100} defaultValue={cfg.monthly_cap} disabled={!isAdmin} className={inputClass} /></Field>
          </div>
          {isAdmin ? <Button>Salvar regras</Button> : <p className="text-xs text-muted">Só sócios e administração alteram.</p>}
        </form>
      </Card>

      {canWrite && (
        <Card className="mt-4" title="Link pessoal de uma cliente">
          <form action={referralLinkAction} className="flex flex-wrap items-end gap-3">
            <Field label="Cliente (nome ou telefone)"><input name="party" required className={`${inputClass} w-72`} /></Field>
            <Button variant="secondary">Gerar / mostrar link</Button>
          </form>
          {linkUrl && <p className="mt-3 break-all rounded-lg bg-surface-2 p-3 text-sm"><b>{linkName}</b><br />{linkUrl}</p>}
          {linkId && !linkUrl && <p className="mt-3 text-sm text-muted">Cadastre o número do WhatsApp do canal (Configurações › Canais) para montar o endereço.</p>}
        </Card>
      )}

      <h2 className="mb-2 mt-6 text-sm font-semibold">Indicações recebidas</h2>
      {(refs ?? []).length === 0 ? <Empty title="Nenhuma indicação ainda">Gere o link de uma cliente (ou envie o convite após uma nota 9 ou 10 no NPS).</Empty> : (
        <Table head={["Amiga", "Indicada por", "Situação", "Vale", "Data"]}>
          {(refs ?? []).map((r) => {
            const s = STATUS[r.status];
            return (
              <tr key={r.id}>
                <td className="px-3 py-2"><Link href={`/clientes/${r.friend_party}`} className="text-brand">{who.get(r.friend_party)}</Link></td>
                <td className="px-3 py-2"><Link href={`/clientes/${r.referrer_party}`} className="text-brand">{who.get(r.referrer_party)}</Link></td>
                <td className="px-3 py-2"><Badge tone={s.tone}>{s.label}</Badge>{r.reject_reason && <span className="ml-1 text-xs text-muted">{REASON[r.reject_reason]}</span>}{r.status === "PENDING" && <span className="ml-1 text-xs text-muted">{r.order_id ? "comprou, aguardando o prazo" : "ainda não comprou"}</span>}</td>
                <td className="px-3 py-2 tabular-nums">{r.reward_amount != null ? formatBRL(Number(r.reward_amount)) : "—"}</td>
                <td className="px-3 py-2 text-xs text-muted">{new Date(r.created_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
