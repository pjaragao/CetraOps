import { NextResponse, type NextRequest } from "next/server";
import { toCsv } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";
import { todayIsoSP } from "@/lib/context";
import { csvColumns, loadSaved, runReport } from "@/lib/reports";
import { REPORTS } from "../../registry";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const session = await getSession();
  const { key } = await params;
  const report = REPORTS[key];
  const supabase = await createClient();
  const saved = report ? null : await loadSaved(supabase, key);
  if (!report && !saved) return new NextResponse("Relatório não encontrado", { status: 404 });
  if (report && !can(session, report.perm)) return new NextResponse("Sem permissão", { status: 403 });
  const q = req.nextUrl.searchParams;
  const to = q.get("ate") ?? todayIsoSP();
  const from = q.get("de") ?? to;
  if (!ISO.test(from) || !ISO.test(to)) return new NextResponse("Período inválido", { status: 400 });
  const headers = { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${report ? key : "relatorio"}-${from}-a-${to}.csv"`, "cache-control": "no-store" };
  if (saved) {
    try {
      const result = await runReport(supabase, { ...saved.spec, limit: 5000 }, { from, to, store: session.storeId });
      return new NextResponse(toCsv(result.rows, csvColumns(result.columns)), { headers });
    } catch (e) {
      return new NextResponse((e as Error).message, { status: 422 });
    }
  }
  const option = q.get("agrupar") ?? report!.options?.values[0][0] ?? "";
  if (report!.options && !report!.options.values.some(([v]) => v === option)) return new NextResponse("Agrupamento inválido", { status: 400 });
  const rows = await report!.load(supabase, { from, to, option });
  return new NextResponse(toCsv(rows, report!.columns), { headers });
}
