import { describeNotification, timeAgo } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Empty, PageHeader } from "@/components/ui";
import { markAllNotificationsRead } from "./actions";

export const metadata = { title: "Notificações" };

const TONE = { info: "info", success: "success", warning: "warning", danger: "danger" } as const;

export default async function NotificacoesPage({ searchParams }: { searchParams: SP }) {
  const session = await getSession();
  const sp = await searchParams;
  const onlyUnread = str(sp.filtro) === "nao-lidas";
  const supabase = await createClient();
  let q = supabase.schema("core").from("notifications").select("id, kind, title, payload, read_at, created_at").eq("member_id", session.memberId).order("created_at", { ascending: false }).limit(100);
  if (onlyUnread) q = q.is("read_at", null);
  const { data: items } = await q;
  const unread = (items ?? []).filter((i) => !i.read_at).length;

  return (
    <>
      <PageHeader title="Notificações" description="Avisos do atendimento, do fiscal e das integrações. Cada aviso abre a tela de quem resolve."
        actions={unread > 0 ? <form action={markAllNotificationsRead}><Button variant="secondary">Marcar todas como lidas</Button></form> : undefined} />
      <div className="mb-3 flex gap-2 text-xs">
        {[["", "Todas"], ["nao-lidas", "Não lidas"]].map(([v, l]) => (
          <a key={v} href={v ? `/notificacoes?filtro=${v}` : "/notificacoes"} className={`rounded-full border px-3 py-1 ${(onlyUnread ? "nao-lidas" : "") === v ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2"}`}>{l}</a>
        ))}
      </div>
      {(items ?? []).length === 0 ? <Empty title={onlyUnread ? "Nenhuma notificação não lida" : "Nenhuma notificação ainda"}>Quando algo precisar de você (mensagem aguardando, nota rejeitada, integração com erro), aparece aqui e no sino.</Empty> : (
        <ul className="overflow-hidden rounded-xl border border-border bg-surface">
          {(items ?? []).map((n) => {
            const v = describeNotification(n.kind, n.payload as Record<string, unknown>);
            return (
              <li key={n.id} className="border-b border-border last:border-0">
                <a href={`/notificacoes/abrir?id=${n.id}`} className={`flex items-start gap-3 px-4 py-3 hover:bg-surface-2 ${n.read_at ? "" : "bg-brand/5"}`}>
                  <Badge tone={TONE[v.tone]}>{v.label}</Badge>
                  <span className={`min-w-0 flex-1 text-sm ${n.read_at ? "text-muted" : "font-medium"}`}>{n.title}</span>
                  <span className="shrink-0 text-xs text-muted">{timeAgo(n.created_at)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
