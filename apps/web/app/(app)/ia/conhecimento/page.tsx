import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, LinkButton, PageHeader, Table, inputClass } from "@/components/ui";
import { Flash, fmtDate } from "@/components/form";
import { KINDS, STATUS } from "./kinds";

export const metadata = { title: "Base de conhecimento" };

interface Hit { doc_id: string; title: string; kind: string; version: number; text: string }

export default async function ConhecimentoPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("ai.read");
  const sp = await searchParams;
  const canWrite = can(session, "ai.write");
  const q = str(sp.q);
  const supabase = await createClient();
  const [{ data: docs }, search] = await Promise.all([
    supabase.schema("ai").from("knowledge_docs").select("id, title, kind, status, version, draft_md, body_md, valid_from, valid_to, updated_at").order("title"),
    q ? supabase.schema("ai").rpc("knowledge_search", { p_query: q, p_limit: 4 }) : Promise.resolve({ data: null }),
  ]);
  const hits = (search.data as unknown as Hit[] | null) ?? null;

  return (
    <>
      <PageHeader title="Base de conhecimento" description="O que a IA (e a equipe) pode consultar sobre a marca, o cuidado com as peças, eventos e regras da loja. A IA só usa o que foi publicado aqui e, sem resposta, transfere em vez de inventar."
        actions={canWrite ? <LinkButton href="/ia/conhecimento/novo" variant="primary">Novo documento</LinkButton> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      <Card title="Testar a busca" className="mb-4">
        <form className="flex flex-wrap gap-2" action="/ia/conhecimento">
          <input name="q" defaultValue={q} placeholder="Escreva como a cliente perguntaria: posso lavar na máquina?" className={`${inputClass} min-w-64 flex-1`} aria-label="Pergunta" />
          <Button variant="secondary">Buscar</Button>
        </form>
        {hits && (hits.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nada encontrado nos documentos publicados. Nesse caso a IA não responde por conta própria: ela avisa que vai confirmar ou chama a equipe.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {hits.map((h, i) => (
              <li key={i} className="rounded-lg border border-border bg-surface-2/50 p-3 text-sm">
                <p className="mb-1 text-xs text-muted"><Link className="text-brand" href={`/ia/conhecimento/${h.doc_id}`}>{h.title}</Link> · {KINDS[h.kind]?.label ?? h.kind} · versão {h.version}</p>
                <p className="whitespace-pre-line">{h.text}</p>
              </li>
            ))}
          </ul>
        ))}
      </Card>

      {(docs ?? []).length === 0 ? <Empty title="Nenhum documento ainda">Comece pelo que as clientes mais perguntam: troca, lavagem das peças, horário, como funciona o Armário VIP.</Empty> : (
        <Table head={["Documento", "Tipo", "Situação", "Validade", "Atualizado", ""]}>
          {(docs ?? []).map((d) => {
            const unpublished = d.status === "PUBLISHED" && d.draft_md !== d.body_md;
            return (
              <tr key={d.id}>
                <td className="px-3 py-2 font-medium">{d.title}</td>
                <td className="px-3 py-2 text-xs">{KINDS[d.kind]?.label ?? d.kind}</td>
                <td className="px-3 py-2">
                  <Badge tone={STATUS[d.status]?.tone}>{STATUS[d.status]?.label}{d.version > 0 ? ` · v${d.version}` : ""}</Badge>
                  {unpublished && <span className="ml-1"><Badge tone="warning">alterações não publicadas</Badge></span>}
                </td>
                <td className="px-3 py-2 text-xs">{d.valid_from || d.valid_to ? `${fmtDate(d.valid_from)} a ${fmtDate(d.valid_to)}` : "sempre"}</td>
                <td className="px-3 py-2 text-xs">{new Date(d.updated_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td>
                <td className="px-3 py-2"><Link className="rounded-lg px-2 py-1 text-xs text-brand hover:bg-surface-2" href={`/ia/conhecimento/${d.id}`}>Abrir</Link></td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
