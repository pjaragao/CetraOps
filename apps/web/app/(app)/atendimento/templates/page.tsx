import Link from "next/link";
import { templateExamples, templateParts, type TemplateComponent } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge, Button, Card, Empty, PageHeader, Table } from "@/components/ui";
import { Flash } from "@/components/form";
import { deleteQuickReplyAction, deleteTemplateAction, submitTemplateAction, syncTemplatesAction } from "./actions";
import { QuickReplyForm } from "./quick-reply-form";
import { TemplateForm, type TemplateInitial } from "./template-form";

export const metadata = { title: "Templates e respostas rápidas" };

const STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  DRAFT: { label: "rascunho", tone: "neutral" }, PENDING: { label: "aguardando a Meta", tone: "warning" }, APPROVED: { label: "aprovado", tone: "success" },
  REJECTED: { label: "rejeitado", tone: "danger" }, PAUSED: { label: "pausado", tone: "warning" }, DISABLED: { label: "desativado", tone: "neutral" },
};
const QUALITY: Record<string, "success" | "warning" | "danger" | "neutral"> = { GREEN: "success", YELLOW: "warning", RED: "danger", UNKNOWN: "neutral" };

export default async function TemplatesPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("omni.read");
  const sp = await searchParams;
  const canWrite = can(session, "omni.write");
  const supabase = await createClient();
  const [{ data: accounts }, { data: tpls }, { data: replies }] = await Promise.all([
    supabase.schema("omni").from("channel_accounts").select("id, display_name, provider_account_id, status").eq("channel", "WHATSAPP").order("display_name"),
    supabase.schema("omni").from("templates").select("id, channel_account_id, name, language, category, components, status, quality, rejection_reason, updated_at").order("updated_at", { ascending: false }),
    supabase.schema("omni").from("quick_replies").select("id, shortcut, body").order("shortcut"),
  ]);
  const acc = new Map((accounts ?? []).map((a) => [a.id, a.display_name]));
  const editing = str(sp.editar) ? (tpls ?? []).find((t) => t.id === str(sp.editar) && ["DRAFT", "REJECTED"].includes(t.status)) : undefined;
  const initial: TemplateInitial | undefined = editing && (() => {
    const parts = templateParts(editing.components as unknown as TemplateComponent[]);
    return { id: editing.id, channel_account_id: editing.channel_account_id, name: editing.name, category: editing.category, language: editing.language, header: parts.header ?? "", body: parts.body, footer: parts.footer ?? "", buttons: parts.buttons, examples: templateExamples(editing.components as unknown as TemplateComponent[]) };
  })();
  const accountOptions = (accounts ?? []).filter((a) => a.status === "ACTIVE").map((a) => ({ id: a.id, label: `${a.display_name} (${a.provider_account_id})` }));
  const editingReply = str(sp.atalho) ? (replies ?? []).find((r) => r.id === str(sp.atalho)) : undefined;

  return (
    <>
      <PageHeader title="Templates e respostas rápidas" description="Fora da janela de 24 h o WhatsApp só aceita template aprovado pela Meta. Respostas rápidas são textos prontos para usar dentro da janela."
        actions={canWrite && (accounts ?? []).length > 0 ? <div className="flex gap-2">{(accounts ?? []).map((a) => (
          <form key={a.id} action={syncTemplatesAction}><input type="hidden" name="channel_account_id" value={a.id} /><Button variant="secondary" title={`Buscar na Meta os templates de ${a.display_name}`}>Sincronizar com a Meta</Button></form>))}</div> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {str(sp.wait) && <AutoRefresh />}

      {(accounts ?? []).length === 0 ? <Empty title="Nenhum número de WhatsApp cadastrado">Cadastre o canal em <Link className="text-brand" href="/configuracoes/integracoes">Configurações › Integrações</Link> para criar templates.</Empty> : (
        <>
          {(tpls ?? []).length === 0 ? <Empty title="Nenhum template ainda">Crie o primeiro abaixo (ex.: aviso de pedido pronto) ou sincronize os que já existem na Meta.</Empty> : (
            <Table head={["Template", "Número", "Categoria", "Situação", "Qualidade", "Texto", ""]}>
              {(tpls ?? []).map((t) => {
                const st = STATUS[t.status] ?? STATUS.DRAFT;
                const parts = templateParts(t.components as unknown as TemplateComponent[]);
                return (
                  <tr key={t.id}>
                    <td className="px-3 py-2 font-mono text-xs font-medium">{t.name}<span className="block text-[11px] font-sans font-normal text-muted">{t.language}</span></td>
                    <td className="px-3 py-2 text-xs">{acc.get(t.channel_account_id) ?? "—"}</td>
                    <td className="px-3 py-2"><Badge tone={t.category === "MARKETING" ? "brand" : "info"}>{t.category === "MARKETING" ? "marketing" : "utilidade"}</Badge></td>
                    <td className="px-3 py-2"><Badge tone={st.tone}>{st.label}</Badge>{t.rejection_reason && <span className="mt-1 block max-w-[14rem] text-[11px] text-danger">{t.rejection_reason}</span>}</td>
                    <td className="px-3 py-2">{t.quality ? <Badge tone={QUALITY[t.quality] ?? "neutral"}>{t.quality.toLowerCase()}</Badge> : "—"}</td>
                    <td className="max-w-sm px-3 py-2 text-xs"><span className="line-clamp-2 whitespace-pre-line">{parts.body}</span></td>
                    <td className="px-3 py-2">
                      {canWrite && ["DRAFT", "REJECTED"].includes(t.status) && (
                        <div className="flex flex-wrap gap-1">
                          <Link className="rounded-lg px-2 py-1 text-xs hover:bg-surface-2" href={`/atendimento/templates?editar=${t.id}`}>Editar</Link>
                          <form action={submitTemplateAction}><input type="hidden" name="id" value={t.id} /><Button variant="secondary" className="px-2 py-1 text-xs">Enviar para aprovação</Button></form>
                          <form action={deleteTemplateAction}><input type="hidden" name="id" value={t.id} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Excluir</Button></form>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          {canWrite && (
            <Card className="mt-4" title={initial ? `Editar rascunho: ${initial.name}` : "Novo template"}>
              <TemplateForm key={initial?.id ?? "novo"} accounts={accountOptions} initial={initial} />
              {initial && <p className="mt-3 text-xs"><Link className="text-brand" href="/atendimento/templates">Cancelar edição</Link></p>}
            </Card>
          )}
        </>
      )}

      <h2 className="mb-2 mt-8 text-sm font-semibold">Respostas rápidas</h2>
      {(replies ?? []).length === 0 ? <Empty title="Nenhuma resposta rápida">Crie atalhos como <code>/obrigada</code> ou <code>/horario</code> para responder mais rápido.</Empty> : (
        <Table head={["Atalho", "Texto", ""]}>
          {(replies ?? []).map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 font-mono text-xs font-medium">/{r.shortcut}</td>
              <td className="px-3 py-2 whitespace-pre-line">{r.body}</td>
              <td className="px-3 py-2">{canWrite && <div className="flex gap-1"><Link className="rounded-lg px-2 py-1 text-xs hover:bg-surface-2" href={`/atendimento/templates?atalho=${r.id}`}>Editar</Link>
                <form action={deleteQuickReplyAction}><input type="hidden" name="id" value={r.id} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Excluir</Button></form></div>}</td>
            </tr>
          ))}
        </Table>
      )}
      {canWrite && <Card className="mt-3" title={editingReply ? `Editar /${editingReply.shortcut}` : "Nova resposta rápida"}><QuickReplyForm key={editingReply?.id ?? "nova"} initial={editingReply} /></Card>}
    </>
  );
}
