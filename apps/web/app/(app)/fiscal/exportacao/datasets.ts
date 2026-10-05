import type { CsvColumn } from "@centralops/domain";
import type { createClient } from "@/lib/supabase/server";

type Db = Awaited<ReturnType<typeof createClient>>;
export interface Bounds { from: string; to: string; fromDate: string; toDate: string }
type Row = Record<string, unknown>;
const text = (k: string) => (r: Row) => (r[k] as string | null | undefined) ?? "";

/** Conjuntos que o contador recebe todo mês. `description` aparece na tela. */
export const DATASETS: Record<string, { title: string; description: string }> = {
  emitidas: { title: "Notas emitidas", description: "NFC-e e NF-e de saída emitidas no mês, com chave, CFOP, destinatário e valor." },
  recebidas: { title: "Notas recebidas", description: "NF-e de fornecedores recebidas no mês (MDe), com a situação da manifestação." },
  titulos: { title: "Contas a pagar e a receber", description: "Títulos com competência no mês, já com a conta contábil e o código do plano do contador." },
  liquidacoes: { title: "Pagamentos e recebimentos", description: "Baixas realizadas no mês (data, valor, forma de pagamento e referência)." },
  "plano-de-contas": { title: "Plano de contas (de-para)", description: "Contas da empresa com o código correspondente no sistema do contador." },
  resumo: { title: "Resumo do mês", description: "Faturamento por CFOP, cancelamentos e total de notas recebidas, para conferir com a apuração." },
};

export async function loadDataset(supabase: Db, key: string, b: Bounds): Promise<{ rows: Row[]; columns: CsvColumn<Row>[] }> {
  if (key === "emitidas") {
    const { data } = await supabase.schema("fiscal").from("documents").select("model, series, number, access_key, status, operation_nature, cfop_main, issue_at, counterpart_name, counterpart_cnpj, totals")
      .eq("direction", "OUT").gte("issue_at", b.from).lt("issue_at", b.to).order("issue_at").limit(5000);
    return {
      rows: (data ?? []) as Row[],
      columns: [
        { header: "Modelo", get: text("model") }, { header: "Série", get: text("series") }, { header: "Número", get: text("number") }, { header: "Chave de acesso", get: text("access_key") },
        { header: "Situação", get: text("status") }, { header: "Natureza", get: text("operation_nature") }, { header: "CFOP", get: text("cfop_main") },
        { header: "Emissão", get: text("issue_at"), kind: "date" }, { header: "Destinatário", get: text("counterpart_name") }, { header: "CNPJ/CPF", get: text("counterpart_cnpj") },
        { header: "Valor da nota", get: (r) => (r.totals as { vNF?: number } | null)?.vNF ?? null, kind: "money" },
      ],
    };
  }
  if (key === "recebidas") {
    const { data } = await supabase.schema("fiscal").from("inbound_dfe").select("access_key, issuer_cnpj, issuer_name, amount, issue_at, manifest_status, xml_downloaded")
      .gte("issue_at", b.from).lt("issue_at", b.to).order("issue_at").limit(5000);
    return {
      rows: (data ?? []) as Row[],
      columns: [
        { header: "Chave de acesso", get: text("access_key") }, { header: "CNPJ do emitente", get: text("issuer_cnpj") }, { header: "Emitente", get: text("issuer_name") },
        { header: "Emissão", get: text("issue_at"), kind: "date" }, { header: "Valor", get: (r) => r.amount as number, kind: "money" },
        { header: "Manifestação", get: text("manifest_status") }, { header: "XML baixado", get: (r) => r.xml_downloaded as boolean },
      ],
    };
  }
  if (key === "titulos") {
    const [{ data }, { data: accounts }] = await Promise.all([
      supabase.schema("fin").from("titles").select("direction, number, document_kind, document_number, issue_date, competence_date, description, total_amount, status, chart_account_id")
        .gte("competence_date", b.fromDate).lt("competence_date", b.toDate).order("competence_date").limit(5000),
      supabase.schema("fin").from("chart_accounts").select("id, code, name, accountant_code"),
    ]);
    const acc = new Map((accounts ?? []).map((a) => [a.id, a]));
    return {
      rows: (data ?? []) as Row[],
      columns: [
        { header: "Tipo", get: (r) => (r.direction === "PAYABLE" ? "a pagar" : "a receber") }, { header: "Número", get: text("number") }, { header: "Documento", get: (r) => [r.document_kind, r.document_number].filter(Boolean).join(" ") },
        { header: "Emissão", get: text("issue_date"), kind: "date" }, { header: "Competência", get: text("competence_date"), kind: "date" }, { header: "Descrição", get: text("description") },
        { header: "Valor", get: (r) => r.total_amount as number, kind: "money" }, { header: "Situação", get: text("status") },
        { header: "Conta", get: (r) => { const a = acc.get(r.chart_account_id as string); return a ? `${a.code} ${a.name}` : ""; } },
        { header: "Código do contador", get: (r) => acc.get(r.chart_account_id as string)?.accountant_code ?? "" },
      ],
    };
  }
  if (key === "liquidacoes") {
    const { data } = await supabase.schema("fin").from("settlements").select("number, direction, settled_on, amount, method, reference, description, status")
      .gte("settled_on", b.fromDate).lt("settled_on", b.toDate).order("settled_on").limit(5000);
    return {
      rows: (data ?? []) as Row[],
      columns: [
        { header: "Número", get: text("number") }, { header: "Tipo", get: (r) => (r.direction === "PAYABLE" ? "pagamento" : "recebimento") }, { header: "Data", get: text("settled_on"), kind: "date" },
        { header: "Valor", get: (r) => r.amount as number, kind: "money" }, { header: "Forma", get: text("method") }, { header: "Referência", get: text("reference") },
        { header: "Descrição", get: text("description") }, { header: "Situação", get: text("status") },
      ],
    };
  }
  if (key === "plano-de-contas") {
    const { data } = await supabase.schema("fin").from("chart_accounts").select("code, name, kind, group, accountant_code").is("archived_at", null).order("code").limit(5000);
    return {
      rows: (data ?? []) as Row[],
      columns: [{ header: "Código", get: text("code") }, { header: "Nome", get: text("name") }, { header: "Tipo", get: text("kind") }, { header: "Grupo", get: text("group") }, { header: "Código do contador", get: text("accountant_code") }],
    };
  }
  // resumo: faturamento autorizado por CFOP, cancelamentos e notas recebidas
  const [{ data: out }, { data: inbound }] = await Promise.all([
    supabase.schema("fiscal").from("documents").select("cfop_main, status, totals").eq("direction", "OUT").gte("issue_at", b.from).lt("issue_at", b.to).limit(10000),
    supabase.schema("fiscal").from("inbound_dfe").select("amount").gte("issue_at", b.from).lt("issue_at", b.to).limit(10000),
  ]);
  const groups = new Map<string, { qtd: number; total: number }>();
  for (const d of out ?? []) {
    const k = d.status === "AUTHORIZED" ? `Autorizadas · CFOP ${d.cfop_main ?? "—"}` : d.status === "CANCELLED" ? "Canceladas" : d.status === "REJECTED" || d.status === "DENIED" ? "Rejeitadas/denegadas" : null;
    if (!k) continue;
    const g = groups.get(k) ?? { qtd: 0, total: 0 };
    g.qtd += 1;
    g.total += Number((d.totals as { vNF?: number } | null)?.vNF ?? 0);
    groups.set(k, g);
  }
  const received = (inbound ?? []).reduce((a, r) => a + Number(r.amount), 0);
  const rows: Row[] = [...groups.entries()].sort().map(([grupo, g]) => ({ grupo, qtd: g.qtd, total: g.total }));
  rows.push({ grupo: "Notas recebidas", qtd: (inbound ?? []).length, total: received });
  return { rows, columns: [{ header: "Grupo", get: text("grupo") }, { header: "Quantidade", get: text("qtd") }, { header: "Valor", get: (r) => r.total as number, kind: "money" }] };
}
