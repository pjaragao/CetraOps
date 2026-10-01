import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

/** Consulta de CEP (BrasilAPI) para preencher o endereço. Só para quem está logado; devolve 404 se o CEP não existe. */
export async function GET(_req: Request, { params }: { params: Promise<{ cep: string }> }) {
  await getSession();
  const cep = (await params).cep.replace(/\D/g, "");
  if (cep.length !== 8) return NextResponse.json({ error: "CEP inválido" }, { status: 400 });
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`, { signal: AbortSignal.timeout(6000), next: { revalidate: 86400 } });
    if (r.status === 404) return NextResponse.json({ error: "CEP não encontrado" }, { status: 404 });
    if (!r.ok) return NextResponse.json({ error: "Consulta de CEP indisponível: preencha à mão" }, { status: 502 });
    const d = (await r.json()) as { street?: string; neighborhood?: string; city?: string; state?: string };
    return NextResponse.json({ street: d.street ?? "", district: d.neighborhood ?? "", city: d.city ?? "", uf: d.state ?? "" });
  } catch {
    return NextResponse.json({ error: "Consulta de CEP indisponível: preencha à mão" }, { status: 502 });
  }
}
