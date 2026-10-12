import { describe, expect, it } from "vitest";
import { code128Bars, code128Svg, code128Values } from "./barcode";
import { parseBRNumber, parseDelimited, suggestPrice } from "./catalog-import";

describe("parseDelimited", () => {
  it("lê ; com aspas, aspas duplicadas, BOM e linhas em branco", () => {
    const rows = parseDelimited('﻿referencia;nome;preco\r\nLEG-1;"Legging ""Sculpt""; preta";429,00\r\n\r\nTOP-2;Top;199,90\r\n');
    expect(rows).toEqual([["referencia", "nome", "preco"], ["LEG-1", 'Legging "Sculpt"; preta', "429,00"], ["TOP-2", "Top", "199,90"]]);
  });
  it("descobre a vírgula e aceita quebra de linha dentro de aspas", () => {
    expect(parseDelimited('a,b\n"x\ny",2')).toEqual([["a", "b"], ["x\ny", "2"]]);
  });
});

describe("parseBRNumber", () => {
  it.each([["1.234,56", 1234.56], ["1234.56", 1234.56], ["R$ 99,90", 99.9], ["", null], ["abc", null], ["7", 7]])("%s → %s", (v, n) => {
    expect(parseBRNumber(v)).toBe(n);
  });
});

describe("suggestPrice", () => {
  it("custo × markup arredondado para cima no final ,90", () => {
    expect(suggestPrice(50, 2.4)).toBe(120.9);       // 120,00 → 120,90
    expect(suggestPrice(54.2, 2.4)).toBe(130.9);     // 130,08 → 130,90
    expect(suggestPrice(54.2, 2.4, 0)).toBe(131);    // inteiro: nunca abaixo de 130,08
    expect(suggestPrice(0, 2.4)).toBe(0);
  });
});

describe("Code 128", () => {
  it("usa o conjunto C para números e calcula o verificador", () => {
    const v = code128Values("123456");
    expect(v[0]).toBe(105);                          // START C
    expect(v.slice(1, 4)).toEqual([12, 34, 56]);
    const check = (105 + 12 * 1 + 34 * 2 + 56 * 3) % 103;
    expect(v[4]).toBe(check);
    expect(v.at(-1)).toBe(106);
  });
  it("SKU com letras usa o conjunto B (e troca para C numa sequência longa de dígitos)", () => {
    const v = code128Values("LEG-PRE-M");
    expect(v[0]).toBe(104);
    expect(v[1]).toBe("L".charCodeAt(0) - 32);
    const w = code128Values("AB123456");
    expect(w.slice(0, 4)).toEqual([104, 33, 34, 99]);   // START B, A, B, CODE C
    expect(w.slice(4, 7)).toEqual([12, 34, 56]);
  });
  it("cada símbolo tem 11 módulos (stop 13) e o SVG sai com as barras", () => {
    const { widths, modules } = code128Bars("SKU-1");
    const symbols = code128Values("SKU-1").length;
    expect(modules).toBe((symbols - 1) * 11 + 13 + 20);
    for (let i = 0; i < (symbols - 1) * 6; i += 6) expect(widths.slice(i, i + 6).reduce((x, y) => x + y, 0)).toBe(11);   // cada símbolo: 11 módulos
    expect(widths.slice(-7).reduce((x, y) => x + y, 0)).toBe(13);                                                       // stop
    expect(code128Svg("SKU-1")).toContain("<rect");
  });
  it("recusa caracteres fora do ASCII", () => {
    expect(() => code128Values("Saia ç")).toThrow();
  });
});
