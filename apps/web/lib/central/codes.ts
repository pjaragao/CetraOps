import { parseBoleto, parsePixCode } from "@centralops/domain";

/** Documento lido (foto, PDF, XML ou código da câmera), no formato que a Central transforma em cartão. Compartilhado entre servidor e tela. */
export type DocKind = "identidade" | "boleto" | "pix" | "nota_ou_recibo" | "comprovante_endereco" | "etiqueta_produto" | "outro";

export interface ReadDocument {
  kind: DocKind;
  label: string;
  fields: Record<string, string | number | null>;
  checks: string[];
}

/** Boleto ou Pix lido pela câmera: vira documento sem IA (valor e vencimento saem do próprio código). */
export function documentFromCode(kind: "boleto" | "pix", code: string): ReadDocument | null {
  if (kind === "boleto") {
    const b = parseBoleto(code);
    if (!b?.valid) return null;
    return { kind: "boleto", label: `Boleto ${b.kind === "CONVENIO" ? "de convênio" : `do banco ${b.bank}`}`, checks: b.dueDate ? [] : ["Boleto sem vencimento no código: informe a data."],
             fields: { beneficiario: null, beneficiario_cnpj: null, valor: b.amount, vencimento: b.dueDate, descricao: null, codigo_barras: b.barcode } };
  }
  const p = parsePixCode(code);
  if (!p?.valid) return null;
  return { kind: "pix", label: `Pix${p.merchant ? ` para ${p.merchant}` : ""}`, checks: p.amount ? [] : ["Pix sem valor: informe o valor."],
           fields: { recebedor: p.merchant, chave: p.key, valor: p.amount, copia_e_cola: code } };
}
