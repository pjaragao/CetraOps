import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge, Button, Card, cn, Empty, inputClass, PageHeader, Stat, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { deleteSourceAction, newVersionAction, requestProfileAction, requestTaskAction, setIncludedAction } from "../actions";
import { UploadForm } from "./upload-form";
import { VersionEditor } from "./version-editor";

export const metadata = { title: "Persona" };

const PAGE = 15;
const MIN = 300;
const SOURCE: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  UPLOADED: { label: "na fila", tone: "neutral" }, PROCESSING: { label: "tratando…", tone: "warning" }, READY: { label: "pronto", tone: "success" }, FAILED: { label: "falhou", tone: "danger" },
};
const FILTERS = [{ key: "todos", label: "Todos" }, { key: "fora", label: "Fora da persona" }, { key: "comerciais", label: "Comerciais" }, { key: "novos", label: "Sem classificação" }];

interface Narrative {
  resumo?: string; aberturas?: string[]; fechamentos?: string[]; vocativos?: string[]; lexico_marca?: string[]; tabus?: string[];
  tom_por_etapa?: { etapa: string; tom: string }[]; vendas?: Record<string, string>;
}
interface StyleProfile { stats?: { bubbles?: number; chars_per_bubble?: { mean?: number }; emoji?: { pct_bubbles_with_emoji?: number }; bubbles_per_turn?: { mean?: number } }; narrative?: Narrative; generated?: { warnings?: string[] } }
interface Turn { role: string; text: string }

const VENDAS: Record<string, string> = { objecao_preco: "Objeção de preço", tamanho_modelagem: "Tamanho e modelagem", fechamento: "Fechamento", followup: "Follow-up" };

export default async function PersonaPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("ai.read");
  const { id } = await params;
  const sp = await searchParams;
  const canWrite = can(session, "ai.write");
  const supabase = await createClient();
  const { data: persona } = await supabase.schema("ai").from("personas").select("id, name, member_id, active_version_id").eq("id", id).maybeSingle();
  if (!persona) notFound();

  const ai = supabase.schema("ai");
  const headD = () => ai.from("corpus_dialogues").select("*", { count: "exact", head: true }).eq("persona_id", id);
  const headP = () => ai.from("corpus_pairs").select("*", { count: "exact", head: true }).eq("persona_id", id);
  const filtro = FILTERS.some((f) => f.key === str(sp.filtro)) ? str(sp.filtro)! : "todos";
  const page = Math.max(1, Number(str(sp.p)) || 1);
  let dq = ai.from("corpus_dialogues").select("id, turns, commercial, topics, outcome, include", { count: "exact" }).eq("persona_id", id).order("created_at", { ascending: false }).order("id").range((page - 1) * PAGE, page * PAGE - 1);
  if (filtro === "fora") dq = dq.eq("include", false);
  if (filtro === "comerciais") dq = dq.eq("commercial", true);
  if (filtro === "novos") dq = dq.is("classified_at", null);

  const [versions, member, sources, usable, unclassified, pairsTotal, pairsIndexed, dialogues] = await Promise.all([
    ai.from("persona_versions").select("id, version, approved_at, system_prompt, guardrails, style_profile, created_at").eq("persona_id", id).order("version", { ascending: false }),
    persona.member_id ? supabase.schema("core").from("members").select("display_name").eq("id", persona.member_id).maybeSingle() : Promise.resolve({ data: null }),
    canWrite ? ai.from("corpus_sources").select("id, kind, filename, owner_name, status, stats, error, created_at").eq("persona_id", id).order("created_at", { ascending: false }) : Promise.resolve({ data: [] }),
    canWrite ? headD().eq("include", true).not("commercial", "is", false) : Promise.resolve({ count: 0 }),
    canWrite ? headD().is("classified_at", null) : Promise.resolve({ count: 0 }),
    canWrite ? headP() : Promise.resolve({ count: 0 }),
    canWrite ? headP().not("embedding", "is", null) : Promise.resolve({ count: 0 }),
    canWrite ? dq : Promise.resolve({ data: [], count: 0 }),
  ]);
  const usableN = usable.count ?? 0, unclassifiedN = unclassified.count ?? 0, pairsN = pairsTotal.count ?? 0, indexedN = pairsIndexed.count ?? 0;
  const processing = (sources.data ?? []).some((s) => s.status === "UPLOADED" || s.status === "PROCESSING");
  const vs = versions.data ?? [];
  const selected = vs.find((v) => v.id === str(sp.v)) ?? vs.find((v) => !v.approved_at) ?? vs.find((v) => v.id === persona.active_version_id) ?? vs[0];
  const profile = (selected?.style_profile ?? {}) as StyleProfile;
  const narrative = profile.narrative;
  const rules = ((selected?.guardrails as { extra_rules?: string[] } | null)?.extra_rules ?? []) as string[];
  const totalDialogues = dialogues.count ?? 0;
  const url = (extra: Record<string, string | number>) => `/ia/personas/${id}?${new URLSearchParams({ filtro, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) }).toString()}`;

  return (
    <>
      <PageHeader title={persona.name} description={member.data ? `Estilo de ${member.data.display_name}. A IA imita o jeito de escrever, sem se passar pela pessoa.` : "Persona da marca."}
        actions={<Link href="/ia/personas" className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Personas</Link>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(str(sp.wait) || processing) && <AutoRefresh />}

      {canWrite && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Diálogos aproveitáveis" value={`${usableN} / ${MIN}`} hint="O ideal é ter 300 ou mais" tone={usableN >= MIN ? "success" : "warning"} />
          <Stat label="Sem classificação" value={unclassifiedN} hint="A IA separa conversa comercial de pessoal" />
          <Stat label="Exemplos de resposta" value={pairsN} hint="Pares cliente → resposta" />
          <Stat label="Exemplos indexados" value={`${indexedN} / ${pairsN}`} hint="Busca por similaridade" tone={indexedN === pairsN ? undefined : "warning"} />
        </div>
      )}

      {canWrite && (
        <>
          <Card title="Histórico de conversas" className="mb-4">
            <UploadForm personaId={id} personaName={persona.name} />
            {(sources.data ?? []).length > 0 && (
              <div className="mt-4">
                <Table head={["Arquivo", "Origem", "Situação", "Resultado", ""]}>
                  {(sources.data ?? []).map((s) => {
                    const st = SOURCE[s.status] ?? SOURCE.UPLOADED;
                    const stats = (s.stats ?? {}) as Record<string, number>;
                    return (
                      <tr key={s.id}>
                        <td className="max-w-[14rem] truncate px-3 py-2 text-xs">{s.filename ?? "—"}</td>
                        <td className="px-3 py-2 text-xs">{s.kind === "WA_TXT" ? "WhatsApp" : "Instagram"}</td>
                        <td className="px-3 py-2"><Badge tone={st.tone}>{st.label}</Badge></td>
                        <td className="px-3 py-2 text-xs">{s.status === "READY" ? `${stats.imported_dialogues ?? 0} diálogos · ${stats.imported_pairs ?? 0} exemplos${stats.duplicate_dialogues ? ` · ${stats.duplicate_dialogues} repetidos` : ""}${stats.dialogues_dropped_residual_pii ? ` · ${stats.dialogues_dropped_residual_pii} descartados por dado pessoal` : ""}` : s.status === "FAILED" ? <span className="text-danger">{s.error}</span> : "—"}</td>
                        <td className="px-3 py-2"><form action={deleteSourceAction}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="persona_id" value={id} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Apagar</Button></form></td>
                      </tr>
                    );
                  })}
                </Table>
              </div>
            )}
          </Card>

          <Card title="Preparar o treino" className="mb-4">
            <div className="flex flex-wrap items-end gap-3">
              <form action={requestTaskAction}><input type="hidden" name="persona_id" value={id} /><input type="hidden" name="action" value="CLASSIFY" />
                <Button variant="secondary" disabled={unclassifiedN === 0}>Classificar com IA ({unclassifiedN})</Button></form>
              <form action={requestTaskAction}><input type="hidden" name="persona_id" value={id} /><input type="hidden" name="action" value="EMBED" />
                <Button variant="secondary" disabled={indexedN >= pairsN}>Indexar exemplos ({pairsN - indexedN})</Button></form>
              <form action={requestProfileAction} className="flex flex-1 flex-wrap items-end gap-2">
                <input type="hidden" name="persona_id" value={id} />
                <Field label="Vocabulário da marca (opcional)" hint="Termos que você quer acompanhar, separados por vírgula" className="min-w-[14rem] flex-1"><input name="lexicon" className={inputClass} placeholder="mimos, look, matcha" /></Field>
                <Button disabled={usableN < 10}>Gerar perfil de estilo</Button>
              </form>
            </div>
            <p className="mt-2 text-xs text-muted">Ordem sugerida: enviar o histórico → classificar → revisar os diálogos abaixo → indexar → gerar o perfil → revisar e aprovar a versão.</p>
          </Card>

          <Card title="Diálogos do histórico" className="mb-4">
            <div className="mb-3 flex flex-wrap gap-1.5">
              {FILTERS.map((f) => <Link key={f.key} href={`/ia/personas/${id}?filtro=${f.key}`} className={cn("rounded-full border px-3 py-1 text-sm", filtro === f.key ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2")}>{f.label}</Link>)}
            </div>
            {(dialogues.data ?? []).length === 0 ? <Empty title="Nenhum diálogo neste filtro" /> : (
              <form action={setIncludedAction}>
                <input type="hidden" name="persona_id" value={id} />
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {(dialogues.data ?? []).map((d) => {
                    const turns = (d.turns ?? []) as unknown as Turn[];
                    return (
                      <li key={d.id} className="px-3 py-2">
                        <div className="flex items-start gap-2">
                          <input type="checkbox" name="ids" value={d.id} className="mt-1" aria-label="Selecionar diálogo" />
                          <details className="min-w-0 flex-1">
                            <summary className="cursor-pointer text-sm">
                              <span className="mr-2 inline-flex flex-wrap gap-1 align-middle">
                                {d.commercial === null ? <Badge>sem classificação</Badge> : d.commercial ? <Badge tone="success">comercial</Badge> : <Badge tone="warning">pessoal</Badge>}
                                {!d.include && <Badge tone="danger">fora da persona</Badge>}
                                {d.outcome === "VENDA" && <Badge tone="brand">venda</Badge>}
                                {(d.topics ?? []).map((t) => <Badge key={t} tone="info">{t}</Badge>)}
                              </span>
                              <span className="text-muted">{turns[0]?.text.slice(0, 90)}</span>
                            </summary>
                            <div className="mt-2 space-y-1 text-sm">
                              {turns.map((t, i) => <p key={i} className={cn("max-w-[85%] whitespace-pre-line rounded-xl px-3 py-1.5", t.role === "owner" ? "ml-auto bg-brand/10" : "bg-surface-2")}>{t.text}</p>)}
                            </div>
                          </details>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button name="include" value="0" variant="secondary">Tirar da persona</Button>
                  <Button name="include" value="1" variant="secondary">Devolver à persona</Button>
                  <span className="ml-auto flex items-center gap-2 text-xs text-muted">
                    {page > 1 && <Link className="text-brand" href={url({ p: page - 1 })}>← anteriores</Link>}
                    {totalDialogues > 0 && <span>{(page - 1) * PAGE + 1}–{Math.min(page * PAGE, totalDialogues)} de {totalDialogues}</span>}
                    {page * PAGE < totalDialogues && <Link className="text-brand" href={url({ p: page + 1 })}>próximos →</Link>}
                  </span>
                </div>
              </form>
            )}
          </Card>
        </>
      )}

      <Card title="Versões da persona" className="mb-4" action={canWrite ? <form action={newVersionAction}><input type="hidden" name="persona_id" value={id} /><Button variant="secondary" className="px-2 py-1 text-xs">Nova versão em branco</Button></form> : undefined}>
        {vs.length === 0 ? <Empty title="Nenhuma versão ainda">Gere o perfil de estilo a partir do histórico ou crie uma versão em branco e escreva as instruções.</Empty> : (
          <>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {vs.map((v) => (
                <Link key={v.id} href={`/ia/personas/${id}?v=${v.id}`} className={cn("rounded-full border px-3 py-1 text-sm", selected?.id === v.id ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2")}>
                  v{v.version} {v.id === persona.active_version_id ? "· ativa" : v.approved_at ? "· aprovada" : "· rascunho"}
                </Link>
              ))}
            </div>
            {selected && (
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  {canWrite ? <VersionEditor key={selected.id} personaId={id} versionId={selected.id} prompt={selected.system_prompt ?? ""} rules={rules} approved={!!selected.approved_at} /> : <p className="whitespace-pre-line text-sm">{selected.system_prompt}</p>}
                </div>
                <div className="space-y-2 text-sm">
                  <p className="text-xs font-medium text-muted">Perfil de estilo (gerado a partir das conversas)</p>
                  {(profile.generated?.warnings ?? []).map((w) => <p key={w} className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">{w}</p>)}
                  {narrative ? (
                    <>
                      {narrative.resumo && <p>{narrative.resumo}</p>}
                      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
                        {profile.stats?.chars_per_bubble?.mean != null && <><dt className="text-muted">Tamanho médio</dt><dd>{Math.round(profile.stats.chars_per_bubble.mean)} caracteres por mensagem, {profile.stats.bubbles_per_turn?.mean?.toFixed(1)} por resposta</dd></>}
                        {profile.stats?.emoji?.pct_bubbles_with_emoji != null && <><dt className="text-muted">Emojis</dt><dd>em {Math.round(profile.stats.emoji.pct_bubbles_with_emoji)}% das mensagens</dd></>}
                        {(narrative.aberturas ?? []).length > 0 && <><dt className="text-muted">Aberturas</dt><dd>{narrative.aberturas!.join(" · ")}</dd></>}
                        {(narrative.fechamentos ?? []).length > 0 && <><dt className="text-muted">Fechamentos</dt><dd>{narrative.fechamentos!.join(" · ")}</dd></>}
                        {(narrative.vocativos ?? []).length > 0 && <><dt className="text-muted">Vocativos</dt><dd>{narrative.vocativos!.join(", ")}</dd></>}
                        {(narrative.lexico_marca ?? []).length > 0 && <><dt className="text-muted">Vocabulário</dt><dd>{narrative.lexico_marca!.join(", ")}</dd></>}
                        {(narrative.tabus ?? []).length > 0 && <><dt className="text-muted">Evita</dt><dd>{narrative.tabus!.join(", ")}</dd></>}
                        {Object.entries(narrative.vendas ?? {}).map(([k, v]) => <Fragment key={k}><dt className="text-muted">{VENDAS[k] ?? k}</dt><dd>{v}</dd></Fragment>)}
                        {(narrative.tom_por_etapa ?? []).map((t) => <Fragment key={t.etapa}><dt className="text-muted">Tom: {t.etapa}</dt><dd>{t.tom}</dd></Fragment>)}
                      </dl>
                    </>
                  ) : <p className="text-xs text-muted">Versão escrita à mão: sem análise automática.</p>}
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
