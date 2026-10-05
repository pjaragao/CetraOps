import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { lookupCnpj } from "@/lib/cnpj";

/** Consulta de CNPJ (BrasilAPI, OpenCNPJ, CNPJ.ws, ReceitaWS) para preencher cadastros. Resposta normalizada em `data`. */
export async function GET(_req: Request, { params }: { params: Promise<{ cnpj: string }> }) {
  await getSession();
  const r = await lookupCnpj((await params).cnpj);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  const d = r.data;
  const ie = d.state_registrations.find((i) => i.active && i.uf === d.address.uf) ?? d.state_registrations.find((i) => i.active);
  // campos planos mantidos para os formulários existentes
  return NextResponse.json({
    data: d, legal_name: d.legal_name, trade_name: d.trade_name, cep: d.address.cep, street: d.address.street, number: d.address.number, complement: d.address.complement,
    district: d.address.district, city: d.address.city, uf: d.address.uf, situation: d.situation, phone: d.phones[0] ?? "", phone2: d.phones[1] ?? "", email: d.email,
    ie: ie?.ie ?? "", cnae: d.cnae_main?.code ?? "", cnaes_secondary: d.cnaes_secondary.map((c) => c.code),
  });
}
