import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";
import { todayIsoSP } from "@/lib/context";
import { PageHeader } from "@/components/ui";
import { loadCatalog, loadSaved } from "@/lib/reports";
import { ReportBuilder } from "../../report-builder";

export const metadata = { title: "Editar relatório" };

const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export default async function EditarRelatorioPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const supabase = await createClient();
  const saved = await loadSaved(supabase, key);
  if (!saved) notFound();
  const session = await getSession();
  if (saved.created_by !== session.memberId && !can(session, "core.admin")) redirect(`/relatorios/${key}?erro=${encodeURIComponent("Só quem criou o relatório (ou o admin) pode alterá-lo.")}`);
  const to = todayIsoSP();
  return (
    <>
      <PageHeader title={`Editar: ${saved.title}`} />
      <ReportBuilder catalog={await loadCatalog(supabase)} canUseAi={can(session, "ai.assistant")} defaultFrom={addDays(to, -29)} defaultTo={to}
        initial={{ id: saved.id, title: saved.title, description: saved.description, prompt: saved.prompt, spec: saved.spec }} />
    </>
  );
}
