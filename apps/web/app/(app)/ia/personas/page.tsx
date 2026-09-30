import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, PageHeader, Table, inputClass } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { savePersonaAction } from "./actions";

export const metadata = { title: "Personas" };

export default async function PersonasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("ai.read");
  const sp = await searchParams;
  const canWrite = can(session, "ai.write");
  const supabase = await createClient();
  const [{ data: personas }, { data: versions }, { data: members }] = await Promise.all([
    supabase.schema("ai").from("personas").select("id, name, member_id, active_version_id").order("name"),
    supabase.schema("ai").from("persona_versions").select("id, persona_id, version, approved_at").order("version", { ascending: false }),
    supabase.schema("core").from("members").select("id, display_name").order("display_name"),
  ]);
  // contagens exatas por persona (sem o limite de 1.000 linhas da listagem)
  const counts = new Map(await Promise.all((canWrite ? personas ?? [] : []).map(async (p) => {
    const [d, pr] = await Promise.all([
      supabase.schema("ai").from("corpus_dialogues").select("id", { count: "exact", head: true }).eq("persona_id", p.id).eq("include", true),
      supabase.schema("ai").from("corpus_pairs").select("id", { count: "exact", head: true }).eq("persona_id", p.id),
    ]);
    return [p.id, { dialogues: d.count ?? 0, pairs: pr.count ?? 0 }] as const;
  })));
  const member = new Map((members ?? []).map((m) => [m.id, m.display_name]));

  return (
    <>
      <PageHeader title="Personas" description="O estilo de quem atende, aprendido com conversas reais dos sócios. A IA imita o jeito de escrever, mas nunca diz que é a pessoa." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(personas ?? []).length === 0 ? <Empty title="Nenhuma persona ainda">Crie a primeira abaixo e envie o histórico de conversas dela.</Empty> : (
        <Table head={["Persona", "Pessoa", "Versão ativa", "Diálogos", "Exemplos", ""]}>
          {(personas ?? []).map((p) => {
            const active = (versions ?? []).find((v) => v.id === p.active_version_id);
            const draft = (versions ?? []).some((v) => v.persona_id === p.id && !v.approved_at);
            return (
              <tr key={p.id}>
                <td className="px-3 py-2 font-medium">{p.name}</td>
                <td className="px-3 py-2 text-xs">{p.member_id ? member.get(p.member_id) ?? "—" : "Marca"}</td>
                <td className="px-3 py-2">{active ? <Badge tone="success">v{active.version}</Badge> : <Badge tone="neutral">padrão da marca</Badge>}{draft && <span className="ml-1"><Badge tone="warning">rascunho</Badge></span>}</td>
                <td className="px-3 py-2 tabular-nums">{counts.get(p.id)?.dialogues ?? "—"}</td>
                <td className="px-3 py-2 tabular-nums">{counts.get(p.id)?.pairs ?? "—"}</td>
                <td className="px-3 py-2"><Link className="rounded-lg px-2 py-1 text-xs text-brand hover:bg-surface-2" href={`/ia/personas/${p.id}`}>Abrir</Link></td>
              </tr>
            );
          })}
        </Table>
      )}
      {canWrite && (
        <Card className="mt-4" title="Nova persona">
          <form action={savePersonaAction} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Nome"><input name="name" required minLength={2} maxLength={60} className={inputClass} placeholder="Luisa" /></Field>
            <Field label="Pessoa da equipe (opcional)" hint="Quem é a pessoa por trás do estilo. Só as respostas dela ensinam esta persona ao vivo.">
              <select name="member_id" className={inputClass} defaultValue=""><option value="">— persona da marca —</option>{(members ?? []).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select>
            </Field>
            <Button>Criar persona</Button>
          </form>
        </Card>
      )}
    </>
  );
}
