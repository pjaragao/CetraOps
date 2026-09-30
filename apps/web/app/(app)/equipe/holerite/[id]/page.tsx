import { notFound } from "next/navigation";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { LinkButton } from "@/components/ui";
import { fmtDate, fmtMonth } from "@/components/form";
import { PrintButton } from "./print-button";
import { RUN_KIND } from "../../labels";

export const metadata = { title: "Holerite" };

/** Holerite / recibo de pagamento imprimível. Documento de conferência: o oficial é emitido pelo contador. */
export default async function HoleritePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePerm("hr.payroll.read");
  const { id } = await params;
  const supabase = await createClient();
  const { data: slip } = await supabase.schema("hr").from("payslips").select("*").eq("id", id).maybeSingle();
  if (!slip) notFound();
  const [{ data: run }, { data: emp }, { data: lines }] = await Promise.all([
    supabase.schema("hr").from("payroll_runs").select("*").eq("id", slip.run_id).maybeSingle(),
    supabase.schema("hr").from("employees").select("*").eq("id", slip.employee_id).maybeSingle(),
    supabase.schema("hr").from("payslip_lines").select("*").eq("payslip_id", id).neq("kind", "EMPLOYER").order("kind").order("created_at"),
  ]);
  if (!run || !emp) notFound();
  const [{ data: party }, { data: entity }, { data: priv }] = await Promise.all([
    supabase.schema("crm").from("parties").select("display_name").eq("id", emp.party_id).maybeSingle(),
    supabase.schema("core").from("legal_entities").select("razao_social, cnpj").eq("id", run.legal_entity_id).maybeSingle(),
    can(session, "hr.sensitive") ? supabase.schema("hr").from("employee_private").select("cpf").eq("employee_id", emp.id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const cnpj = entity?.cnpj?.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  const earnings = (lines ?? []).filter((l) => l.kind === "EARNING");
  const deductions = (lines ?? []).filter((l) => l.kind === "DEDUCTION");

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex justify-between" data-print-hide><LinkButton href={`/equipe/folha/${run.id}`}>Voltar</LinkButton><PrintButton /></div>
      <article className="rounded-xl border border-border bg-surface p-6 text-sm print:border-0 print:p-0">
        <header className="flex flex-wrap justify-between gap-2 border-b border-border pb-3">
          <div><p className="text-base font-semibold">{entity?.razao_social}</p><p className="text-xs text-muted">CNPJ {cnpj}</p></div>
          <div className="text-right"><p className="font-semibold">Recibo de pagamento — {RUN_KIND[run.kind]}</p><p className="text-xs text-muted">Competência {fmtMonth(run.competence)} · pagamento {fmtDate(run.pay_date)}</p></div>
        </header>
        <section className="grid grid-cols-2 gap-x-6 gap-y-1 border-b border-border py-3 text-xs sm:grid-cols-4">
          <p><span className="text-muted">Colaborador</span><br /><b>{party?.display_name}</b></p>
          <p><span className="text-muted">Matrícula</span><br />{emp.registration}</p>
          <p><span className="text-muted">Cargo</span><br />{emp.job_title}{emp.cbo ? ` (CBO ${emp.cbo})` : ""}</p>
          <p><span className="text-muted">Admissão</span><br />{fmtDate(emp.hire_date)}</p>
          {priv?.cpf && <p><span className="text-muted">CPF</span><br />{priv.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")}</p>}
        </section>
        <table className="mt-3 w-full">
          <thead className="text-left text-xs text-muted"><tr><th className="pb-1">Descrição</th><th className="w-16 text-right">Ref.</th><th className="w-28 text-right">Proventos</th><th className="w-28 text-right">Descontos</th></tr></thead>
          <tbody>
            {earnings.map((l) => <tr key={l.id}><td className="py-0.5">{l.description}</td><td className="text-right text-xs">{l.reference != null ? String(Number(l.reference)).replace(".", ",") : ""}</td><td className="text-right">{formatBRL(l.amount)}</td><td /></tr>)}
            {deductions.map((l) => <tr key={l.id}><td className="py-0.5">{l.description}</td><td className="text-right text-xs">{l.reference != null ? String(Number(l.reference)).replace(".", ",") : ""}</td><td /><td className="text-right">{formatBRL(l.amount)}</td></tr>)}
          </tbody>
          <tfoot className="border-t border-border">
            <tr><td className="pt-2 font-medium" colSpan={2}>Totais</td><td className="pt-2 text-right font-medium">{formatBRL(slip.gross)}</td><td className="pt-2 text-right font-medium">{formatBRL(slip.deductions)}</td></tr>
            <tr><td className="pt-1 text-base font-semibold" colSpan={3}>Líquido a receber</td><td className="pt-1 text-right text-base font-semibold">{formatBRL(slip.net)}</td></tr>
          </tfoot>
        </table>
        <footer className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs text-muted sm:grid-cols-4">
          <p>Base INSS<br /><b className="text-text">{formatBRL(slip.inss_base)}</b></p><p>Base FGTS<br /><b className="text-text">{formatBRL(slip.fgts_base)}</b></p>
          <p>FGTS do mês<br /><b className="text-text">{formatBRL(slip.fgts)}</b></p><p>Rend. tributável (IRRF)<br /><b className="text-text">{formatBRL(slip.irrf_base)}</b></p>
        </footer>
        <p className="mt-4 text-[11px] text-muted">Documento gerado pelo sistema para conferência. O recibo oficial e as obrigações acessórias (eSocial/FGTS Digital) são de responsabilidade do contador.</p>
      </article>
    </div>
  );
}
