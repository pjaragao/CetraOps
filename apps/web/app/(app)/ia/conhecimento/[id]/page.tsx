import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Narrow, PageHeader } from "@/components/ui";
import { Flash } from "@/components/form";
import { DocForm } from "../doc-form";
import { archiveKnowledgeAction, deleteKnowledgeAction } from "../actions";
import { KINDS, STATUS } from "../kinds";

export const metadata = { title: "Documento da base de conhecimento" };

const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export default async function DocPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("ai.read");
  const canWrite = can(session, "ai.write");
  const { id } = await params;
  const sp = await searchParams;

  if (id === "novo") {
    if (!canWrite) notFound();
    return (
      <Narrow>
        <PageHeader title="Novo documento" description="Escreva o que a equipe costuma responder. Fica como rascunho até você publicar." actions={<Link className="text-sm text-brand" href="/ia/conhecimento">← Base de conhecimento</Link>} />
        <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
        <Card><DocForm archived={false} doc={{ id: "", title: "", kind: "FAQ", body: "", validFrom: "", validTo: "" }} /></Card>
      </Narrow>
    );
  }

  const supabase = await createClient();
  const [{ data: doc }, { data: versions }, { data: members }] = await Promise.all([
    supabase.schema("ai").from("knowledge_docs").select("*").eq("id", id).maybeSingle(),
    supabase.schema("ai").from("knowledge_versions").select("id, version, published_by, published_at").eq("doc_id", id).order("version", { ascending: false }),
    supabase.schema("core").from("members").select("id, display_name"),
  ]);
  if (!doc) notFound();
  const who = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const unpublished = doc.status === "PUBLISHED" && doc.draft_md !== doc.body_md;

  return (
    <Narrow>
      <PageHeader title={doc.title} description={KINDS[doc.kind]?.hint}
        actions={<Link className="text-sm text-brand" href="/ia/conhecimento">← Base de conhecimento</Link>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={STATUS[doc.status]?.tone}>{STATUS[doc.status]?.label}{doc.version > 0 ? ` · v${doc.version}` : ""}</Badge>
        {unpublished && <Badge tone="warning">há alterações não publicadas (a IA ainda usa a v{doc.version})</Badge>}
        {doc.status === "DRAFT" && <span className="text-xs text-muted">A IA ainda não enxerga este documento.</span>}
      </div>

      {canWrite ? (
        <Card><DocForm archived={doc.status === "ARCHIVED"} doc={{ id: doc.id, title: doc.title, kind: doc.kind, body: doc.draft_md, validFrom: doc.valid_from ?? "", validTo: doc.valid_to ?? "" }} /></Card>
      ) : (
        <Card title="Texto publicado"><p className="whitespace-pre-line text-sm">{doc.body_md ?? "Ainda não publicado."}</p></Card>
      )}

      {canWrite && (
        <div className="mt-3 flex flex-wrap gap-2">
          {doc.status !== "DRAFT" && (
            <form action={archiveKnowledgeAction}>
              <input type="hidden" name="id" value={doc.id} /><input type="hidden" name="archive" value={doc.status === "ARCHIVED" ? "0" : "1"} />
              <Button variant="secondary">{doc.status === "ARCHIVED" ? "Reativar" : "Arquivar (a IA deixa de usar)"}</Button>
            </form>
          )}
          {doc.version === 0 && (
            <form action={deleteKnowledgeAction}><input type="hidden" name="id" value={doc.id} /><Button variant="danger">Apagar rascunho</Button></form>
          )}
        </div>
      )}

      {(versions ?? []).length > 0 && (
        <Card title="Versões publicadas" className="mt-4">
          <ul className="space-y-1 text-sm">
            {(versions ?? []).map((v) => (
              <li key={v.id} className="flex gap-2"><span className="font-medium">v{v.version}</span><span className="text-muted">{when(v.published_at)} · {v.published_by ? who.get(v.published_by) ?? "—" : "—"}</span></li>
            ))}
          </ul>
        </Card>
      )}
    </Narrow>
  );
}
