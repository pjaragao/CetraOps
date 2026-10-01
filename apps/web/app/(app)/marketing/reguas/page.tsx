import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { saveContactPolicyAction, toggleJourneyAction } from "./actions";
import { TRIGGERS } from "./labels";

export const metadata = { title: "Réguas" };

export default async function ReguasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const supabase = await createClient();
  const [{ data: journeys }, { data: enrolls }, { data: policyRow }] = await Promise.all([
    supabase.schema("mkt").from("journeys").select("id, name, description, trigger, active, holdout_pct").order("created_at"),
    supabase.schema("mkt").from("journey_enrollments").select("journey_id, grp, status, exit_reason").limit(20000),
    supabase.schema("core").from("settings").select("value").eq("key", "contact_policy").maybeSingle(),
  ]);
  const policy = { marketing_per_7d: 1, marketing_per_30d: 4, relationship_per_14d: 2, quiet_start: "20:00", quiet_end: "09:00", no_sunday: true, ...((policyRow?.value ?? {}) as Record<string, unknown>) };
  const stats = new Map<string, { active: number; total: number; conv: number }>();
  for (const e of enrolls ?? []) {
    const s = stats.get(e.journey_id) ?? { active: 0, total: 0, conv: 0 };
    s.total++;
    if (e.status === "ACTIVE") s.active++;
    if (e.exit_reason === "PURCHASED" && e.grp === "TREATMENT") s.conv++;
    stats.set(e.journey_id, s);
  }

  return (
    <>
      <PageHeader title="Réguas de relacionamento" description="Sequências que cuidam da cliente depois da compra, na 2ª compra, no aniversário e quando ela some. Cada passo vira tarefa com mensagem pronta (contato pessoal) ou mensagem automática dentro das regras. Uma parte sorteada (grupo de controle) não recebe nada, para medir o efeito real." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(journeys ?? []).length === 0 ? <Empty title="Nenhuma régua" /> : (
        <Table head={["Régua", "Gatilho", "Controle", "Em andamento", "Já passaram", "Compraram (tratamento)", "Situação", ""]}>
          {(journeys ?? []).map((j) => {
            const s = stats.get(j.id);
            return (
              <tr key={j.id}>
                <td className="px-3 py-2"><Link href={`/marketing/reguas/${j.id}`} className="font-medium text-brand">{j.name}</Link>{j.description && <span className="block text-xs text-muted">{j.description}</span>}</td>
                <td className="px-3 py-2 text-xs">{TRIGGERS[j.trigger]?.label ?? j.trigger}</td>
                <td className="px-3 py-2 tabular-nums">{j.holdout_pct}%</td>
                <td className="px-3 py-2 tabular-nums">{s?.active ?? 0}</td>
                <td className="px-3 py-2 tabular-nums">{s?.total ?? 0}</td>
                <td className="px-3 py-2 tabular-nums">{s?.conv ?? 0}</td>
                <td className="px-3 py-2"><Badge tone={j.active ? "success" : "neutral"}>{j.active ? "ligada" : "desligada"}</Badge></td>
                <td className="px-3 py-2">{canWrite && (
                  <form action={toggleJourneyAction}><input type="hidden" name="id" value={j.id} /><input type="hidden" name="active" value={j.active ? "0" : "1"} /><input type="hidden" name="back" value="/marketing/reguas" />
                    <Button variant="ghost" className="px-2 py-1 text-xs">{j.active ? "Desligar" : "Ligar"}</Button></form>
                )}</td>
              </tr>
            );
          })}
        </Table>
      )}
      {canWrite && <p className="mt-2 text-xs"><Link href="/marketing/reguas/nova" className="text-brand">+ Nova régua</Link></p>}

      <Card className="mt-6" title="Regras de contato (valem para réguas)">
        <p className="mb-3 text-sm text-muted">Ninguém recebe nada proativo se pediu para parar, se tem reclamação aberta ou se está conversando com a equipe. Mensagens automáticas esperam o fim do horário de silêncio; tarefas não.</p>
        <form action={saveContactPolicyAction} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Field label="Marketing a cada 7 dias"><input name="marketing_per_7d" type="number" min={0} max={7} defaultValue={String(policy.marketing_per_7d)} disabled={!can(session, "core.admin")} className={inputClass} /></Field>
            <Field label="Marketing a cada 30 dias"><input name="marketing_per_30d" type="number" min={0} max={30} defaultValue={String(policy.marketing_per_30d)} disabled={!can(session, "core.admin")} className={inputClass} /></Field>
            <Field label="Contatos pessoais a cada 14 dias"><input name="relationship_per_14d" type="number" min={0} max={14} defaultValue={String(policy.relationship_per_14d)} disabled={!can(session, "core.admin")} className={inputClass} /></Field>
            <Field label="Silêncio a partir de"><input name="quiet_start" type="time" defaultValue={String(policy.quiet_start)} disabled={!can(session, "core.admin")} className={inputClass} /></Field>
            <Field label="Silêncio até"><input name="quiet_end" type="time" defaultValue={String(policy.quiet_end)} disabled={!can(session, "core.admin")} className={inputClass} /></Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="no_sunday" defaultChecked={Boolean(policy.no_sunday)} disabled={!can(session, "core.admin")} /> Sem envio no domingo</label>
          </div>
          {can(session, "core.admin") ? <Button variant="secondary">Salvar regras de contato</Button> : <p className="text-xs text-muted">Só sócios e administração alteram.</p>}
        </form>
      </Card>
    </>
  );
}
