import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, PageHeader, Table } from "@/components/ui";
import { createBankAccountAction } from "../../financeiro/actions";

export const metadata = { title: "Contas bancárias" };

const KIND_LABEL: Record<string, string> = { CHECKING: "Conta corrente", CASH_DRAWER: "Caixa (gaveta)", ACQUIRER_BALANCE: "Saldo na adquirente", INVESTMENT: "Aplicação" };

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
            <td className="px-3 py-2 font-medium">{b.name}</td><td className="px-3 py-2"><Badge>{KIND_LABEL[b.kind ?? ""] ?? b.kind}</Badge></td>
            <td className="px-3 py-2">{b.bank_code ?? "—"}</td><td className="px-3 py-2">{ent.get(b.legal_entity_id ?? "")}</td><td className="px-3 py-2 font-medium">{formatBRL(b.balance)}</td>
          </tr>
        ))}
      </Table>
      <Card className="mt-4" title="Nova conta">
        <form action={createBankAccountAction} className="grid gap-2 sm:grid-cols-6">
          <label className="text-xs text-muted sm:col-span-2">Nome<input name="name" required className={inputClass} placeholder="Ex.: BTG Pactual Empresas" maxLength={80} /></label>
          <label className="text-xs text-muted">Tipo<select name="kind" className={inputClass} defaultValue="CHECKING">{Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="text-xs text-muted sm:col-span-2">Empresa (CNPJ)<select name="entity" required className={inputClass}>{(entities ?? []).map((e) => <option key={e.id} value={e.id}>{e.nome_fantasia ?? e.razao_social}</option>)}</select></label>
          <label className="text-xs text-muted">Conta do plano<select name="account" required className={inputClass}><option value="">…</option>{(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></label>
          <label className="text-xs text-muted">Banco (código)<input name="bank_code" className={inputClass} placeholder="077, 208, 323" maxLength={4} /></label>
          <label className="text-xs text-muted">Agência<input name="agency" className={inputClass} maxLength={10} /></label>
          <label className="text-xs text-muted">Conta<input name="number" className={inputClass} maxLength={20} /></label>
          <label className="text-xs text-muted">Loja (caixa)<select name="store" className={inputClass}><option value="">—</option>{(stores ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="text-xs text-muted">Saldo de abertura (R$)<input name="opening" className={inputClass} inputMode="decimal" placeholder="0,00" /></label>
          <label className="text-xs text-muted">Data do saldo<input name="opening_date" type="date" defaultValue={todayIsoSP()} className={inputClass} /></label>
          <div className="self-end"><Button>Criar conta</Button></div>
        </form>
        <p className="mt-2 text-xs text-muted">O saldo de abertura entra na conta e deve ser lançado no razão pelo contador (lançamento manual) contra o capital ou o saldo anterior.</p>
      </Card>
    </>
  );
}
