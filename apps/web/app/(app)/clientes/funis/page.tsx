import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { daysSince, str, type SP } from "@/lib/context";
import { Badge, Button, Card, cn, Empty, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { createDealAction, deleteDealAction, moveDealAction } from "./actions";

export const metadata = { title: "Funis" };

const KIND: Record<string, string> = { B2C: "Varejo", B2B_CORPORATE: "Corporativo", AFFILIATE_RECRUIT: "Afiliadas", EVENT: "Eventos" };
const CLOSED_SHOWN = 12;

export default async function FunisPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const canWrite = can(session, "crm.write");
  const supabase = await createClient();
  const { data: pipelines } = await supabase.schema("crm").from("pipelines").select("id, name, kind").order("name");
  const pipe = (pipelines ?? []).find((p) => p.id === str(sp.f)) ?? (pipelines ?? []).find((p) => p.kind === "B2C") ?? (pipelines ?? [])[0];
  if (!pipe) return <><PageHeader title="Funis" /><Empty title="Nenhum funil configurado" /></>;
  const mine = str(sp.dono) === "minhas";

  let dq = supabase.schema("crm").from("deals").select("id, title, party_id, stage_id, value_estimated, owner_member_id, status, lost_reason, updated_at, parties(display_name)").eq("pipeline_id", pipe.id).order("updated_at", { ascending: false }).limit(500);
  if (mine) dq = dq.eq("owner_member_id", session.memberId);
  const [{ data: stages }, { data: deals }, { data: members }] = await Promise.all([
    supabase.schema("crm").from("pipeline_stages").select("id, name, position, probability, sla_hours, is_won, is_lost").eq("pipeline_id", pipe.id).order("position"),
    dq,
    supabase.schema("core").from("members").select("id, display_name").order("display_name"),
  ]);
  const owner = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const open = (deals ?? []).filter((d) => d.status === "OPEN");
  const prob = new Map((stages ?? []).map((s) => [s.id, Number(s.probability)]));
  const total = open.reduce((a, d) => a + Number(d.value_estimated ?? 0), 0);
  const weighted = open.reduce((a, d) => a + Number(d.value_estimated ?? 0) * (prob.get(d.stage_id) ?? 0) / 100, 0);
  const href = (extra: Record<string, string>) => `/clientes/funis?${new URLSearchParams({ f: pipe.id, ...extra }).toString()}`;

  return (
    <>
      <PageHeader title="Funis & oportunidades" description="Cada oportunidade anda por etapas até ser ganha ou perdida (com o motivo). Tudo fica na linha do tempo da cliente." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {(pipelines ?? []).map((p) => (
          <Link key={p.id} href={`/clientes/funis?f=${p.id}`} className={cn("rounded-full border px-3 py-1 text-sm", p.id === pipe.id ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2")}>
            {p.name} <span className="text-xs text-muted">{KIND[p.kind] ?? ""}</span>
          </Link>
        ))}
        <span className="ml-auto flex gap-1.5 text-sm">
          <Link href={href({})} className={cn("rounded-lg px-2 py-1", !mine ? "bg-surface-2 font-medium" : "hover:bg-surface-2")}>Todas</Link>
          <Link href={href({ dono: "minhas" })} className={cn("rounded-lg px-2 py-1", mine ? "bg-surface-2 font-medium" : "hover:bg-surface-2")}>Minhas</Link>
        </span>
      </div>
      <p className="mb-3 text-sm text-muted">{open.length} em aberto · {formatBRL(total)} estimados · {formatBRL(weighted)} ponderados pela chance de cada etapa</p>

      {canWrite && (
        <Card title="Nova oportunidade" className="mb-4">
          <form action={createDealAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.2fr_1.5fr_8rem_1fr_auto] lg:items-end">
            <input type="hidden" name="pipeline_id" value={pipe.id} />
            <Field label="Cliente" hint="Nome (ou parte) ou telefone"><input name="party" required minLength={2} className={inputClass} placeholder="Ana Souza" /></Field>
            <Field label="O que está em jogo"><input name="title" required minLength={2} maxLength={120} className={inputClass} placeholder="Kit treino de inverno" /></Field>
            <Field label="Valor (R$)"><input name="value" inputMode="decimal" className={inputClass} placeholder="890,00" /></Field>
            <Field label="Responsável"><select name="owner" defaultValue={session.memberId} className={inputClass}>{(members ?? []).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>
            <Button>Criar</Button>
          </form>
        </Card>
      )}

      <div className="flex gap-3 overflow-x-auto pb-3">
        {(stages ?? []).map((s) => {
          const all = (deals ?? []).filter((d) => d.stage_id === s.id);
          const shown = s.is_won || s.is_lost ? all.slice(0, CLOSED_SHOWN) : all;
          const sum = all.reduce((a, d) => a + Number(d.value_estimated ?? 0), 0);
          return (
            <section key={s.id} aria-label={s.name} className="w-72 shrink-0 rounded-xl border border-border bg-surface-2/40">
              <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div>
                  <h2 className="text-sm font-semibold">{s.name}</h2>
                  <p className="text-[11px] text-muted">{all.length} · {formatBRL(sum)}{s.sla_hours ? ` · SLA ${s.sla_hours} h` : ""}</p>
                </div>
                {s.is_won && <Badge tone="success">ganho</Badge>}{s.is_lost && <Badge tone="danger">perdido</Badge>}
              </header>
              <ul className="space-y-2 p-2">
                {shown.length === 0 && <li className="px-1 py-3 text-center text-xs text-muted">Vazio</li>}
                {shown.map((d) => {
                  const age = daysSince(d.updated_at);
                  const late = s.sla_hours && d.status === "OPEN" && age !== null && age * 24 > s.sla_hours;
                  return (
                    <li key={d.id} className="rounded-lg border border-border bg-surface p-2.5 text-sm shadow-sm">
                      <Link href={`/clientes/${d.party_id}`} className="font-medium hover:underline">{d.title}</Link>
                      <p className="text-xs text-muted">{d.parties?.display_name}{d.owner_member_id ? ` · ${owner.get(d.owner_member_id) ?? ""}` : ""}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                        {d.value_estimated != null && <span className="font-medium tabular-nums">{formatBRL(Number(d.value_estimated))}</span>}
                        <span className="text-muted">{age === 0 ? "hoje" : `há ${age} d`}</span>
                        {late && <Badge tone="warning">passou do SLA</Badge>}
                      </p>
                      {d.lost_reason && <p className="mt-1 text-xs text-danger">Motivo: {d.lost_reason}</p>}
                      {canWrite && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-brand">Mover</summary>
                          <form action={moveDealAction} className="mt-2 space-y-1.5">
                            <input type="hidden" name="deal_id" value={d.id} /><input type="hidden" name="pipeline_id" value={pipe.id} />
                            <select name="stage_id" defaultValue="" required className={inputClass} aria-label="Nova etapa">
                              <option value="" disabled>Para a etapa…</option>
                              {(stages ?? []).filter((x) => x.id !== s.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                            </select>
                            <input name="reason" className={inputClass} placeholder="Motivo (obrigatório ao perder)" maxLength={200} />
                            <div className="flex gap-2"><Button variant="secondary" className="px-2 py-1 text-xs">Mover</Button></div>
                          </form>
                          <form action={deleteDealAction} className="mt-1"><input type="hidden" name="deal_id" value={d.id} /><input type="hidden" name="pipeline_id" value={pipe.id} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Excluir</Button></form>
                        </details>
                      )}
                    </li>
                  );
                })}
                {all.length > shown.length && <li className="px-1 text-center text-[11px] text-muted">+ {all.length - shown.length} mais antigas</li>}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
