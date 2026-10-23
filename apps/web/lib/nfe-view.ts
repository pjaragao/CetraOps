/**
 * Leitura da NF-e para a tela de visualização (estilo DANFE). O grosso vem de fiscal.parse_nfe (itens, totais, duplicatas,
 * pagamento, protocolo); aqui ficam só os rótulos e o que o parse não traz (endereços, transporte), lido direto do XML.
 */
export interface NfeParsed {
  access_key: string;
  header: { number: number; series: number; issue_at: string; operation_nature: string | null; fin_nfe: number; tp_amb: string; mod_frete: string | null; info: string | null };
  issuer: { cnpj: string; name: string; fantasy: string | null; ie: string | null; city: string | null; uf: string | null; crt: string | null };
  recipient: { cnpj: string | null; cpf: string | null; name: string | null };
  items: { n_item: number; cprod: string | null; cean: string | null; xprod: string; ncm: string | null; cfop: string | null; ucom: string | null; qcom: number; vuncom: number;
           vprod: number; vdesc: number; vfrete: number; vipi: number; vicmsst: number; csosn: string | null; cst: string | null }[];
  totals: Record<string, number>;
  installments: { n_dup: string | null; due_date: string; amount: number }[];
  payments: { t_pag: string; amount: number }[];
  protocol: { cstat: string | null; number: string | null; received_at: string | null } | null;
}

export const T_PAG: Record<string, string> = {
  "01": "Dinheiro", "02": "Cheque", "03": "Cartão de crédito", "04": "Cartão de débito", "05": "Crédito loja", "10": "Vale-alimentação", "11": "Vale-refeição",
  "12": "Vale-presente", "13": "Vale-combustível", "15": "Boleto", "16": "Depósito", "17": "Pix", "18": "Transferência", "19": "Fidelidade/cashback",
  "90": "Sem pagamento (pago por fora)", "99": "Outros",
};
export const MOD_FRETE: Record<string, string> = {
  "0": "por conta do emitente (CIF)", "1": "por conta do destinatário (FOB)", "2": "por conta de terceiros", "3": "transporte próprio do remetente",
  "4": "transporte próprio do destinatário", "9": "sem frete",
};
export const FIN_NFE: Record<number, string> = { 1: "normal", 2: "complementar", 3: "de ajuste", 4: "devolução" };

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]?.trim() || null;
const block = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? "";

function address(b: string) {
  if (!b) return null;
  const line = [tag(b, "xLgr"), tag(b, "nro"), tag(b, "xCpl")].filter(Boolean).join(", ");
  const cep = tag(b, "CEP")?.replace(/^(\d{5})(\d{3})$/, "$1-$2");
  return [line, tag(b, "xBairro"), [tag(b, "xMun"), tag(b, "UF")].filter(Boolean).join("/"), cep].filter(Boolean).join(" · ") || null;
}

/** O que o parse do banco não traz: endereços, fone, transportadora, volumes e data de saída. */
export function nfeExtras(xml: string) {
  const emit = block(xml, "emit"), dest = block(xml, "dest"), transp = block(xml, "transp"), vol = block(transp, "vol"), carrier = block(transp, "transporta");
  return {
    issuerAddress: address(block(emit, "enderEmit")), issuerPhone: tag(block(emit, "enderEmit"), "fone"), issuerCnae: tag(emit, "CNAE"),
    recipientAddress: address(block(dest, "enderDest")), recipientIe: tag(dest, "IE"),
    leftAt: tag(block(xml, "ide"), "dhSaiEnt"),
    carrier: carrier ? { name: tag(carrier, "xNome"), doc: tag(carrier, "CNPJ") ?? tag(carrier, "CPF"), city: [tag(carrier, "xMun"), tag(carrier, "UF")].filter(Boolean).join("/") || null } : null,
    volumes: vol ? { qty: tag(vol, "qVol"), kind: tag(vol, "esp"), gross: tag(vol, "pesoB"), net: tag(vol, "pesoL") } : null,
    fiscoInfo: tag(block(xml, "infAdic"), "infAdFisco"),
  };
}

export const fmtKey = (k: string) => k.replace(/(\d{4})(?=\d)/g, "$1 ");
export const fmtCnpj = (v: string | null | undefined) => (v ?? "").replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5").replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
export const fmtNcm = (v: string | null | undefined) => (v ?? "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1.$2.$3");

/** Sugestão da triagem (fiscal.inbound_dfe.triage), como o worker grava. */
export interface DfeTriage {
  destino: "REIMBURSED" | "PAYABLE" | "PAID" | "ASSET" | "EXPENSE" | "STOCK" | "UNKNOWN";
  classificacao: string; confianca: number; motivo: string; sem_cobranca: boolean; alertas: string[];
  linhas: { chart_account_id: string; amount: number; conta: string }[];
  itens: { n: number; descricao: string; ncm: string | null; valor: number; destino: string; conta: string | null; conta_id: string | null; confianca: number; motivo: string; fonte: string }[];
  reembolsos: { id: string; number: string; purpose: string; status: string; total: number; do_fornecedor: number }[];
  contas: { id: string; number: string; description: string; total: number; approval_status: string; pago: number }[];
  extrato?: { id: string; posted_on: string; amount: number; descricao: string; banco: string }[];
  movimentos?: { id: string; occurred_on: string; amount: number; descricao: string; conta: string; banco: string }[];
  vinculo?: { title_id?: string; statement_line_id?: string; cash_transaction_id?: string } | null;
}

export const DESTINATION_LABEL: Record<string, { label: string; tone: "success" | "info" | "warning" | "neutral" | "brand" }> = {
  STOCK: { label: "mercadoria (estoque)", tone: "info" }, ASSET: { label: "patrimônio", tone: "brand" }, EXPENSE: { label: "despesa / consumo", tone: "warning" },
  REIMBURSED: { label: "paga por reembolso", tone: "success" }, PAYABLE: { label: "conta a pagar existente", tone: "success" }, PAID: { label: "já paga pelo banco", tone: "success" }, IGNORED: { label: "sem lançamento", tone: "neutral" }, UNKNOWN: { label: "a decidir", tone: "neutral" },
};
export const ITEM_DEST: Record<string, string> = { ESTOQUE: "estoque", PATRIMONIO: "patrimônio", CONSUMO: "consumo", DESPESA: "despesa", INDEFINIDO: "a decidir" };
export const SOURCE_LABEL: Record<string, string> = { regra: "regra (NCM/descrição)", ia: "IA", catalogo: "catálogo", fornecedor: "fornecedor" };
