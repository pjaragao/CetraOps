import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { findExactCombination, roundCents } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { todayIsoSP } from "@/lib/context";
import { str, type SP } from "@/lib/context";
import { Empty, LinkButton, PageHeader } from "@/components/ui";
import { SettleEditor, type EditorItem } from "./settle-editor";

export const metadata = { title: "Baixar títulos" };

/**
 * Baixa (pagamento/recebimento) com rateio: parte de parcelas marcadas (?ids=) ou de uma linha do extrato (?line=).
 * Um movimento no banco pode quitar várias parcelas e carregar juros, multa, desconto, taxas e retenções.
 */
export default async function BaixarPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("fin.write");
  const sp = await searchParams;
  const supabase = await createClient();
  const lineId = str(sp.line);
  let direction: "PAYABLE" | "RECEIVABLE" = str(sp.dir) === "RECEIVABLE" ? "RECEIVABLE" : "PAYABLE";
  const ids = (str(sp.ids) ?? "").split(",").filter((x) => /^[0-9a-f-]{36}$/.test(x));

  let statement: { id: string; posted_on: string; amount: number; description: string; bank_account_id: string; counterpart: string | null; doc: string | null } | undefined;
  let entityId: string | undefined;
  if (lineId) {
    const { data: l } = await supabase.schema("fin").from("statement_lines")
      .select("id, posted_on, amount, description, bank_account_id, legal_entity_id, counterpart_name, counterpart_doc, status, matched_amount").eq("id", lineId).maybeSingle();
    if (!l || l.status === "MATCHED" || l.status === "IGNORED") redirect("/financeiro/conciliacao?erro=Linha%20j%C3%A1%20tratada%20ou%20inexistente");
    direction = Number(l.amount) > 0 ? "RECEIVABLE" : "PAYABLE";
    entityId = l.legal_entity_id;
    statement = {
      id: l.id, posted_on: l.posted_on, amount: Number(l.amount) > 0 ? Number(l.amount) - Number(l.matched_amount) : -(Math.abs(Number(l.amount)) - Number(l.matched_amount)),
      description: l.description ?? "", bank_account_id: l.bank_account_id, counterpart: l.counterpart_name, doc: l.counterpart_doc,
    };
  }

  let q = supabase.schema("fin").from("v_open_installments")
    .select("installment_id, title_number, description, party_name, party_id, n, due_date, balance, fee_expected, fee_anticipation_expected, days_overdue, legal_entity_id, approval_status")
    .eq("direction", direction).order("due_date").limit(400);
  if (direction === "PAYABLE") q = q.eq("approval_status", "APPROVED");
  if (entityId) q = q.eq("legal_entity_id", entityId);
  const [{ data: cand }, sel] = await Promise.all([
    q,
    ids.length
      ? supabase.schema("fin").from("v_open_installments")
          .select("installment_id, title_number, description, party_name, party_id, n, due_date, balance, fee_expected, fee_anticipation_expected, days_overdue, legal_entity_id, approval_status")
          .in("installment_id", ids).eq("direction", direction)
      : Promise.resolve({ data: [] as never[] }),
  ]);

  const map = new Map<string, EditorItem>();
  for (const r of [...(cand ?? []), ...(sel.data ?? [])]) {
    if (!r.installment_id || !r.due_date || !r.legal_entity_id) continue;
    map.set(r.installment_id, {
      id: r.installment_id, title_number: r.title_number ?? "", description: r.description ?? "", party_name: r.party_name, party_id: r.party_id,
      n: r.n ?? 1, due_date: r.due_date, balance: Number(r.balance), fee_expected: Number(r.fee_expected), fee_anticipation_expected: Number(r.fee_anticipation_expected),
      days_overdue: r.days_overdue ?? 0, legal_entity_id: r.legal_entity_id,
    });
  }
  const items = [...map.values()].sort((a, b) => a.due_date.localeCompare(b.due_date));

  // Sugestão automática para linha do extrato: primeiro entre parcelas do favorecido (CNPJ), depois entre todas
  let initialSelected = ids;
  if (statement && ids.length === 0) {
    const target = Math.abs(statement.amount);
    const net = (i: EditorItem) => (direction === "RECEIVABLE" ? roundCents(i.balance - i.fee_expected) : i.balance);
    let partyIds: string[] = [];
    if (statement.doc) {
      const { data: ps } = await supabase.schema("crm").from("parties").select("id").eq("cnpj", statement.doc.replace(/\D/g, ""));
      partyIds = (ps ?? []).map((p) => p.id);
    }
    const mine = items.filter((i) => i.party_id && partyIds.includes(i.party_id));
    const pick = (list: EditorItem[]) => findExactCombination(target, list.map((i) => ({ id: i.id, due_date: i.due_date, amount: net(i) })));
    initialSelected = (mine.length ? pick(mine) : null) ?? pick(items) ?? [];
  }

  const [{ data: banks }, { data: ccs }, { data: accounts }, { data: roles }, { data: credits }] = await Promise.all([
    supabase.schema("fin").from("bank_accounts").select("id, name, legal_entity_id").eq("active", true).order("name"),
    supabase.schema("core").from("cost_centers").select("id, code, name").is("archived_at", null).order("code"),
    supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC").is("archived_at", null).order("code"),
    supabase.schema("fin").from("account_roles").select("chart_account_id").eq("role", "ANTICIPATION_EXPENSE"),
    supabase.schema("fin").from("party_credits").select("id, party_id, amount, used, memo").eq("status", "OPEN").eq("direction", direction),
  ]);
  const creditParties = [...new Set((credits ?? []).map((c) => c.party_id).filter(Boolean))] as string[];
  const { data: cps } = creditParties.length
    ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", creditParties)
    : { data: [] as { id: string; display_name: string }[] };
  const pname = new Map((cps ?? []).map((p) => [p.id, p.display_name]));

  const title = direction === "PAYABLE" ? "Registrar pagamento" : "Registrar recebimento";
  return (
    <>
      <PageHeader title={title}
        description={statement ? "Baixa a partir da linha do extrato: o total dos itens precisa fechar com o valor do banco."
          : "Um movimento pode quitar várias parcelas, com juros, multa, desconto, taxas e retenções — cada componente vai para sua conta e centro de custo."}
        actions={<LinkButton href={direction === "PAYABLE" ? "/financeiro/pagar" : "/financeiro/receber"}>Voltar</LinkButton>} />
      {items.length === 0 && !statement ? <Empty title="Nenhuma parcela disponível" /> : (
        <SettleEditor
          key={`${lineId ?? ""}-${ids.join(",")}`}
          direction={direction} items={items} initialSelected={initialSelected}
          banks={(banks ?? []).map((b) => ({ id: b.id, label: b.name, legal_entity_id: b.legal_entity_id }))}
          costCenters={(ccs ?? []).map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))}
          accounts={(accounts ?? []).map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))}
          anticipationAccountId={roles?.[0]?.chart_account_id}
          credits={(credits ?? []).map((c) => ({ id: c.id, party_id: c.party_id, label: `${c.party_id ? pname.get(c.party_id) ?? "Terceiro" : "Terceiro"}${c.memo ? ` — ${c.memo}` : ""}`, remaining: roundCents(Number(c.amount) - Number(c.used)) }))}
          statement={statement} today={todayIsoSP()} idempotencyKey={randomUUID()}
          defaultBankId={banks?.find((b) => !entityId || b.legal_entity_id === entityId)?.id}
        />
      )}
    </>
  );
}
