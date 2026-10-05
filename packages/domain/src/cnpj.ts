/**
 * Normalização das consultas de CNPJ (BrasilAPI, OpenCNPJ, CNPJ.ws, ReceitaWS) num formato só.
 * Funções puras: a busca na rede fica no web (apps/web/lib/cnpj.ts).
 */
export interface CnpjAddress { cep: string; street: string; number: string; complement: string; district: string; city: string; uf: string; ibge: string }
export interface CnpjPartner { name: string; role: string; since: string | null; kind: string }
export interface CnpjData {
  cnpj: string; legal_name: string; trade_name: string; situation: string; situation_date: string | null; opened_at: string | null; branch: string;
  legal_nature: string; size: string; share_capital: number | null; simples: boolean | null; mei: boolean | null; tax_regime: string | null;
  cnae_main: { code: string; description: string } | null; cnaes_secondary: { code: string; description: string }[];
  address: CnpjAddress; phones: string[]; email: string; state_registrations: { ie: string; uf: string; active: boolean }[];
  partners: CnpjPartner[]; sources: string[]; fetched_at: string;
}

export type CnpjRaw = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v.replace(/\s{2,}/g, " ").trim() : typeof v === "number" ? String(v) : "");
/** Número de "112600000000.00", "112600000000,00", "1.234,56" ou 1234: com vírgula é formato brasileiro (ponto = milhar). */
const num = (v: unknown) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = s(v);
  if (!t) return null;
  const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(n) ? n : null;
};
/** Sim/não nos formatos das fontes: true/false, "S"/"N" ou "Sim"/"Não". */
const yn = (v: unknown) => {
  if (typeof v === "boolean") return v;
  const t = s(v).toLowerCase();
  return t === "s" || t === "sim" ? true : t === "n" || t === "não" || t === "nao" ? false : null;
};
const isoDate = (v: unknown) => { const t = s(v); if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10); const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const cnaeFmt = (c: unknown) => s(c).replace(/\D/g, "").padStart(7, "0");
/** Só dígitos; DDD "00" (números nacionais tipo 4004) sai; menos de 8 dígitos não é telefone. */
const phone = (raw: string) => { const d = raw.replace(/\D/g, "").replace(/^00/, ""); return d.length >= 8 ? d : ""; };
const cap = (t: string) => t.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

export function fromBrasilApi(d: CnpjRaw): Omit<CnpjData, "sources" | "fetched_at" | "state_registrations"> {
  const regimes = Array.isArray(d.regime_tributario) ? (d.regime_tributario as CnpjRaw[]) : [];
  const lastRegime = regimes.sort((a, b) => Number(b.ano) - Number(a.ano))[0];
  return {
    cnpj: s(d.cnpj), legal_name: s(d.razao_social), trade_name: s(d.nome_fantasia), situation: cap(s(d.descricao_situacao_cadastral)), situation_date: isoDate(d.data_situacao_cadastral),
    opened_at: isoDate(d.data_inicio_atividade), branch: cap(s(d.descricao_identificador_matriz_filial)), legal_nature: s(d.natureza_juridica), size: cap(s(d.porte)),
    share_capital: num(d.capital_social), simples: yn(d.opcao_pelo_simples), mei: yn(d.opcao_pelo_mei), tax_regime: lastRegime ? `${s(lastRegime.forma_de_tributacao)} (${s(lastRegime.ano)})` : null,
    cnae_main: d.cnae_fiscal ? { code: cnaeFmt(d.cnae_fiscal), description: s(d.cnae_fiscal_descricao) } : null,
    cnaes_secondary: (Array.isArray(d.cnaes_secundarios) ? (d.cnaes_secundarios as CnpjRaw[]) : []).filter((c) => Number(c.codigo) > 0).map((c) => ({ code: cnaeFmt(c.codigo), description: s(c.descricao) })),
    address: { cep: s(d.cep).replace(/\D/g, ""), street: [s(d.descricao_tipo_de_logradouro), s(d.logradouro)].filter(Boolean).join(" ").replace(/^(\S+) \1 /, "$1 "), number: s(d.numero), complement: s(d.complemento),
               district: s(d.bairro), city: cap(s(d.municipio)), uf: s(d.uf), ibge: s(d.codigo_municipio_ibge) },
    phones: [s(d.ddd_telefone_1), s(d.ddd_telefone_2)].map(phone).filter(Boolean), email: s(d.email).toLowerCase(),
    partners: (Array.isArray(d.qsa) ? (d.qsa as CnpjRaw[]) : []).map((p) => ({ name: s(p.nome_socio), role: s(p.qualificacao_socio), since: isoDate(p.data_entrada_sociedade), kind: s(p.identificador_de_socio) === "1" ? "Pessoa Jurídica" : "Pessoa Física" })),
  };
}

export function fromOpenCnpj(d: CnpjRaw): Omit<CnpjData, "sources" | "fetched_at" | "state_registrations"> {
  const cnaes = Array.isArray(d.cnaes) ? (d.cnaes as CnpjRaw[]) : [];
  const main = cnaes.find((c) => c.is_principal);
  return {
    cnpj: s(d.cnpj), legal_name: s(d.razao_social), trade_name: s(d.nome_fantasia), situation: s(d.situacao_cadastral), situation_date: isoDate(d.data_situacao_cadastral),
    opened_at: isoDate(d.data_inicio_atividade), branch: s(d.matriz_filial), legal_nature: s(d.natureza_juridica), size: s(d.porte_empresa), share_capital: num(d.capital_social),
    simples: yn(d.opcao_simples), mei: yn(d.opcao_mei), tax_regime: null,
    cnae_main: main ? { code: cnaeFmt(main.codigo), description: s(main.descricao) } : d.cnae_principal ? { code: cnaeFmt(d.cnae_principal), description: "" } : null,
    cnaes_secondary: cnaes.filter((c) => !c.is_principal).map((c) => ({ code: cnaeFmt(c.codigo), description: s(c.descricao) })),
    address: { cep: s(d.cep).replace(/\D/g, ""), street: [s(d.tipo_logradouro), s(d.logradouro)].filter(Boolean).join(" "), number: s(d.numero), complement: s(d.complemento), district: s(d.bairro),
               city: cap(s(d.municipio)), uf: s(d.uf), ibge: "" },
    phones: (Array.isArray(d.telefones) ? (d.telefones as CnpjRaw[]) : []).filter((t) => !t.is_fax).map((t) => phone(`${s(t.ddd)}${s(t.numero)}`)).filter(Boolean), email: s(d.email).toLowerCase(),
    partners: (Array.isArray(d.QSA) ? (d.QSA as CnpjRaw[]) : []).map((p) => ({ name: s(p.nome_socio), role: s(p.qualificacao_socio), since: isoDate(p.data_entrada_sociedade), kind: s(p.identificador_socio) })),
  };
}

export function fromCnpjWs(d: CnpjRaw): Omit<CnpjData, "sources" | "fetched_at"> {
  const e = (d.estabelecimento ?? {}) as CnpjRaw;
  const main = (e.atividade_principal ?? null) as CnpjRaw | null;
  const simples = (d.simples ?? null) as CnpjRaw | null;
  return {
    cnpj: s(e.cnpj), legal_name: s(d.razao_social), trade_name: s(e.nome_fantasia), situation: s(e.situacao_cadastral), situation_date: isoDate(e.data_situacao_cadastral),
    opened_at: isoDate(e.data_inicio_atividade), branch: s(e.tipo), legal_nature: s((d.natureza_juridica as CnpjRaw | null)?.descricao), size: s((d.porte as CnpjRaw | null)?.descricao),
    share_capital: num(d.capital_social), simples: simples ? yn(simples.simples) : false, mei: simples ? yn(simples.mei) : false, tax_regime: null,   // sem o bloco do Simples = nunca optou
    cnae_main: main ? { code: cnaeFmt(main.id), description: s(main.descricao) } : null,
    cnaes_secondary: (Array.isArray(e.atividades_secundarias) ? (e.atividades_secundarias as CnpjRaw[]) : []).map((c) => ({ code: cnaeFmt(c.id), description: s(c.descricao) })),
    address: { cep: s(e.cep).replace(/\D/g, ""), street: [s(e.tipo_logradouro), s(e.logradouro)].filter(Boolean).join(" "), number: s(e.numero), complement: s(e.complemento), district: s(e.bairro),
               city: s((e.cidade as CnpjRaw | null)?.nome), uf: s((e.estado as CnpjRaw | null)?.sigla), ibge: s((e.cidade as CnpjRaw | null)?.ibge_id) },
    phones: [`${s(e.ddd1)}${s(e.telefone1)}`, `${s(e.ddd2)}${s(e.telefone2)}`].map(phone).filter(Boolean), email: s(e.email).toLowerCase(),
    state_registrations: stateRegs(d),
    partners: (Array.isArray(d.socios) ? (d.socios as CnpjRaw[]) : []).map((p) => ({ name: s(p.nome), role: s((p.qualificacao_socio as CnpjRaw | null)?.descricao), since: isoDate(p.data_entrada), kind: s(p.tipo) })),
  };
}

export function stateRegs(d: CnpjRaw): CnpjData["state_registrations"] {
  const e = (d.estabelecimento ?? {}) as CnpjRaw;
  return (Array.isArray(e.inscricoes_estaduais) ? (e.inscricoes_estaduais as CnpjRaw[]) : [])
    .map((i) => ({ ie: s(i.inscricao_estadual), uf: s((i.estado as CnpjRaw | null)?.sigla), active: i.ativo === true })).filter((i) => i.ie);
}

export function fromReceitaWs(d: CnpjRaw): Omit<CnpjData, "sources" | "fetched_at" | "state_registrations"> {
  const main = (Array.isArray(d.atividade_principal) ? (d.atividade_principal as CnpjRaw[]) : [])[0];
  const simples = (d.simples ?? null) as CnpjRaw | null;
  const simei = (d.simei ?? null) as CnpjRaw | null;
  return {
    cnpj: s(d.cnpj).replace(/\D/g, ""), legal_name: s(d.nome), trade_name: s(d.fantasia), situation: cap(s(d.situacao)), situation_date: isoDate(d.data_situacao), opened_at: isoDate(d.abertura),
    branch: cap(s(d.tipo)), legal_nature: s(d.natureza_juridica).replace(/^[\d-]+\s*-\s*/, ""), size: cap(s(d.porte)), share_capital: num(d.capital_social),
    simples: simples ? simples.optante === true : null, mei: simei ? simei.optante === true : null, tax_regime: null,
    cnae_main: main ? { code: cnaeFmt(main.code), description: s(main.text) } : null,
    cnaes_secondary: (Array.isArray(d.atividades_secundarias) ? (d.atividades_secundarias as CnpjRaw[]) : []).filter((c) => s(c.code) !== "00.00-0-00").map((c) => ({ code: cnaeFmt(c.code), description: s(c.text) })),
    address: { cep: s(d.cep).replace(/\D/g, ""), street: s(d.logradouro), number: s(d.numero), complement: s(d.complemento), district: s(d.bairro), city: cap(s(d.municipio)), uf: s(d.uf), ibge: "" },
    phones: s(d.telefone).split("/").map(phone).filter(Boolean), email: s(d.email).toLowerCase(),
    partners: (Array.isArray(d.qsa) ? (d.qsa as CnpjRaw[]) : []).map((p) => ({ name: s(p.nome), role: s(p.qual).replace(/^\d+-/, ""), since: null, kind: "" })),
  };
}
