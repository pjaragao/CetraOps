import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge, Button, Card, Empty, PageHeader, Table, inputClass } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { deleteCaseAction, requestEvalAction, saveCaseAction } from "./actions";

export const metadata = { title: "Avaliações da IA" };

interface Rank { batch_id: string; model: string; created_at: string; cases: number; passed: number; factual_failures: number; handoff_misses: number; p95_latency_ms: number | null; cost_per_case: number; pass_rate: number; gate_ok: boolean; in_use: boolean | null }
const OUTCOMES = [["SEND", "Envia sozinha"], ["DRAFT", "Vira rascunho"], ["HANDOFF", "Vai para uma pessoa"]] as const;
const STATUS: Record<string, string> = { QUEUED: "na fila", RUNNING: "rodando", DONE: "concluída", FAILED: "falhou" };
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export default async function AvaliacoesPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("ai.read");
  const sp = await searchParams;
  const canWrite = can(session, "ai.write");
  const supabase = await createClient();
  const [{ data: ranking }, { data: cases }, { data: requests }, { data: route }] = await Promise.all([
    supabase.schema("ai").rpc("eval_ranking", { p_task: "conversation" }),
    supabase.schema("ai").from("eval_cases").select("id, key, title, turns, expect, active").order("key"),
    supabase.schema("ai").from("eval_requests").select("id, models, status, requested_at, error, progress").order("requested_at", { ascending: false }).limit(5),
    supabase.schema("ai").from("model_routes").select("primary_model").eq("task", "conversation").maybeSingle(),
  ]);
  const rank = (ranking as unknown as Rank[] | null) ?? [];
  const running = (requests ?? []).some((r) => r.status === "QUEUED" || r.status === "RUNNING");
  const { data: failures } = rank.length
    ? await supabase.schema("ai").from("eval_results").select("batch_id, case_key, failures").in("batch_id", rank.map((r) => r.batch_id)).eq("passed", false)
    : { data: [] as { batch_id: string; case_key: string; failures: unknown }[] };

  return (
    <>
      <PageHeader title="Avaliações da IA" description="O mesmo conjunto de conversas de teste roda em cada modelo, pelo atendimento de verdade, sem criar nada de verdade. O modelo de atendimento só troca depois de passar aqui: sem número inventado, sem desconto, transferindo quando deve." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {running && <AutoRefresh every={5000} times={60} />}

      <h2 className="mb-2 text-sm font-semibold text-muted">Ranking (último resultado de cada modelo)</h2>
      {rank.length === 0 ? <Empty title="Nenhuma avaliação rodada ainda">Peça a primeira abaixo, com o modelo atual e os candidatos.</Empty> : (
        <Table head={["Modelo", "Passou", "Sem fundamento", "Handoff perdido", "Latência p95", "US$ por caso", "Portão", "Quando"]}>
          {rank.map((r) => (
            <tr key={r.batch_id}>
              <td className="px-3 py-2 font-medium">{r.model}{r.in_use && <span className="ml-1"><Badge tone="info">em uso</Badge></span>}</td>
              <td className="px-3 py-2 tabular-nums">{r.passed}/{r.cases} ({Math.round(r.pass_rate * 100)}%)</td>
              <td className="px-3 py-2 tabular-nums">{r.factual_failures > 0 ? <Badge tone="danger">{r.factual_failures}</Badge> : "0"}</td>
              <td className="px-3 py-2 tabular-nums">{r.handoff_misses}</td>
              <td className="px-3 py-2 tabular-nums">{r.p95_latency_ms ? `${(r.p95_latency_ms / 1000).toFixed(1)} s` : "—"}</td>
              <td className="px-3 py-2 tabular-nums">{Number(r.cost_per_case).toFixed(4)}</td>
              <td className="px-3 py-2">{r.gate_ok ? <Badge tone="success">liberado</Badge> : <Badge tone="warning">barrado</Badge>}</td>
              <td className="px-3 py-2 text-xs">{when(r.created_at)}</td>
            </tr>
          ))}
        </Table>
      )}
      {(failures ?? []).length > 0 && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-muted">Casos que falharam</summary>
          <ul className="mt-2 space-y-1">
            {(failures ?? []).map((f, i) => (
              <li key={i}><span className="font-medium">{rank.find((r) => r.batch_id === f.batch_id)?.model}</span> · {f.case_key}: <span className="text-muted">{(f.failures as string[]).join("; ")}</span></li>
            ))}
          </ul>
        </details>
      )}
      <p className="mt-2 text-xs text-muted">Modelo de atendimento atual: {route?.primary_model ?? "—"}. Para entrar na rota, o modelo precisa de uma avaliação dos últimos 30 dias com pelo menos 8 casos, nenhuma resposta sem fundamento e 90% de aprovação.</p>

      {canWrite && (
        <Card title="Rodar avaliação" className="mt-4">
          <form action={requestEvalAction} className="flex flex-wrap items-end gap-2">
            <Field label="Modelos (slugs do OpenRouter, separados por vírgula, até 4)" className="min-w-72 flex-1">
              <input name="models" required defaultValue={route?.primary_model ?? ""} className={inputClass} placeholder="provedor/modelo-a, provedor/modelo-b" />
            </Field>
            <Button disabled={running}>{running ? "Avaliação em andamento…" : "Rodar avaliação"}</Button>
          </form>
          <p className="mt-2 text-xs text-muted">Cada caso é uma chamada de verdade ao modelo (custo em tokens). O resultado chega em alguns minutos e você é avisado.</p>
          {(requests ?? []).length > 0 && (
            <ul className="mt-3 space-y-1 text-xs">
              {(requests ?? []).map((r) => (
                <li key={r.id}>{when(r.requested_at)} · {r.models.join(", ")} · <b>{STATUS[r.status]}</b>{r.progress && r.status === "RUNNING" ? ` (${r.progress})` : ""}{r.error ? ` — ${r.error}` : ""}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <h2 className="mt-6 mb-2 text-sm font-semibold text-muted">Casos de teste ({(cases ?? []).length})</h2>
      <Table head={["Caso", "Conversa", "Espera", ""]}>
        {(cases ?? []).map((c) => {
          const e = c.expect as Record<string, unknown>;
          const parts = [e.outcome_in ? `resultado: ${(e.outcome_in as string[]).join(" ou ")}` : null, e.tools_any ? `consulta: ${(e.tools_any as string[]).join(" ou ")}` : null, e.no_flags ? "sem reprovação do validador" : null,
            e.must_not_match ? `não pode: ${(e.must_not_match as string[]).length} regra(s)` : null, e.must_match_any ? `precisa: ${(e.must_match_any as string[]).length} regra(s)` : null].filter(Boolean);
          const turns = c.turns as { role: string; text: string }[];
          return (
            <tr key={c.id}>
              <td className="px-3 py-2"><p className="font-medium">{c.title}</p><p className="font-mono text-[11px] text-muted">{c.key}</p></td>
              <td className="px-3 py-2 text-xs">{turns.map((t, i) => <p key={i}><span className="text-muted">{t.role === "user" ? "Cliente" : "IA"}:</span> {t.text}</p>)}</td>
              <td className="px-3 py-2 text-xs">{parts.join(" · ") || "—"}</td>
              <td className="px-3 py-2">{canWrite && <form action={deleteCaseAction}><input type="hidden" name="id" value={c.id} /><Button variant="ghost" className="px-2 py-1 text-xs">Apagar</Button></form>}</td>
            </tr>
          );
        })}
      </Table>

      {canWrite && (
        <Card title="Novo caso de teste" className="mt-4">
          <form action={saveCaseAction} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Chave (letras minúsculas, números, - ou _)"><input name="key" required pattern="[a-z0-9][a-z0-9_-]{1,59}" className={inputClass} placeholder="cliente-pede-prazo" /></Field>
              <Field label="Título"><input name="title" required minLength={3} maxLength={140} className={inputClass} placeholder="Pergunta o prazo de entrega" /></Field>
            </div>
            <Field label="Conversa (uma fala por linha; comece a fala da IA com “IA:”; a última tem de ser da cliente)">
              <textarea name="turns" required rows={3} className={inputClass} placeholder={"Oi, tudo bem?\nIA: Oi! Como posso ajudar?\nQuanto tempo leva a entrega?"} />
            </Field>
            <fieldset className="flex flex-wrap gap-3 text-sm">
              <legend className="mb-1 text-xs text-muted">O resultado esperado é (marque os aceitos)</legend>
              {OUTCOMES.map(([v, l]) => <label key={v} className="flex items-center gap-1"><input type="checkbox" name="outcome_in" value={v} /> {l}</label>)}
              <label className="flex items-center gap-1"><input type="checkbox" name="no_flags" defaultChecked /> sem reprovação do validador</label>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Precisa consultar (ferramentas, vírgula)"><input name="tools_any" className={inputClass} placeholder="search_catalog, get_policies" /></Field>
              <Field label="A resposta não pode conter (regex, uma por linha)"><textarea name="must_not_match" rows={2} className={inputClass} /></Field>
              <Field label="A resposta precisa conter uma destas (regex, uma por linha)"><textarea name="must_match_any" rows={2} className={inputClass} /></Field>
            </div>
            <Button variant="secondary">Salvar caso</Button>
          </form>
        </Card>
      )}
    </>
  );
}
