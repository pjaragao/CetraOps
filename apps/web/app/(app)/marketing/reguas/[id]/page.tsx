import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL, RELATION_OPTIONS, relativeLabel } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, PageHeader, Stat, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { deleteStepAction, saveJourneyAction, saveStepAction, toggleJourneyAction } from "../actions";
import { ACTIONS, EXIT_LABEL, RESULT_LABEL, TRIGGERS } from "../labels";

export const metadata = { title: "Régua" };

interface Group { enrolled: number; converted: number; revenue: number; matured: number; rate: number | null }
interface CouponReport { issued: number; redeemed: number; open: number; expired: number; discount: number; revenue: number }
interface Report { groups: Record<string, Group>; active: number; exits: Record<string, number>; steps: { position: number; result: string; n: number; done: number }[]; window_days: number }

export default async function ReguaPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const sp = await searchParams;
  const session = await requirePerm("crm.read");
  const canWrite = can(session, "crm.write");
  const supabase = await createClient();
  const isNew = id === "nova";
  const [{ data: j }, { data: steps }, { data: templates }] = await Promise.all([
    isNew ? Promise.resolve({ data: null }) : supabase.schema("mkt").from("journeys").select("*").eq("id", id).maybeSingle(),
    isNew ? Promise.resolve({ data: [] as never[] }) : supabase.schema("mkt").from("journey_steps").select("*").eq("journey_id", id).order("position"),
    supabase.schema("omni").from("templates").select("id, name, status").eq("category", "MARKETING").order("name"),
  ]);
  if (!isNew && !j) notFound();
  const { data: rep } = j ? await supabase.schema("mkt").rpc("journey_report", { p_journey: j.id, p_days: 30 }) : { data: null };
  const r = rep as unknown as Report | null;
  const { data: cr } = j && (j.trigger_config as { coupon?: unknown } | null)?.coupon ? await supabase.schema("mkt").rpc("journey_coupon_report", { p_journey: j.id }) : { data: null };
  const cp = cr as unknown as CouponReport | null;
  const cfg = (j?.trigger_config ?? {}) as { days?: number; days_before?: number; after_days?: number; reasons?: string[]; occasion?: string; roles?: string[]; coupon?: { enabled?: boolean; percent?: number; days_after?: number; min_order?: number } };
  const editStep = (steps ?? []).find((s) => s.id === str(sp.passo));
  const nextPos = Math.min(10, ((steps ?? []).at(-1)?.position ?? 0) + 1);
  const t = r?.groups.TREATMENT, h = r?.groups.HOLDOUT;
  const lift = t?.rate != null && h?.rate != null ? Math.round((t.rate - h.rate) * 10) / 10 : null;

  return (
    <>
      <PageHeader title={j?.name ?? "Nova régua"} description={j ? `${TRIGGERS[j.trigger]?.label ?? j.trigger} · ${j.holdout_pct}% no grupo de controle` : "Escolha o gatilho e depois crie os passos."}
        actions={<div className="flex items-center gap-2">{j && <Badge tone={j.active ? "success" : "neutral"}>{j.active ? "ligada" : "desligada"}</Badge>}
          {j && canWrite && <form action={toggleJourneyAction}><input type="hidden" name="id" value={j.id} /><input type="hidden" name="active" value={j.active ? "0" : "1"} /><Button variant="secondary" className="px-2 py-1 text-xs">{j.active ? "Desligar" : "Ligar"}</Button></form>}
          <Link href="/marketing/reguas" className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Réguas</Link></div>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      {r && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Em andamento" value={r.active} />
            <Stat label="Compraram em 30 dias (tratamento)" value={t ? `${t.converted} de ${t.enrolled}` : "—"} hint={t?.rate != null ? `${t.rate}% · ${formatBRL(Number(t.revenue))}` : undefined} />
            <Stat label="Compraram em 30 dias (controle)" value={h ? `${h.converted} de ${h.enrolled}` : "—"} hint={h?.rate != null ? `${h.rate}% sem receber nada` : "ninguém no controle ainda"} />
            <Stat label="Efeito da régua" value={lift != null ? `${lift > 0 ? "+" : ""}${lift} p.p.` : "—"} tone={lift != null && lift > 0 ? "success" : undefined} hint="Diferença tratamento − controle. Com base pequena, olhe a tendência ao longo dos meses." />
          </div>
          {cp && (
            <div className="mb-4">
              <h2 className="mb-2 text-sm font-semibold">Eficácia do cupom</h2>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Cupons emitidos" value={cp.issued} hint={`${cp.open} ainda valendo · ${cp.expired} vencidos sem uso`} />
                <Stat label="Cupons usados" value={cp.redeemed} tone={cp.redeemed > 0 ? "success" : undefined} hint={cp.issued > 0 ? `${Math.round((cp.redeemed / cp.issued) * 1000) / 10}% dos emitidos` : undefined} />
                <Stat label="Vendas com o cupom" value={formatBRL(Number(cp.revenue))} hint="Total dos pedidos que usaram o cupom" />
                <Stat label="Desconto dado" value={formatBRL(Number(cp.discount))} />
              </div>
            </div>
          )}
          {(r.steps.length > 0 || Object.keys(r.exits).length > 0) && (
            <Card className="mb-4" title="O que aconteceu">
              <div className="grid gap-4 sm:grid-cols-2 text-sm">
                <ul className="space-y-1">{r.steps.map((s) => <li key={`${s.position}-${s.result}`}>Passo {s.position}: {s.n} {RESULT_LABEL[s.result] ?? s.result}{s.result === "TASK" ? ` (${s.done} feitas)` : ""}</li>)}</ul>
                <ul className="space-y-1">{Object.entries(r.exits).map(([k, n]) => <li key={k}>{EXIT_LABEL[k] ?? k}: {n}</li>)}</ul>
              </div>
            </Card>
          )}
        </>
      )}

      {j && (
        <>
          <h2 className="mb-2 text-sm font-semibold">Passos</h2>
          {(steps ?? []).length === 0 ? <Empty title="Nenhum passo">Crie o primeiro abaixo: a régua só liga com passos.</Empty> : (
            <Table head={["#", "Quando", "O que faz", "Título / mensagem", ""]}>
              {(steps ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="px-3 py-2 tabular-nums">{s.position}</td>
                  <td className="px-3 py-2 text-xs">{Number(s.wait_days) === 0 ? (s.position === 1 ? "na entrada" : "logo depois") : `${String(s.wait_days).replace(".", ",")} dia(s) depois`}</td>
                  <td className="px-3 py-2 text-xs">{ACTIONS[s.action]?.label}</td>
                  <td className="px-3 py-2 text-xs"><b>{s.title}</b>{s.message && <span className="block text-muted">{s.message}</span>}</td>
                  <td className="px-3 py-2">{canWrite && <div className="flex gap-1">
                    <Link href={`/marketing/reguas/${j.id}?passo=${s.id}`} className="rounded-lg px-2 py-1 text-xs hover:bg-surface-2">Editar</Link>
                    <form action={deleteStepAction}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="journey_id" value={j.id} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Remover</Button></form>
                  </div>}</td>
                </tr>
              ))}
            </Table>
          )}
          {canWrite && (
            <Card className="mt-4" title={editStep ? `Editar passo ${editStep.position}` : "Novo passo"}>
              <form key={editStep?.id ?? "novo"} action={saveStepAction} className="space-y-3">
                <input type="hidden" name="journey_id" value={j.id} />{editStep && <input type="hidden" name="id" value={editStep.id} />}
                <div className="grid gap-3 sm:grid-cols-4">
                  <Field label="Posição"><input name="position" type="number" min={1} max={10} required defaultValue={editStep?.position ?? nextPos} className={inputClass} /></Field>
                  <Field label="Espera (dias)" hint="Desde o passo anterior; o 1º conta da entrada"><input name="wait_days" inputMode="decimal" required defaultValue={String(editStep?.wait_days ?? 0).replace(".", ",")} className={inputClass} /></Field>
                  <Field label="O que faz"><select name="action" defaultValue={editStep?.action ?? "TASK"} className={inputClass}>{Object.entries(ACTIONS).map(([k, a]) => <option key={k} value={k}>{a.label}</option>)}</select></Field>
                  <Field label="Prazo da tarefa (h)"><input name="due_hours" type="number" min={1} max={720} defaultValue={editStep?.due_hours ?? 24} className={inputClass} /></Field>
                </div>
                <Field label="Título (tarefa)" hint="Use {nome}"><input name="title" required minLength={3} maxLength={140} defaultValue={editStep?.title ?? ""} className={inputClass} placeholder="Convidar {nome} para provar" /></Field>
                <Field label="Mensagem" hint="Use {nome}, {tamanho}, {ultima_peca}, {data_limite}, {loja}, {cupom}, {desconto}, {validade_cupom}; nas réguas de família também {parente}, {nome_parente}, {data_parente}"><textarea name="message" rows={3} maxLength={1000} defaultValue={editStep?.message ?? ""} className={inputClass} /></Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Template de marketing (só para 'Template de marketing')"><select name="template_id" defaultValue={editStep?.template_id ?? ""} className={inputClass}><option value="">—</option>{(templates ?? []).map((tp) => <option key={tp.id} value={tp.id}>{tp.name}{tp.status !== "APPROVED" ? " (não aprovado)" : ""}</option>)}</select></Field>
                  <Field label="Variáveis do template, em ordem" hint="FIRST_NAME, SIZE, DEADLINE"><input name="template_vars" defaultValue={((editStep?.template_vars ?? []) as string[]).join(", ")} className={`${inputClass} font-mono text-xs`} /></Field>
                </div>
                <p className="text-xs text-muted">{Object.values(ACTIONS).map((a) => `${a.label}: ${a.help}`).join(" · ")}</p>
                <div className="flex items-center gap-3"><Button>Salvar passo</Button>{editStep && <Link href={`/marketing/reguas/${j.id}`} className="text-xs text-brand">Cancelar</Link>}</div>
              </form>
            </Card>
          )}
        </>
      )}

      {canWrite && (
        <Card className="mt-6" title={j ? "Configuração da régua" : "Nova régua"}>
          <form action={saveJourneyAction} className="space-y-3">
            {j && <input type="hidden" name="id" value={j.id} />}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Nome"><input name="name" required minLength={3} maxLength={80} defaultValue={j?.name ?? ""} className={inputClass} /></Field>
              <Field label="Gatilho"><select name="trigger" defaultValue={j?.trigger ?? "NO_SECOND_PURCHASE"} className={inputClass}>{Object.entries(TRIGGERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
              <Field label="Grupo de controle (%)" hint="0 a 50; recomendado 10"><input name="holdout_pct" type="number" min={0} max={50} defaultValue={j?.holdout_pct ?? 10} className={inputClass} /></Field>
            </div>
            <Field label="Descrição"><input name="description" maxLength={200} defaultValue={j?.description ?? ""} className={inputClass} /></Field>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Sem 2ª compra: dias"><input name="days" type="number" min={7} max={180} defaultValue={cfg.days ?? ""} className={inputClass} placeholder="30" /></Field>
              <Field label="Aniversário: dias antes" hint="Quando a cliente entra e o cupom começa a valer. Deixe a espera do 1º passo igual a este número para o contato sair no dia"><input name="days_before" type="number" min={0} max={30} defaultValue={cfg.days_before ?? ""} className={inputClass} placeholder="10" /></Field>
              <Field label="Perdida: dias depois"><input name="after_days" type="number" min={1} max={90} defaultValue={cfg.after_days ?? ""} className={inputClass} placeholder="7" /></Field>
              <Field label="Perdida: motivos" hint="Separados por vírgula"><input name="reasons" defaultValue={(cfg.reasons ?? []).join(", ")} className={inputClass} placeholder="sem retorno, tamanho" /></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Cupom pessoal: desconto (%)" hint="Gera um cupom por cliente (vale só para ela, 1 uso). Vazio = sem cupom. Use {cupom}, {desconto} e {validade_cupom} no texto."><input name="coupon_percent" inputMode="decimal" defaultValue={cfg.coupon?.enabled === false ? "" : String(cfg.coupon?.percent ?? "").replace(".", ",")} className={inputClass} placeholder="5" /></Field>
              <Field label="Cupom vale até (dias depois)" hint="Começa quando a cliente entra na régua (dias antes do aniversário) e vai até este tanto depois dele"><input name="coupon_days_after" type="number" min={0} max={365} defaultValue={cfg.coupon?.days_after ?? 20} className={inputClass} /></Field>
              <Field label="Cupom: pedido mínimo (R$)" hint="Opcional"><input name="coupon_min_order" inputMode="decimal" defaultValue={String(cfg.coupon?.min_order ?? "").replace(".", ",")} className={inputClass} /></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
              <Field label="Data comemorativa" hint="Só para o gatilho “Data comemorativa”">
                <select name="occasion" defaultValue={cfg.occasion ?? ""} className={inputClass}><option value="">—</option><option value="MOTHERS_DAY">Dia das Mães</option><option value="FATHERS_DAY">Dia dos Pais</option><option value="VALENTINES">Dia dos Namorados</option><option value="CHRISTMAS">Natal</option><option value="WOMENS_DAY">Dia da Mulher</option></select>
              </Field>
              <fieldset><legend className="mb-1 text-xs font-medium text-muted">Parentes que valem (vazio = o padrão da data)</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">{RELATION_OPTIONS.map((o) => <label key={o.value} className="flex items-center gap-1"><input type="checkbox" name="roles" value={o.value} defaultChecked={(cfg.roles ?? []).includes(o.value)} />{relativeLabel(o.value, null)}</label>)}</div>
              </fieldset>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="exit_on_purchase" defaultChecked={j?.exit_on_purchase ?? true} /> Sai da régua quando comprar (meta atingida)</label>
            <p className="text-xs text-muted">{j ? TRIGGERS[j.trigger]?.help : "Depois de salvar, crie os passos e ligue a régua."}</p>
            <Button variant="secondary">{j ? "Salvar configuração" : "Criar régua"}</Button>
          </form>
        </Card>
      )}
    </>
  );
}
