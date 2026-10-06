import { describe, expect, it } from "vitest";
import { classifyCode, crc16, dueDateFromFactor, maskCpf, parseBoleto, parseNfeKey, parsePixCode, validCpf, validGtin } from "./readers";

const today = new Date("2026-10-06T12:00:00Z");

/** Monta um boleto bancário válido: acha o dígito geral que fecha o módulo 11 (o leitor confere com o próprio algoritmo). */
function bankBarcode(bank: string, factor: number, cents: number, free: string): string {
  const body = (dv: number) => `${bank}9${dv}${String(factor).padStart(4, "0")}${String(cents).padStart(10, "0")}${free}`;
  for (let dv = 1; dv <= 9; dv++) if (parseBoleto(body(dv), today)?.valid) return body(dv);
  throw new Error("sem dígito válido");
}

/** Converte código de barras em linha digitável (campos com dígito módulo 10). */
function toLine(barcode: string): string {
  const mod10 = (n: string) => {
    let s = 0;
    n.split("").reverse().forEach((c, i) => { let p = Number(c) * (i % 2 === 0 ? 2 : 1); if (p > 9) p = Math.floor(p / 10) + (p % 10); s += p; });
    return (10 - (s % 10)) % 10;
  };
  const f1 = barcode.slice(0, 4) + barcode.slice(19, 24);
  const f2 = barcode.slice(24, 34);
  const f3 = barcode.slice(34, 44);
  return `${f1}${mod10(f1)}${f2}${mod10(f2)}${f3}${mod10(f3)}${barcode[4]}${barcode.slice(5, 19)}`;
}

describe("CPF e EAN", () => {
  it("dígitos verificadores do CPF", () => {
    expect(validCpf("529.982.247-25")).toBe(true);
    expect(validCpf("123.456.789-09")).toBe(true);
    expect(validCpf("529.982.247-24")).toBe(false);
    expect(validCpf("111.111.111-11")).toBe(false);
    expect(maskCpf("52998224725")).toBe("***.***.*47-25");
  });

  it("EAN-13 e EAN-8", () => {
    expect(validGtin("5901234123457")).toBe(true);
    expect(validGtin("4006381333931")).toBe(true);
    expect(validGtin("5901234123458")).toBe(false);
    expect(validGtin("96385074")).toBe(true);
    expect(validGtin("DEMO-LEG01")).toBe(false);
  });
});

describe("boleto", () => {
  it("fator de vencimento nos dois ciclos (virada de 22/02/2025)", () => {
    expect(dueDateFromFactor(1000, new Date("2000-07-01"))).toBe("2000-07-03");
    expect(dueDateFromFactor(9999, new Date("2025-02-01"))).toBe("2025-02-21");
    expect(dueDateFromFactor(1000, today)).toBe("2025-02-22");
    expect(dueDateFromFactor(1595, today)).toBe("2026-10-10");
  });

  it("código de barras e linha digitável dão o mesmo valor e vencimento", () => {
    const barcode = bankBarcode("341", 1595, 32050, "1790010104351004791020150");
    const b = parseBoleto(barcode, today)!;
    expect(b).toMatchObject({ kind: "BANCARIO", bank: "341", amount: 320.5, dueDate: "2026-10-10", valid: true });
    const line = toLine(barcode);
    expect(line).toHaveLength(47);
    expect(parseBoleto(line, today)).toMatchObject({ barcode, amount: 320.5, dueDate: "2026-10-10", valid: true });
    const typo = line.slice(0, 12) + ((Number(line[12]) + 1) % 10) + line.slice(13);
    expect(parseBoleto(typo, today)?.valid).toBe(false);          // um dígito errado na foto é pego pelo dígito verificador
  });

  it("convênio (luz, água): valor do código, sem vencimento", () => {
    const body = (dv: number) => `836${dv}0000001234500220000000000000000000000000`.slice(0, 44);
    let code = "";
    for (let dv = 0; dv <= 9 && !code; dv++) if (parseBoleto(body(dv))?.valid) code = body(dv);
    expect(parseBoleto(code)).toMatchObject({ kind: "CONVENIO", amount: 123.45, dueDate: null, valid: true });
  });
});

describe("chave de NF-e e Pix", () => {
  it("chave de 44 dígitos com o dígito verificador do banco", () => {
    const k = parseNfeKey("4226 1073 1845 2900 0186 6500 1000 0001 2311 2345 6784")!;
    expect(k).toMatchObject({ uf: "42", yearMonth: "2026-10", cnpj: "73184529000186", model: "65", number: "123", valid: true });
    expect(parseNfeKey("35261060577231000183550010000043211000001233")).toMatchObject({ model: "55", valid: true });
    expect(parseNfeKey("https://sat.sef.sc.gov.br/nfce/consulta?p=42261073184529000186650010000001231123456784|2|1|1|abc")?.valid).toBe(true);
    expect(parseNfeKey("42261073184529000186650010000001231123456785")?.valid).toBe(false);
  });

  it("CRC16 do BR Code e o exemplo do Banco Central", () => {
    expect(crc16("123456789")).toBe("29B1");
    const pix = "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D";
    expect(parsePixCode(pix)).toMatchObject({ key: "123e4567-e12b-12d1-a456-426655440000", merchant: "Fulano de Tal", city: "BRASILIA", amount: null, dynamic: false, valid: true });
    expect(parsePixCode(pix.slice(0, -1) + "E")?.valid).toBe(false);
  });

  it("Pix com valor", () => {
    const base = "00020126360014br.gov.bcb.pix0114+55489999988885204000053039865406320.505802BR5912Energia Ltda6013FLORIANOPOLIS62070503***6304";
    const pix = base + crc16(base);
    expect(parsePixCode(pix)).toMatchObject({ key: "+5548999998888", amount: 320.5, merchant: "Energia Ltda", valid: true });
  });

  it("classifica o que a câmera leu", () => {
    expect(classifyCode("5901234123457")).toBe("EAN");
    expect(classifyCode("42261073184529000186650010000001231123456784")).toBe("NFE_KEY");
    expect(classifyCode(bankBarcode("341", 1595, 32050, "1790010104351004791020150"))).toBe("BOLETO");
    expect(classifyCode("00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D")).toBe("PIX");
    expect(classifyCode("DEMO-LEG01-PRT-G")).toBe("SKU");
  });
});
