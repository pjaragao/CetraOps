import { NextResponse, type NextRequest } from "next/server";
import { toCsv, type CsvColumn } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";

interface Row { title_number: string | null; description: string | null; party_name: string | null; receiver_name: string | null; n: number | null; due_date: string | null; amount: number | null; balance: number | null; status: string | null; settled_on: string | null; document_kind: string | null; document_number: string | null; competence_date: string | null }
const STATUS: Record<string, string> = { OPEN: "em aberto", PARTIAL: "parcial", SETTLED: "quitada", CANCELLED: "cancelada", RENEGOTIATED: "renegociada" };

/** CSV das parcelas com os mesmos filtros da tela (as políticas de acesso valem: só sai o que a pessoa já vê). */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!can(session, "fin.read")) return new NextResponse("Sem permissão", { status: 403 });
  const sp = req.nextUrl.searchParams;
  const dir = sp.get("dir") === "RECEIVABLE" ? "RECEIVABLE" : "PAYABLE";
  const supabase = await createClient();
  let q = supabase.schema("fin").from("v_installments")
    .select("title_number, description, party_name, receiver_name, n, due_date, amount, balance, status, settled_on, document_kind, document_number, competence_date")
    .eq("direction", dir).order("due_date").limit(20000);
  if (session.storeId) q = q.or(`store_id.eq.${session.storeId},store_id.is.null`);
  const situacao = sp.get("situacao") ?? "";
  if (situacao === "") q = q.in("status", ["OPEN", "PARTIAL"]).neq("title_status", "CANCELLED");
  else if (situacao === "pagas") q = q.eq("status", "SETTLED");
  else if (situacao === "canceladas") q = q.eq("status", "CANCELLED");
  const filtro = sp.get("filtro");
  if (filtro === "vencidas") q = q.lt("due_date", new Date().toISOString().slice(0, 10));
  else if (filtro === "rascunho") q = q.eq("approval_status", "DRAFT");
  for (const w of (sp.get("q") ?? "").replace(/[%,()]/g, " ").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5)) q = q.ilike("search", `%${w}%`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(sp.get("de") ?? "")) q = q.gte("due_date", sp.get("de")!);
  if (/^\d{4}-\d{2}-\d{2}$/.test(sp.get("ate") ?? "")) q = q.lte("due_date", sp.get("ate")!);
  const { data, error } = await q;
  if (error) return new NextResponse(error.message, { status: 400 });
  const cols: CsvColumn<Row>[] = [
    { header: "Título", get: (r) => r.title_number }, { header: "Parcela", get: (r) => r.n }, { header: "Descrição", get: (r) => r.description },
    { header: dir === "PAYABLE" ? "Fornecedor" : "Cliente", get: (r) => r.party_name }, { header: "Recebedor", get: (r) => r.receiver_name },
    { header: "Documento", get: (r) => [r.document_kind, r.document_number].filter(Boolean).join(" ") }, { header: "Competência", get: (r) => r.competence_date, kind: "date" },
    { header: "Vencimento", get: (r) => r.due_date, kind: "date" }, { header: "Valor", get: (r) => r.amount, kind: "money" }, { header: "Saldo", get: (r) => r.balance, kind: "money" },
    { header: "Situação", get: (r) => STATUS[r.status ?? ""] ?? r.status }, { header: "Quitada em", get: (r) => r.settled_on, kind: "date" },
  ];
  return new NextResponse(toCsv((data ?? []) as Row[], cols), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${dir === "PAYABLE" ? "contas-a-pagar" : "contas-a-receber"}.csv"`, "cache-control": "no-store" },
  });
}
