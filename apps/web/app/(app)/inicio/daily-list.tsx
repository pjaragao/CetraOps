import Link from "next/link";
import { Badge, Button, Card, Empty, inputClass } from "@/components/ui";
import { CopyButton } from "@/components/copy-button";
import { finishTaskAction, openWithMessageAction, snoozeTaskAction } from "./daily-actions";

export interface DailyAction {
  task_id: string; party_id: string; party_name: string; title: string; suggested_message: string | null; type: string; overdue: boolean; tier: string; reason: string;
}

/** "Minha lista de hoje": contatos de relacionamento do dia, já ordenados por urgência e valor (crm.daily_actions). */
export function DailyList({ items, canSend }: { items: DailyAction[]; canSend: boolean }) {
  return (
    <Card title="Minha lista de hoje" action={<Link href="/clientes/tarefas" className="text-xs text-brand">todas as tarefas</Link>}>
      {items.length === 0 ? <Empty title="Nada para hoje">Aniversários, pós-compra, clientes em risco e retomadas aparecem aqui.</Empty> : (
        <ol className="divide-y divide-border">
          {items.map((t, i) => (
            <li key={t.task_id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs tabular-nums text-muted">{i + 1}.</span>
                <Link href={`/clientes/${t.party_id}`} className="font-medium text-brand">{t.party_name}</Link>
                <span className="text-sm">{t.title}</span>
                {t.reason && <Badge tone={t.overdue ? "danger" : t.tier !== "STANDARD" ? "warning" : "neutral"}>{t.reason}</Badge>}
              </div>
              {t.suggested_message && <p className="mt-1 rounded-lg bg-surface-2 px-3 py-2 text-sm">{t.suggested_message}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {canSend && t.suggested_message && (
                  <form action={openWithMessageAction}>
                    <input type="hidden" name="party_id" value={t.party_id} /><input type="hidden" name="message" value={t.suggested_message} /><input type="hidden" name="task_id" value={t.task_id} />
                    <Button className="px-2 py-1 text-xs">Enviar pela conversa</Button>
                  </form>
                )}
                {t.suggested_message && <CopyButton text={t.suggested_message} label="Copiar (app)" />}
                <form action={finishTaskAction}><input type="hidden" name="task_id" value={t.task_id} /><input type="hidden" name="status" value="DONE" /><Button variant="secondary" className="px-2 py-1 text-xs">Feito</Button></form>
                <form action={snoozeTaskAction}><input type="hidden" name="task_id" value={t.task_id} /><Button variant="ghost" className="px-2 py-1 text-xs">Amanhã</Button></form>
                <form action={finishTaskAction} className="flex items-center gap-1">
                  <input type="hidden" name="task_id" value={t.task_id} /><input type="hidden" name="status" value="CANCELLED" />
                  <input name="note" required minLength={3} maxLength={300} placeholder="motivo para pular" aria-label={`Motivo para pular: ${t.party_name}`} className={`${inputClass} w-40 py-1 text-xs`} />
                  <Button variant="ghost" className="px-2 py-1 text-xs">Pular</Button>
                </form>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
