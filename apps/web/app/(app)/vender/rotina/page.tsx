import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Button, Card, cn, Empty, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { completeRoutineAction, saveRoutineTemplateAction } from "./actions";
import { RoutineChecklist, type RoutineItem } from "./checklist";

export const metadata = { title: "Rotina da loja" };

interface Status { date: string; items: RoutineItem[]; completed_at: string | null; completed_by: string | null; notes: string | null }

export default async function RotinaPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("sales.read");
  const sp = await searchParams;
  const store = session.stores.find((s) => s.id === session.storeId) ?? session.stores[0];
  if (!store) return <Empty title="Escolha uma loja no topo da tela" />;
  const hour = Number(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }));
  const kind = str(sp.r) === "CLOSING" || (!str(sp.r) && hour >= 15) ? "CLOSING" : "OPENING";
  const supabase = await createClient();
  const { data, error } = await supabase.schema("sales").rpc("routine_status", { p_store: store.id, p_kind: kind });
  const st = data as unknown as Status | null;
  const isAdmin = can(session, "core.admin");
  const { data: tpl } = isAdmin ? await supabase.schema("core").from("settings").select("value").eq("key", "store_routines").maybeSingle() : { data: null };
  // modelo atual (ou o padrão, lido da própria rotina) para o administrador editar
  const other = isAdmin && !tpl ? (await supabase.schema("sales").rpc("routine_status", { p_store: store.id, p_kind: kind === "OPENING" ? "CLOSING" : "OPENING" })).data as unknown as Status | null : null;
  const manual = (k: "opening" | "closing") => {
    const saved = (tpl?.value as Record<string, { label: string }[]> | undefined)?.[k];
    const fromStatus = ((k === "opening") === (kind === "OPENING") ? st : other)?.items.filter((i) => !i.auto) ?? [];
    return (saved ?? fromStatus).map((i) => i.label).join("\n");
  };
  const pending = (st?.items ?? []).filter((i) => !i.ok).length;

  return (
    <>
      <PageHeader title="Rotina da loja" description={`${store.name} · ${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "long" })}`} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro) ?? error?.message} />
      <div className="mb-4 flex gap-2">
        {(["OPENING", "CLOSING"] as const).map((k) => (
          <Link key={k} href={`/vender/rotina?r=${k}`} className={cn("rounded-lg border px-3 py-1.5 text-sm", kind === k ? "border-brand bg-brand/10 text-brand" : "border-border")}>{k === "OPENING" ? "Abertura" : "Fechamento"}</Link>
        ))}
      </div>
      {st && (
        <Card title={kind === "OPENING" ? "Abrir a loja" : "Fechar a loja"}>
          <RoutineChecklist storeId={store.id} kind={kind} items={st.items} editable={can(session, "sales.write")} />
          {st.completed_at ? (
            <p className="mt-4 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
              {kind === "OPENING" ? "Abertura" : "Fechamento"} registrado às {new Date(st.completed_at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}{st.completed_by ? ` por ${st.completed_by}` : ""}{st.notes ? ` · ${st.notes}` : ""}.
            </p>
          ) : can(session, "sales.write") && (
            <form action={completeRoutineAction} className="mt-4 flex flex-wrap items-end gap-2">
              <input type="hidden" name="store_id" value={store.id} /><input type="hidden" name="kind" value={kind} />
              <Field label="Observação (opcional)" className="min-w-64 flex-1"><input name="notes" maxLength={300} className={inputClass} placeholder={kind === "CLOSING" ? "Ex.: troco de R$ 150 no caixa" : ""} /></Field>
              <Button variant={pending ? "secondary" : "primary"}>{pending ? `Concluir com ${pending} pendência(s)` : kind === "OPENING" ? "Loja aberta" : "Loja fechada"}</Button>
            </form>
          )}
        </Card>
      )}
      {isAdmin && (
        <Card className="mt-4" title="Itens marcados à mão (os automáticos o sistema confere sozinho)">
          <form action={saveRoutineTemplateAction} className="grid gap-3 sm:grid-cols-2">
            <Field label="Abertura (um por linha)"><textarea name="opening" rows={5} defaultValue={manual("opening")} className={inputClass} /></Field>
            <Field label="Fechamento (um por linha)"><textarea name="closing" rows={5} defaultValue={manual("closing")} className={inputClass} /></Field>
            <div><Button variant="secondary">Salvar rotina</Button></div>
          </form>
        </Card>
      )}
    </>
  );
}
