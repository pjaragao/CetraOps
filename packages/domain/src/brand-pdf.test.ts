import { describe, expect, it } from "vitest";
import { formatComposition, groupCatalogEntries, parseCatalogPdf, parseOrderPdf, sameName, splitBrandSku, titleCase, type PdfTextItem } from "./brand-pdf";
import pedido from "./__fixtures__/brand-pdf-pedido.json";
import catalogo from "./__fixtures__/brand-pdf-catalogo.json";

describe("código da etiqueta da marca", () => {
  it("separa modelo, cor e tamanho", () => {
    expect(splitBrandSku("17046390P")).toEqual({ model: "17046", colorCode: "390", size: "P" });
    expect(splitBrandSku("17847084PP")).toEqual({ model: "17847", colorCode: "084", size: "PP" });
    expect(splitBrandSku("LEG-001")).toBeNull();
  });
  it("nomes no formato do cadastro", () => {
    expect(titleCase("MACACÃO ESSENCE")).toBe("Macacão Essence");
    expect(titleCase("azul jeans")).toBe("Azul Jeans");
    expect(formatComposition("90% POLIAMIDA // 10% ELASTANO")).toBe("90% Poliamida / 10% Elastano");
    expect(sameName("Sky (012)", "SKY")).toBe(true);
  });
});

describe("pedido em PDF (La Sirene)", () => {
  const o = parseOrderPdf(pedido as PdfTextItem[][]);
  it("lê cabeçalho", () => {
    expect(o.number).toBe("11933");
    expect(o.date).toBe("2026-10-13");
    expect(o.representative).toBe("La Sirene");
    expect(o.supplierName).toBe("La Sirene");
  });
  it("lê os 38 itens das duas páginas e confere com o total impresso", () => {
    expect(o.lines).toHaveLength(38);
    expect(o.totalQty).toBe(62);
    expect(o.total).toBe(12585);
    expect(o.printedTotal).toBe(12585);
    expect(o.warnings).toEqual([]);
  });
  it("separa descrição, cor, tamanho e preço", () => {
    expect(o.lines[0]).toEqual({ code: "17046390P", description: "Macaquinho Essence - seamless", color: "Azul Jeans", size: "P", qty: 2, unitCost: 205, total: 410, model: "17046", colorCode: "390" });
    expect(o.lines.at(-1)).toMatchObject({ code: "17848085M", description: "Legging Ivy", color: "Vinho", size: "M", qty: 1, unitCost: 187 });
    expect(o.lines.find((l) => l.code === "17847084PP")).toMatchObject({ size: "PP", color: "Beige", unitCost: 153 });
  });
});

describe("catálogo de atacado em PDF", () => {
  const entries = parseCatalogPdf(catalogo as PdfTextItem[][]);
  it("uma entrada por página de produto (capas ficam de fora)", () => {
    expect(entries).toHaveLength(17);
    expect(entries[0]).toEqual({ page: 3, name: "Top Ivy", color: "Vermelho", composition: "90% Poliamida / 10% Elastano", sizes: ["PP", "P", "M", "G"], price: 153 });
  });
  it("nome em duas linhas e preço sem centavos", () => {
    expect(entries.find((e) => e.page === 18)).toMatchObject({ name: "Macacão Essence", color: "Brown", price: 262 });
    expect(entries.find((e) => e.page === 24)).toMatchObject({ name: "Macacão Essence", color: "Azul Jeans" });
  });
  it("agrupa por modelo e cor", () => {
    const g = groupCatalogEntries(entries);
    expect(g).toHaveLength(17);
    expect(new Set(g.map((e) => e.name))).toEqual(new Set(["Top Ivy", "Legging Ivy", "Macacão Essence", "Macaquinho Essence"]));
  });
});
