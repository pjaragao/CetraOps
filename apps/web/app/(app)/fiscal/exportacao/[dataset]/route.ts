import { NextResponse, type NextRequest } from "next/server";
import { monthBounds, toCsv, type CsvColumn } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";
import { DATASETS, loadDataset } from "../datasets";

/** CSV de um conjunto de dados do mês para o contador. As políticas de acesso (RLS) valem: só sai o que a pessoa já pode ver. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ dataset: string }> }) {
  const session = await getSession();
  if (!can(session, "fiscal.read")) return new NextResponse("Sem permissão", { status: 403 });
  const { dataset } = await params;
  const mes = req.nextUrl.searchParams.get("mes") ?? "";
  const bounds = monthBounds(mes);
  if (!bounds || !DATASETS[dataset]) return new NextResponse("Conjunto ou mês inválido", { status: 400 });
  const supabase = await createClient();
  const { rows, columns } = await loadDataset(supabase, dataset, bounds);
  return new NextResponse(toCsv(rows, columns as CsvColumn<unknown>[]), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${dataset}-${mes}.csv"`, "cache-control": "no-store" },
  });
}
