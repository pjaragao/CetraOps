import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { todayIsoSP } from "@/lib/context";
import { PageHeader } from "@/components/ui";
import { loadCatalog } from "@/lib/reports";
import { ReportBuilder } from "../report-builder";

export const metadata = { title: "Novo relatório" };

const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export default async function NovoRelatorioPage() {
  const session = await requirePerm("sales.read");
  const catalog = await loadCatalog(await createClient());
  if (!catalog.length) redirect("/relatorios?erro=" + encodeURIComponent("Seu perfil não tem acesso a nenhuma fonte de dados de relatório."));
  const to = todayIsoSP();
  return (
    <>
      <PageHeader title="Novo relatório" description="Descreva para a IA ou escolha a fonte de dados, os campos e os filtros. A prévia mostra o resultado enquanto você monta." />
      <ReportBuilder catalog={catalog} canUseAi={can(session, "ai.assistant")} defaultFrom={addDays(to, -29)} defaultTo={to} />
    </>
  );
}
