import { NextResponse } from "next/server";
import { acquirerCsvTemplate } from "@centralops/domain";
import { getSession } from "@/lib/session";

/** Planilha-modelo do layout padrão de recebíveis da adquirente. */
export async function GET() {
  await getSession();
  return new NextResponse(acquirerCsvTemplate(), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="modelo-recebiveis-adquirente.csv"', "cache-control": "no-store" },
  });
}
