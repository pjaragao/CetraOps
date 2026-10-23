import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { LinkButton, PageHeader } from "@/components/ui";
import { Flash } from "@/components/form";
import { loadCatalog } from "@/lib/reports";
import { REPORTS } from "./registry";
import { ReportList, type ReportEntry } from "./report-list";

export const metadata = { title: "Relatórios" };

export default async function RelatoriosPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("sales.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const [catalog, { data: saved }] = await Promise.all([
    loadCatalog(supabase),
    supabase.schema("core").from("saved_reports").select("id, title, description, dataset, created_by, updated_at").order("title"),
  ]);
  const authorIds = [...new Set((saved ?? []).map((r) => r.created_by).filter((x): x is string => Boolean(x)))];
  const { data: authors } = authorIds.length ? await supabase.schema("core").from("members").select("id, display_name").in("id", authorIds) : { data: [] };
  const authorName = new Map((authors ?? []).map((a) => [a.id, a.display_name]));
  const dsArea = new Map(catalog.map((d) => [d.key, d]));

  const entries: ReportEntry[] = [
    ...Object.entries(REPORTS).filter(([, r]) => can(session, r.perm))
      .map(([key, r]): ReportEntry => ({ href: `/relatorios/${key}`, title: r.title, description: r.description, area: r.area, kind: "pronto" })),
    ...(saved ?? []).map((r): ReportEntry => {
      const ds = dsArea.get(r.dataset);
      const by = r.created_by ? authorName.get(r.created_by) : null;
      return {
        href: `/relatorios/${r.id}`, title: r.title, description: r.description ?? `Montado sobre ${ds?.label ?? r.dataset}.`, area: ds?.area ?? "Outros", kind: "equipe",
        meta: [ds?.label, by && `criado por ${by}`, `atualizado em ${new Date(r.updated_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}`].filter(Boolean).join(" · "),
      };
    }),
  ];

  return (
    <>
      <PageHeader
        title="Relatórios"
        description="Consultas para conferir a operação e tomar decisões. Todas aceitam período e baixam em CSV (abre no Excel). Não achou o que precisa? Crie um relatório novo: descreva para a IA ou monte à mão."
        actions={catalog.length > 0 && <LinkButton href="/relatorios/novo" variant="primary"><Plus size={16} aria-hidden /> Novo relatório</LinkButton>}
      />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <ReportList entries={entries} />
    </>
  );
}
