import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { Button, inputClass, PageHeader } from "@/components/ui";
import { Flash } from "@/components/form";
import { str, type SP } from "@/lib/context";
import { HERMES_DEFAULT, HERMES_UNSUPPORTED, hermesModelOptions, isHermesModel } from "@/lib/central/hermes";
import { ModelPicker, type ModelOption } from "@/components/model-picker";

export const metadata = { title: "Modelos de IA" };

/** O que cada rota faz, o que ela exige do modelo e como escolher (texto para quem não é técnico). */
const TASKS: Record<string, { label: string; what: string; pick: string }> = {
  assistant: {
    label: "Central (chatbot do CentralOps)",
    what: "O chat da Central dentro do sistema: responde a equipe, consulta vendas, estoque e finanças pelas ferramentas e prepara ações para a pessoa confirmar.",
    pick: "Modelo bom em português e em usar ferramentas. O Hermes do CentralOps (AGY) não tem custo por token, mas é mais lento (10 a 60 s por passo).",
  },
  vision_extract: {
    label: "Leitura de documentos",
    what: "Lê fotos e PDFs enviados à Central (boleto, nota, comprovante, contrato) e devolve os campos para conferência.",
    pick: "Precisa de um modelo com visão (imagem e PDF) que responda em JSON. O Hermes do CentralOps (AGY) lê imagem e PDF, sem custo por token.",
  },
  conversation: {
    label: "Atendimento ao cliente",
    what: "Responde clientes no WhatsApp e Instagram, consulta estoque, preço e políticas pelas ferramentas e decide se envia, deixa rascunho ou chama uma pessoa. É a rota que fala com a cliente: erro aqui aparece para ela.",
    pick: "Escolha um modelo de ponta, bom em português e que use ferramentas com confiança. Mais caro e mais lento é aceitável aqui. Só troca depois de passar em Avaliações da IA.",
  },
  classify: {
    label: "Classificação",
    what: "Marca cada mensagem com intenção, sentimento e assunto, e separa o que é conversa comercial do que é pessoal no treino das personas. Roda em volume, várias vezes por dia.",
    pick: "Escolha um modelo rápido e barato; respostas curtas em formato fixo. Qualidade média basta.",
  },
  extract: {
    label: "Extração de dados",
    what: "Tira dados estruturados de textos: enriquecimento de cadastro, ligar item de nota fiscal ao produto, sugerir conta e rateio de um boleto.",
    pick: "Escolha um modelo barato que siga bem um formato (JSON). Peça confiança: o que for incerto vai para revisão humana.",
  },
  summarize: {
    label: "Resumos",
    what: "Resume a conversa na linha do tempo da cliente e guarda fatos úteis (tamanho, preferências) para as próximas conversas.",
    pick: "Modelo barato ou médio; o texto é curto e o custo soma pelo volume.",
  },
  persona_style: {
    label: "Estilo dos sócios",
    what: "Lê o histórico de conversas dos sócios (já sem dados pessoais) e descreve o jeito de escrever de cada um; também sugere ajustes a partir das edições da equipe.",
    pick: "Roda poucas vezes e o contexto é longo: vale um modelo de topo em raciocínio, mesmo mais caro.",
  },
  judge: {
    label: "Juiz das avaliações",
    what: "Compara respostas da IA com as dos sócios e dá notas de estilo nas avaliações.",
    pick: "Use um modelo de topo e de família diferente do usado no atendimento, para a nota não ser enviesada.",
  },
  ops_copilot: {
    label: "Copiloto do ERP e textos",
    what: "Briefing diário, respostas do copiloto interno, textos de campanha e abordagens de prospecção. Só lê dados e escreve rascunhos; nunca executa ação financeira.",
    pick: "Modelo médio ou de ponta com bom português; a equipe revisa antes de usar.",
  },
  embeddings: {
    label: "Busca por semelhança",
    what: "Transforma textos em números para achar exemplos parecidos (estilo dos sócios, catálogo). Trocar o modelo exige reindexar tudo.",
    pick: "Modelo multilíngue de dimensão 1024. Troque só se houver motivo forte.",
  },
};

async function saveRoute(formData: FormData) {
  "use server";
  const session = await requirePerm("ai.write");
  const supabase = await createClient();
  const task = String(formData.get("task") || "");
  let primary = String(formData.get("primary_model")).trim();
  let fallback = String(formData.get("fallback_models") || "").split(",").map((s) => s.trim()).filter(Boolean);
  // "Usar Hermes": o Hermes vira o principal e o modelo de antes fica como primeira reserva (se o Hermes cair, a rota continua)
  if (formData.get("use_hermes")) {
    fallback = [primary, ...fallback].filter((m) => m && !isHermesModel(m));
    primary = String(formData.get("use_hermes"));
  }
  if (HERMES_UNSUPPORTED[task] && [primary, ...fallback].some(isHermesModel)) {
    redirect(`/ia/modelos?erro=${encodeURIComponent(`Hermes não serve nesta rota: ${HERMES_UNSUPPORTED[task]}`)}`);
  }
  const { error } = await supabase.schema("ai").from("model_routes").update({
    primary_model: primary,
    fallback_models: [...new Set(fallback)].filter((m) => m !== primary),
    daily_budget_usd: Number(formData.get("daily_budget_usd") || 0) || null,
    active: formData.get("active") === "on",
    updated_by: session.memberId,
  }).eq("id", String(formData.get("id")));
  revalidatePath("/ia/modelos");
  // o banco barra modelo de atendimento que não passou nas avaliações (ver Avaliações da IA)
  redirect(error ? `/ia/modelos?erro=${encodeURIComponent(error.message.replace(/^ERROR:\s*/, ""))}` : "/ia/modelos?ok=Rota+salva.");
}

export default async function ModelosPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = await requirePerm("ai.read");
  const supabase = await createClient();
  const [{ data: routes }, { data: changes }] = await Promise.all([
    supabase.schema("ai").from("model_routes").select("*").order("task"),
    supabase.schema("ai").from("model_route_changes").select("id, task, changed_at, after").order("changed_at", { ascending: false }).limit(10),
  ]);
  const editable = can(session, "ai.write");
  // opções do seletor: cada modelo do AGY em cada nível de pensamento + os modelos do OpenRouter já usados nas rotas
  const hermesOptions: ModelOption[] = await hermesModelOptions();
  const used = [...new Set((routes ?? []).flatMap((r) => [r.primary_model, ...r.fallback_models]))];
  const openrouterOptions: ModelOption[] = used.filter((m) => !isHermesModel(m)).sort().map((m) => ({ id: m, label: m, group: "OpenRouter (já usados nas rotas)" }));
  const unknownHermes: ModelOption[] = used.filter((m) => isHermesModel(m) && !hermesOptions.some((o) => o.id === m)).map((m) => ({ id: m, label: m, hint: "não está mais no catálogo do AGY", group: "Hermes do CentralOps · AGY (sem custo por token)" }));
  const allOptions = [...hermesOptions, ...unknownHermes, ...openrouterOptions];

  return (
    <>
      <PageHeader title="Modelos & custos" description="Cada tarefa usa um modelo do OpenRouter ou o Hermes do CentralOps (hermes/agy), escolhido aqui, sem deploy. Rotas com dado de cliente exigem ZDR (sem retenção)." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 rounded-xl border border-border bg-surface p-3 text-sm">
        <p className="font-medium">Hermes do CentralOps (AGY)</p>
        <p className="mt-0.5 text-xs text-muted">
          Instância exclusiva do Hermes cujo modelo é o AGY (Antigravity), sem custo por token: Gemini, Claude e GPT-OSS, cada um com nível de pensamento baixo, médio ou alto.
          Busque no seletor de qualquer rota (ex.: &quot;sonnet alto&quot;, &quot;flash&quot;, &quot;agy&quot;) para usar como modelo principal ou reserva, ou use o botão <b>Usar Hermes</b> da linha (o modelo atual vira reserva). Lê imagens e PDF; é mais lento que o OpenRouter (10 a 60 s por chamada) e não gera embeddings.
          Na rota de atendimento ao cliente os modelos do AGY estão liberados sem avaliação (os demais modelos continuam precisando passar nas <Link className="underline" href="/ia/avaliacoes">Avaliações da IA</Link>).
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr><th className="px-3 py-2 font-medium">Tarefa</th><th className="px-3 py-2 font-medium">Modelo principal</th><th className="px-3 py-2 font-medium">Reservas</th><th className="px-3 py-2 font-medium">Teto/dia (US$)</th><th className="px-3 py-2 font-medium">Ativa</th><th className="px-3 py-2" /></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {(routes ?? []).map((r) => {
              const t = TASKS[r.task];
              const f = `route-${r.id}`;
              return (
                <tr key={r.id} className="align-top">
                  <td className="max-w-lg px-3 py-2">
                    <p className="font-medium">{t?.label ?? r.task}</p>
                    <p className="mt-0.5 text-xs text-muted">{t?.what ?? "—"}</p>
                    <details className="text-xs text-muted">
                      <summary className="cursor-pointer">Como escolher e requisitos</summary>
                      <p className="mt-1"><b>Como escolher:</b> {t?.pick ?? "—"}</p>
                      <p className="mt-1"><b>Privacidade e requisitos:</b> {r.provider_prefs && (r.provider_prefs as { zdr?: boolean }).zdr ? "sem retenção de dados (ZDR)" : "sem exigência de ZDR"}{r.requires_tools ? " · precisa usar ferramentas" : ""}{r.requires_json_schema ? " · precisa responder em JSON" : ""}</p>
                    </details>
                  </td>
                  <td className="px-3 py-2">
                    <ModelPicker form={f} name="primary_model" defaultValue={r.primary_model} disabled={!editable} options={HERMES_UNSUPPORTED[r.task] ? openrouterOptions : allOptions} className="min-w-60" ariaLabel={`Modelo de ${t?.label ?? r.task}`} />
                    {isHermesModel(r.primary_model) && <p className="mt-1 text-xs text-muted">Hermes do CentralOps · AGY · {r.primary_model}</p>}
                    {HERMES_UNSUPPORTED[r.task] && <p className="mt-1 max-w-52 text-xs text-muted">Sem Hermes: {HERMES_UNSUPPORTED[r.task]}</p>}
                  </td>
                  <td className="px-3 py-2"><ModelPicker multiple form={f} name="fallback_models" defaultValue={r.fallback_models} disabled={!editable} options={HERMES_UNSUPPORTED[r.task] ? openrouterOptions : allOptions} className="min-w-52" ariaLabel="Reservas" /></td>
                  <td className="px-3 py-2"><input form={f} name="daily_budget_usd" defaultValue={r.daily_budget_usd ?? ""} disabled={!editable} className={`${inputClass} w-20`} aria-label="Orçamento diário" /></td>
                  <td className="px-3 py-2"><input form={f} type="checkbox" name="active" defaultChecked={r.active} disabled={!editable} aria-label="Ativa" /></td>
                  <td className="px-3 py-2">
                    <form id={f} action={saveRoute} className="flex flex-col gap-1">
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="task" value={r.task} />
                      {editable && <Button variant="secondary" className="px-2 py-1 text-xs">Salvar</Button>}
                      {editable && !HERMES_UNSUPPORTED[r.task] && !isHermesModel(r.primary_model) && (
                        <Button variant="secondary" name="use_hermes" value={HERMES_DEFAULT} className="px-2 py-1 text-xs" title="Hermes do CentralOps (AGY) como principal; o modelo atual vira reserva">Usar Hermes</Button>
                      )}
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs text-muted">Os modelos iniciais são sugestões. Troque a rota de atendimento só depois de o novo modelo passar nas avaliações (veja o ranking de qualidade × custo × latência em <Link className="underline" href="/ia/avaliacoes">Avaliações da IA</Link>).</p>
      <h2 className="mt-6 mb-2 text-sm font-semibold text-muted">Histórico de trocas</h2>
      <ul className="space-y-1 text-sm">
        {(changes ?? []).map((c) => (
          <li key={c.id}>{new Date(c.changed_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} · {c.task} → {(c.after as { primary_model?: string }).primary_model}</li>
        ))}
      </ul>
    </>
  );
}
