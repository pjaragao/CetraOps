import "server-only";
import { fromBrasilApi, fromCnpjWs, fromOpenCnpj, fromReceitaWs, stateRegs, type CnpjData, type CnpjRaw } from "@centralops/domain";

/**
 * Consulta de CNPJ em fontes gratuitas (sem chave; todas com limite de uso, por isso o cache de 1 dia).
 * Ordem: BrasilAPI (mais completa: CNAEs, Simples/MEI, regime tributário, sócios) com o CNPJ.ws em paralelo para
 * completar as inscrições estaduais; se a BrasilAPI falhar ou estiver no limite, OpenCNPJ → CNPJ.ws → ReceitaWS.
 */

async function get(url: string, ms = 8000): Promise<CnpjRaw | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" }, next: { revalidate: 86400 } });
    if (r.status === 404) return { __notFound: true };
    if (!r.ok) return null;
    return (await r.json()) as CnpjRaw;
  } catch { return null; }
}

export type CnpjResult = { ok: true; data: CnpjData } | { ok: false; status: number; error: string };

export async function lookupCnpj(raw: string): Promise<CnpjResult> {
  const cnpj = raw.replace(/\D/g, "");
  if (cnpj.length !== 14) return { ok: false, status: 400, error: "CNPJ inválido" };
  const fetched_at = new Date().toISOString();
  const wsPromise = get(`https://publica.cnpj.ws/cnpj/${cnpj}`, 6000);       // em paralelo: só ele traz a inscrição estadual

  let notFound = 0;
  const brasil = await get(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
  if (brasil && !brasil.__notFound) {
    const ws = await wsPromise;
    const extra = ws && !ws.__notFound ? stateRegs(ws) : [];
    return { ok: true, data: { ...fromBrasilApi(brasil), state_registrations: extra, sources: ["BrasilAPI", ...(extra.length ? ["CNPJ.ws"] : [])], fetched_at } };
  }
  if (brasil?.__notFound) notFound++;

  const open = await get(`https://api.opencnpj.org/${cnpj}`);
  if (open && !open.__notFound && open.razao_social) {
    const ws = await wsPromise;
    const extra = ws && !ws.__notFound ? stateRegs(ws) : [];
    return { ok: true, data: { ...fromOpenCnpj(open), state_registrations: extra, sources: ["OpenCNPJ", ...(extra.length ? ["CNPJ.ws"] : [])], fetched_at } };
  }
  if (open?.__notFound) notFound++;

  const ws = await wsPromise;
  if (ws && !ws.__notFound && ws.razao_social) return { ok: true, data: { ...fromCnpjWs(ws), sources: ["CNPJ.ws"], fetched_at } };
  if (ws?.__notFound) notFound++;

  const rws = await get(`https://receitaws.com.br/v1/cnpj/${cnpj}`);
  if (rws && rws.status !== "ERROR" && rws.nome) return { ok: true, data: { ...fromReceitaWs(rws), state_registrations: [], sources: ["ReceitaWS"], fetched_at } };

  return notFound >= 2 ? { ok: false, status: 404, error: "CNPJ não encontrado na Receita" } : { ok: false, status: 502, error: "Consultas de CNPJ indisponíveis agora: preencha à mão ou tente em instantes" };
}
