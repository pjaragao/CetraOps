/** Origem dos dados do catálogo (colunas source* e catalog.source_log). */
export const SOURCE_LABEL: Record<string, string> = {
  SITE: "Site da marca", PDF_CATALOGO: "Catálogo em PDF", PDF_PEDIDO: "Pedido em PDF", PLANILHA: "Planilha",
  NFE: "NF-e (recebimento)", MANUAL: "Manual", SISTEMA: "Sistema", LEGADO: "Não registrada",
};
export const SOURCE_TONE: Record<string, "brand" | "info" | "warning" | "neutral"> = {
  SITE: "brand", PDF_CATALOGO: "info", PDF_PEDIDO: "info", PLANILHA: "warning", NFE: "warning", MANUAL: "neutral", SISTEMA: "neutral", LEGADO: "neutral",
};
export const ENTITY_LABEL: Record<string, string> = { PRODUCT: "Produto", VARIANT: "Variação", COLOR: "Cor", MEDIA: "Foto", PRICE: "Preço" };
export const ACTION_LABEL: Record<string, string> = { INSERT: "incluiu", UPDATE: "alterou", DELETE: "excluiu" };
export const FIELD_LABEL: Record<string, string> = {
  name: "nome", description: "descrição", composition: "composição", care: "cuidados", ncm: "NCM", gender: "linha", status: "situação",
  category_id: "categoria", collection_id: "coleção", brand_id: "marca", size_chart_id: "guia de tamanho", size_grid_id: "grade",
  backorder: "encomenda", wholesale_cost: "preço de atacado", custom_fields: "dados do site", sku: "SKU", gtin: "EAN", size: "tamanho",
  color_id: "cor", product_id: "produto", active: "ativa", supplier_sku: "código do fornecedor", price: "preço", code: "código", hex: "cor (hex)",
  source_url: "link da foto", variant_id: "variação", price_list_id: "tabela de preço",
};

export const fmtWhen = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "—";

/** Valor curto para o histórico (ids viram "—"; textos longos já vêm cortados do banco). */
export function showValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "sim" : "não";
  if (typeof v === "string" && /^[0-9a-f-]{36}$/.test(v)) return "(vínculo)";
  if (typeof v === "object") return "(dados)";
  return String(v);
}
