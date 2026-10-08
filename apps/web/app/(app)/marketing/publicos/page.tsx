import Link from "next/link";
import { describeAudience, type AudienceDef } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { AudienceBuilder } from "../audience-builder";
import { loadLookups } from "../lookups";
import { campaignFromSegmentAction, deleteSegmentAction, previewAudienceAction, refreshSegmentAction, saveSegmentAction, sendSegmentToMetaAction } from "./actions";

export const metadata = { title: "Públicos" };

export default async function PublicosPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const isAdmin = can(session, "core.admin");
  const supabase = await createClient();
  const [{ data: segments }, { data: audiences }, lookups] = await Promise.all([
    supabase.schema("mkt").from("segments").select("id, name, description, definition, kind, cached_count, cached_at").order("name"),
    supabase.schema("mkt").from("ad_audiences").select("segment_id, status, uploaded, kind").not("segment_id", "is", null),
    loadLookups(supabase),
  ]);
  const meta = new Map((audiences ?? []).filter((a) => a.kind === "CUSTOM").map((a) => [a.segment_id as string, a]));
  const editId = str(sp.editar);
  const editing = editId && editId !== "novo" ? (segments ?? []).find((s) => s.id === editId) : undefined;
  const showForm = canWrite && (editId === "novo" || !!editing);
  const nameOf = new Map((segments ?? []).map((s) => [s.id, s.name]));

  return (
    <>
      <PageHeader title="Públicos" description="Grupos de pessoas salvos para reutilizar em campanhas, eventos e anúncios: “inativas há 60 a 180 dias”, “leads dos últimos 30 dias”, “quem comprou legging”. O público dinâmico se atualiza sozinho; o congelado guarda a lista de hoje."
        actions={canWrite && !showForm ? <Link href="/marketing/publicos?editar=novo" className="inline-flex items-center rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-contrast hover:opacity-90">Novo público</Link> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      {showForm && (
        <Card className="mb-4" title={editing ? `Editar: ${editing.name}` : "Novo público"}>
          <form key={editing?.id ?? "novo"} action={saveSegmentAction} className="space-y-4">
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <div className="grid gap-3 sm:grid-cols-[2fr_2fr_1fr]">
              <Field label="Nome"><input name="name" required minLength={3} maxLength={80} defaultValue={editing?.name} className={inputClass} placeholder="Inativas há 60 a 180 dias" /></Field>
              <Field label="Descrição (opcional)"><input name="description" maxLength={200} defaultValue={editing?.description ?? ""} className={inputClass} /></Field>
              <Field label="Tipo" hint="Congelado guarda a lista de hoje"><select name="kind" defaultValue={editing?.kind ?? "DYNAMIC"} className={inputClass}><option value="DYNAMIC">Dinâmico</option><option value="STATIC">Congelado</option></select></Field>
            </div>
            <AudienceBuilder def={(editing?.definition ?? {}) as unknown as AudienceDef} lookups={lookups} previewAction={previewAudienceAction} hideSaved={editing?.id} />
            <div className="flex items-center gap-3"><Button>{editing ? "Salvar público" : "Criar público"}</Button><Link href="/marketing/publicos" className="text-xs text-brand">Cancelar</Link></div>
          </form>
        </Card>
      )}

      {(segments ?? []).length === 0 ? <Empty title="Nenhum público salvo ainda">Crie o primeiro: ele aparece na hora de montar uma campanha e pode ir para a Meta.</Empty> : (
        <Table head={["Público", "Quem entra", "Pessoas", "Meta", ""]}>
          {(segments ?? []).map((s) => {
            const lines = describeAudience(s.definition as unknown as AudienceDef, { segment: s.definition && (s.definition as { segment_id?: string }).segment_id ? nameOf.get((s.definition as { segment_id: string }).segment_id) : undefined });
            const m = meta.get(s.id);
            return (
              <tr key={s.id}>
                <td className="px-3 py-2"><span className="font-medium">{s.name}</span>{s.kind === "STATIC" && <span className="ml-1"><Badge>congelado</Badge></span>}{s.description && <span className="block text-[11px] text-muted">{s.description}</span>}</td>
                <td className="max-w-md px-3 py-2 text-xs text-muted">{lines.length ? lines.join(" · ") : "todas as pessoas elegíveis"}</td>
                <td className="px-3 py-2 tabular-nums">{s.cached_count ?? "—"}{s.cached_at && <span className="block text-[11px] text-muted">{new Date(s.cached_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}</span>}</td>
                <td className="px-3 py-2 text-xs">{m ? <Link href="/marketing/anuncios" className="text-brand">{m.status === "READY" ? `pronto (${m.uploaded ?? 0})` : m.status === "ERROR" ? "erro" : "enviando"}</Link> : <span className="text-muted">—</span>}</td>
                <td className="px-3 py-2">
                  {canWrite && (
                    <div className="flex flex-wrap items-center gap-1">
                      <form action={campaignFromSegmentAction}><input type="hidden" name="id" value={s.id} /><Button variant="secondary" className="px-2 py-1 text-xs">Criar campanha</Button></form>
                      <Link className="rounded-lg px-2 py-1 text-xs hover:bg-surface-2" href={`/marketing/publicos?editar=${s.id}`}>Editar</Link>
                      <form action={refreshSegmentAction}><input type="hidden" name="id" value={s.id} /><Button variant="ghost" className="px-2 py-1 text-xs">Recontar</Button></form>
                      {isAdmin && <form action={sendSegmentToMetaAction}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="auto" value="1" /><Button variant="ghost" className="px-2 py-1 text-xs" title="Só sobe quem aceitou receber anúncios">Enviar à Meta</Button></form>}
                      <form action={deleteSegmentAction}><input type="hidden" name="id" value={s.id} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Excluir</Button></form>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
