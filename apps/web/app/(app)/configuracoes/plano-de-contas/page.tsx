import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, LinkButton, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { archiveChartAccountAction, saveChartAccountAction } from "./actions";

export const metadata = { title: "Plano de contas" };

const GROUP_LABEL: Record<string, string> = {
  ASSET: "Ativo", LIABILITY: "Passivo", EQUITY: "Patrimônio líquido", REVENUE: "Receita", DEDUCTION: "Deduções da receita",
  COGS: "Custo da mercadoria", EXPENSE: "Despesa", FINANCIAL: "Financeiro",
};

export default async function PlanoDeContasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fin.read");
  const sp = await searchParams;
  const canWrite = can(session, "fin.write");
  const showArchived = str(sp.arquivadas) === "1";
  const supabase = await createClient();
  let q = supabase.schema("fin").from("chart_accounts")
    .select("id, code, name, kind, nature, group, parent_id, dre_line_id, accountant_code, archived_at, dre_lines(name)").order("code");
  if (!showArchived) q = q.is("archived_at", null);
  const [{ data: accounts }, { data: dreLines }] = await Promise.all([
    q, supabase.schema("fin").from("dre_lines").select("id, name, is_subtotal").eq("is_subtotal", false).order("position"),
  ]);
  const editing = (accounts ?? []).find((a) => a.id === str(sp.editar));
  const showForm = canWrite && (Boolean(editing) || str(sp.nova) === "1");
  const synthetic = (accounts ?? []).filter((a) => a.kind === "SYNTHETIC" && !a.archived_at && a.id !== editing?.id);

  return (
    <>
      <PageHeader title="Plano de contas" description="Reclassificado: a licença de espaço do parceiro anfitrião é patrocínio (não aluguel); MDR (despesa de venda) separado da antecipação (financeira). Coluna do contador para o de-para."
        actions={canWrite && !showForm ? <LinkButton href="/configuracoes/plano-de-contas?nova=1#form" variant="primary">+ Nova conta</LinkButton> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      {showForm && (
        <Card className="mb-4" title={editing ? `Editar ${editing.code} · ${editing.name}` : "Nova conta"}>
          <form id="form" action={saveChartAccountAction} className="grid gap-3 sm:grid-cols-4">
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <Field label="Conta-mãe" hint="Sintética (agrupadora). O código da nova conta começa com o dela" className="sm:col-span-2">
              <select name="parent_id" defaultValue={editing?.parent_id ?? ""} className={inputClass}>
                <option value="">— (conta de primeiro nível)</option>
                {synthetic.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </select>
            </Field>
            <Field label="Código" hint="Ex.: 1.1.1.06"><input name="code" required defaultValue={editing?.code ?? ""} className={`${inputClass} font-mono`} pattern="[0-9]+(\.[0-9]+)*" /></Field>
            <Field label="Tipo"><select name="kind" defaultValue={editing?.kind ?? "ANALYTIC"} className={inputClass}><option value="ANALYTIC">Analítica (recebe lançamentos)</option><option value="SYNTHETIC">Sintética (agrupa contas)</option></select></Field>
            <Field label="Nome" className="sm:col-span-2"><input name="name" required minLength={2} maxLength={120} defaultValue={editing?.name ?? ""} className={inputClass} placeholder="Stone — conta corrente" /></Field>
            <Field label="Grupo" hint="Vazio = o da conta-mãe"><select name="group" defaultValue={editing?.group ?? ""} className={inputClass}><option value="">(da conta-mãe)</option>{Object.entries(GROUP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Natureza" hint="Vazio = a da conta-mãe"><select name="nature" defaultValue={editing?.nature ?? ""} className={inputClass}><option value="">(da conta-mãe)</option><option value="DEBIT">Devedora</option><option value="CREDIT">Credora</option></select></Field>
            <Field label="Linha do DRE" className="sm:col-span-2"><select name="dre_line_id" defaultValue={editing?.dre_line_id ?? ""} className={inputClass}><option value="">—</option>{(dreLines ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
            <Field label="Código do contador" hint="De-para com o plano do escritório"><input name="accountant_code" defaultValue={editing?.accountant_code ?? ""} maxLength={30} className={`${inputClass} font-mono`} /></Field>
            <div className="flex items-end gap-3"><Button>{editing ? "Salvar conta" : "Criar conta"}</Button><Link href="/configuracoes/plano-de-contas" className="pb-2 text-sm text-muted">Cancelar</Link></div>
          </form>
          <p className="mt-2 text-xs text-muted">Conta que já tem lançamentos, conta bancária ou papel contábil não muda de código, tipo, grupo nem conta-mãe: só o nome, a linha do DRE e o código do contador. Para a conta corrente de um banco, crie aqui uma analítica em 1.1.1 e depois a conta em Configurações › Contas bancárias.</p>
        </Card>
      )}

      <div className="mb-2 flex justify-end">
        <Link href={showArchived ? "/configuracoes/plano-de-contas" : "/configuracoes/plano-de-contas?arquivadas=1"} className="text-sm text-brand">{showArchived ? "Esconder arquivadas" : "Mostrar arquivadas"}</Link>
      </div>
      <Table head={["Código", "Conta", "Tipo", "Grupo", "Linha do DRE", "Cód. contador", ""]}>
        {(accounts ?? []).map((a) => {
          const depth = a.code.split(".").length - 1;
          return (
            <tr key={a.id} className={`${a.kind === "SYNTHETIC" ? "bg-surface-2/60 font-medium" : ""} ${a.archived_at ? "opacity-50" : ""}`}>
              <td className="px-3 py-1.5 font-mono text-xs">{a.code}</td>
              <td className="px-3 py-1.5" style={{ paddingLeft: `${0.75 + depth * 1}rem` }}>{a.name}{a.archived_at && <span className="ml-2"><Badge>arquivada</Badge></span>}</td>
              <td className="px-3 py-1.5 text-xs">{a.kind === "SYNTHETIC" ? "sintética" : "analítica"}</td>
              <td className="px-3 py-1.5"><Badge>{GROUP_LABEL[a.group] ?? a.group}</Badge></td>
              <td className="px-3 py-1.5 text-xs">{a.dre_lines?.name ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono text-xs text-muted">{a.accountant_code ?? ""}</td>
              <td className="px-3 py-1.5 text-right whitespace-nowrap">
                {canWrite && (
                  <span className="flex items-center justify-end gap-2 text-xs">
                    {!a.archived_at && <Link href={`/configuracoes/plano-de-contas?editar=${a.id}#form`} className="text-brand">Editar</Link>}
                    <form action={archiveChartAccountAction}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="archive" value={a.archived_at ? "0" : "1"} /><button className="text-muted hover:text-text">{a.archived_at ? "Reativar" : "Arquivar"}</button></form>
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </Table>
    </>
  );
}
