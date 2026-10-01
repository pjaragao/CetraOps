import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { Badge, Button, Card, inputClass, PageHeader } from "@/components/ui";
import { Flash } from "@/components/form";
import { str, type SP } from "@/lib/context";

export const metadata = { title: "Modelos de IA" };

const TASK_LABEL: Record<string, string> = {
  conversation: "Atendimento ao cliente (via Hermes)", classify: "Classificação (intenção, sentimento, tags)",
  extract: "Extração (enriquecimento, NF-e → SKU, contas)", summarize: "Resumos de conversa e memória",
  persona_style: "Extração do estilo dos sócios", judge: "Juiz das avaliações", ops_copilot: "Copiloto do ERP e briefing",
  embeddings: "Embeddings (busca semântica)",
};

async function saveRoute(formData: FormData) {
  "use server";
  const session = await requirePerm("ai.write");
  const supabase = await createClient();
  const fallback = String(formData.get("fallback_models") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const { error } = await supabase.schema("ai").from("model_routes").update({
    primary_model: String(formData.get("primary_model")).trim(),
    fallback_models: fallback,
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

  return (
    <>
      <PageHeader title="Modelos & custos" description="Cada tarefa usa um modelo do OpenRouter escolhido aqui, sem deploy. Rotas com dado de cliente exigem ZDR (sem retenção)." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="grid gap-3 lg:grid-cols-2">
        {(routes ?? []).map((r) => (
          <Card key={r.id} title={TASK_LABEL[r.task] ?? r.task} action={<Badge tone={r.active ? "success" : "neutral"}>{r.active ? "ativa" : "inativa"}</Badge>}>
            <form action={saveRoute} className="space-y-2">
              <input type="hidden" name="id" value={r.id} />
              <label className="block text-xs text-muted">Modelo principal (slug OpenRouter)
                <input name="primary_model" defaultValue={r.primary_model} disabled={!editable} className={inputClass} /></label>
              <label className="block text-xs text-muted">Reservas (separadas por vírgula)
                <input name="fallback_models" defaultValue={r.fallback_models.join(", ")} disabled={!editable} className={inputClass} /></label>
              <div className="flex items-end gap-2">
                <label className="block flex-1 text-xs text-muted">Orçamento diário (US$)
                  <input name="daily_budget_usd" defaultValue={r.daily_budget_usd ?? ""} disabled={!editable} className={inputClass} /></label>
                <label className="flex items-center gap-1 pb-2 text-xs"><input type="checkbox" name="active" defaultChecked={r.active} disabled={!editable} /> ativa</label>
              </div>
              <p className="text-xs text-muted">Privacidade: {JSON.stringify(r.provider_prefs)}{r.requires_tools ? " · exige tools" : ""}{r.requires_json_schema ? " · exige JSON schema" : ""}</p>
              {editable && <Button variant="secondary">Salvar</Button>}
            </form>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted">Os modelos iniciais são sugestões. Troque a rota de atendimento só depois de o novo modelo passar nas avaliações (ranking de qualidade × custo × latência, em breve nesta tela).</p>
      <h2 className="mt-6 mb-2 text-sm font-semibold text-muted">Histórico de trocas</h2>
      <ul className="space-y-1 text-sm">
        {(changes ?? []).map((c) => (
          <li key={c.id}>{new Date(c.changed_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} · {c.task} → {(c.after as { primary_model?: string }).primary_model}</li>
        ))}
      </ul>
    </>
  );
}
