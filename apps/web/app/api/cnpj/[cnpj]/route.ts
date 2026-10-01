import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

/** Consulta de CNPJ (BrasilAPI) para preencher o cadastro de empresa. */
export async function GET(_req: Request, { params }: { params: Promise<{ cnpj: string }> }) {
  await getSession();
  const cnpj = (await params).cnpj.replace(/\D/g, "");
  if (cnpj.length !== 14) return NextResponse.json({ error: "CNPJ inválido" }, { status: 400 });
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { signal: AbortSignal.timeout(8000), next: { revalidate: 86400 } });
    if (r.status === 404) return NextResponse.json({ error: "CNPJ não encontrado" }, { status: 404 });
    if (!r.ok) return NextResponse.json({ error: "Consulta de CNPJ indisponível: preencha à mão" }, { status: 502 });
    const d = (await r.json()) as Record<string, unknown>;
    const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
    return NextResponse.json({
      legal_name: s("razao_social"), trade_name: s("nome_fantasia"), cep: s("cep"), street: s("logradouro"), number: s("numero"), complement: s("complemento"),
      district: s("bairro"), city: s("municipio"), uf: s("uf"), situation: s("descricao_situacao_cadastral"), phone: s("ddd_telefone_1"), email: s("email"),
    });
  } catch {
    return NextResponse.json({ error: "Consulta de CNPJ indisponível: preencha à mão" }, { status: 502 });
  }
}
