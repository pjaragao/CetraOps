import Link from "next/link";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Card, PageHeader, Table } from "@/components/ui";
import { BankAccountForm, KIND_LABEL } from "./bank-account-form";

export const metadata = { title: "Contas bancárias" };

export default async function ContasBancariasPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("core.admin");
  const sp = await searchParams;
  const supabase = await createClient();
  const [{ data: banks }, { data: entities }, { data: accounts }, { data: stores }] = await Promise.all([
    supabase.schema("fin").from("v_bank_balances").select("bank_account_id, name, kind, bank_code, balance, legal_entity_id").order("name"),
    supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia").order("razao_social"),
    supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC").eq("group", "ASSET").like("code", "1.1.1.%").order("code"),
    supabase.schema("core").from("stores").select("id, name").order("name"),
  ]);
  const ent = new Map((entities ?? []).map((e) => [e.id, e.nome_fantasia ?? e.razao_social]));

  return (
    <>
      <PageHeader title="Contas bancárias" description="Inter, BTG, Mercado Pago, caixa da loja e saldo nas adquirentes. Cada conta aponta para uma conta do plano (ativo disponível) — é por ela que a baixa contabiliza." />
      {str(sp.erro) && <p className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{str(sp.erro)}</p>}
      {str(sp.ok) && <p className="mb-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">{str(sp.ok)}</p>}
      <Table head={["Conta", "Tipo", "Banco", "Empresa", "Saldo"]}>
        {(banks ?? []).map((b) => (
          <tr key={b.bank_account_id ?? b.name}>
            <td className="px-3 py-2 font-medium">{b.bank_account_id ? <Link href={`/configuracoes/contas-bancarias/${b.bank_account_id}`} className="text-brand hover:underline">{b.name}</Link> : b.name}</td><td className="px-3 py-2"><Badge>{KIND_LABEL[b.kind ?? ""] ?? b.kind}</Badge></td>
            <td className="px-3 py-2">{b.bank_code ?? "—"}</td><td className="px-3 py-2">{ent.get(b.legal_entity_id ?? "")}</td><td className="px-3 py-2 font-medium">{formatBRL(b.balance)}</td>
          </tr>
        ))}
      </Table>
      <Card className="mt-4" title="Nova conta">
        <BankAccountForm entities={(entities ?? []).map((e) => ({ id: e.id, label: e.nome_fantasia ?? e.razao_social }))}
          accounts={(accounts ?? []).map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))} stores={(stores ?? []).map((x) => ({ id: x.id, label: x.name }))} />
      </Card>
    </>
  );
}
