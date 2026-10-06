/**
 * Leitores SEM IA (100% de acerto, custo zero) dos códigos que chegam por foto, câmera ou texto:
 * CPF, EAN/GTIN, boleto bancário e de convênio (código de barras ou linha digitável), chave de NF-e/NFC-e e Pix copia-e-cola (BR Code).
 * A IA só entra no que é texto livre; quando um destes códigos aparece, ele manda nos valores (valor, vencimento, chave).
 */

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const iso = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------------------------------------
// CPF
// ---------------------------------------------------------------------------------------------------------------------------------
/** Dígitos verificadores do CPF (a mesma regra de private.valid_cpf no banco). */
export function validCpf(raw: string | null | undefined): boolean {
  const d = digits(raw);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const k of [9, 10]) {
    let s = 0;
    for (let i = 0; i < k; i++) s += Number(d[i]) * (k + 1 - i);
    const r = ((s * 10) % 11) % 10;
    if (r !== Number(d[k])) return false;
  }
  return true;
}

export function maskCpf(raw: string): string {
  const d = digits(raw);
  return d.length === 11 ? `***.***.*${d.slice(7, 9)}-${d.slice(9)}` : "***";
}

// ---------------------------------------------------------------------------------------------------------------------------------
// EAN / GTIN (8, 12, 13 ou 14 dígitos)
// ---------------------------------------------------------------------------------------------------------------------------------
export function validGtin(raw: string | null | undefined): boolean {
  const d = digits(raw);
  if (![8, 12, 13, 14].includes(d.length) || d !== (raw ?? "").trim()) return false;
  const body = d.slice(0, -1).split("").reverse();
  const sum = body.reduce((a, c, i) => a + Number(c) * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Boleto
// ---------------------------------------------------------------------------------------------------------------------------------
function mod10(num: string): number {
  let sum = 0;
  num.split("").reverse().forEach((c, i) => {
    let p = Number(c) * (i % 2 === 0 ? 2 : 1);
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    sum += p;
  });
  return (10 - (sum % 10)) % 10;
}

/** Módulo 11 do boleto bancário (pesos 2..9; resto 0, 10 ou 11 vira 1). */
function mod11Bank(num: string): number {
  let sum = 0;
  num.split("").reverse().forEach((c, i) => { sum += Number(c) * (2 + (i % 8)); });
  const r = 11 - (sum % 11);
  return r === 0 || r === 10 || r === 11 ? 1 : r;
}

/** Módulo 11 da arrecadação (convênio): resto 0 ou 1 → 0, 10 → 1. */
function mod11Collection(num: string): number {
  let sum = 0;
  num.split("").reverse().forEach((c, i) => { sum += Number(c) * (2 + (i % 8)); });
  const r = sum % 11;
  return r === 0 || r === 1 ? 0 : r === 10 ? 1 : 11 - r;
}

/**
 * Fator de vencimento → data. A contagem começou em 07/10/1997 e, ao chegar em 9999 (21/02/2025), recomeçou em 1000 (22/02/2025):
 * o mesmo fator vale para duas datas, e a certa é a mais próxima de hoje.
 */
export function dueDateFromFactor(factor: number, today = new Date()): string | null {
  if (!factor || factor < 1000) return null;
  const day = 86_400_000;
  const old = new Date(Date.UTC(1997, 9, 7) + factor * day);
  const cycle2 = new Date(Date.UTC(2025, 1, 22) + (factor - 1000) * day);
  return iso(Math.abs(old.getTime() - today.getTime()) <= Math.abs(cycle2.getTime() - today.getTime()) ? old : cycle2);
}

export interface Boleto {
  kind: "BANCARIO" | "CONVENIO";
  /** Código de barras de 44 dígitos (o que vai para o pagamento). */
  barcode: string;
  /** Banco (3 dígitos) no bancário; segmento (1 dígito) no convênio. */
  bank: string | null;
  amount: number | null;
  dueDate: string | null;
  valid: boolean;
}

/** Linha digitável (47 ou 48 dígitos) ou código de barras (44) → boleto com valor e vencimento conferidos pelos dígitos verificadores. */
export function parseBoleto(raw: string | null | undefined, today = new Date()): Boleto | null {
  const d = digits(raw);
  if (d.length === 47) {
    const fields = [d.slice(0, 9), d.slice(10, 20), d.slice(21, 31)];
    const dvs = [d[9], d[20], d[31]];
    const fieldsOk = fields.every((f, i) => mod10(f) === Number(dvs[i]));
    const barcode = d.slice(0, 4) + d[32] + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
    const b = parseBoleto(barcode, today);
    return b ? { ...b, valid: b.valid && fieldsOk } : null;
  }
  if (d.length === 48 && d[0] === "8") {
    const blocks = [0, 1, 2, 3].map((i) => d.slice(i * 12, i * 12 + 12));
    const ref = Number(d[2]);
    const dv = (s: string) => (ref === 6 || ref === 7 ? mod10(s) : mod11Collection(s));
    const blocksOk = blocks.every((b) => dv(b.slice(0, 11)) === Number(b[11]));
    const b = parseBoleto(blocks.map((x) => x.slice(0, 11)).join(""), today);
    return b ? { ...b, valid: b.valid && blocksOk } : null;
  }
  if (d.length !== 44) return null;
  if (d[0] === "8") {
    const ref = Number(d[2]);
    const general = ref === 6 || ref === 7 ? mod10(d.slice(0, 3) + d.slice(4)) : mod11Collection(d.slice(0, 3) + d.slice(4));
    const effective = ref === 6 || ref === 8;                         // 6/8: valor em reais; 7/9: quantidade de referência
    return { kind: "CONVENIO", barcode: d, bank: d[1], amount: effective ? Number(d.slice(4, 15)) / 100 : null, dueDate: null, valid: general === Number(d[3]) };
  }
  const general = mod11Bank(d.slice(0, 4) + d.slice(5));
  const amount = Number(d.slice(9, 19)) / 100;
  return { kind: "BANCARIO", barcode: d, bank: d.slice(0, 3), amount: amount > 0 ? amount : null, dueDate: dueDateFromFactor(Number(d.slice(5, 9)), today), valid: general === Number(d[4]) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Chave de acesso da NF-e / NFC-e (44 dígitos)
// ---------------------------------------------------------------------------------------------------------------------------------
export interface NfeKey { key: string; uf: string; yearMonth: string; cnpj: string; model: "55" | "65" | string; series: string; number: string; valid: boolean }

export function nfeKeyDv(key43: string): number {
  let sum = 0;
  key43.split("").reverse().forEach((c, i) => { sum += Number(c) * (2 + (i % 8)); });
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}

/** Chave de 44 dígitos solta no texto, no código de barras da DANFE ou no QR da NFC-e ("p=CHAVE|…"). */
export function parseNfeKey(raw: string | null | undefined): NfeKey | null {
  const text = raw ?? "";
  const fromQr = text.match(/[?&]p=(\d{44})/)?.[1];
  const key = fromQr ?? (digits(text).length === 44 ? digits(text) : text.match(/(?:\d[\s.]?){44}/)?.[0]?.replace(/\D/g, ""));
  if (!key || key.length !== 44) return null;
  return {
    key, uf: key.slice(0, 2), yearMonth: `20${key.slice(2, 4)}-${key.slice(4, 6)}`, cnpj: key.slice(6, 20), model: key.slice(20, 22), series: key.slice(22, 25),
    number: String(Number(key.slice(25, 34))), valid: nfeKeyDv(key.slice(0, 43)) === Number(key[43]),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Pix copia-e-cola / QR (BR Code, padrão EMV)
// ---------------------------------------------------------------------------------------------------------------------------------
/** CRC16/CCITT-FALSE (polinômio 0x1021, início 0xFFFF), como o Banco Central define para o BR Code. */
export function crc16(text: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function tlv(payload: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i + 4 <= payload.length) {
    const id = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    if (!Number.isFinite(len)) break;
    out.set(id, payload.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return out;
}

export interface PixCode { key: string | null; url: string | null; dynamic: boolean; amount: number | null; merchant: string | null; city: string | null; txid: string | null; description: string | null; valid: boolean }

export function parsePixCode(raw: string | null | undefined): PixCode | null {
  const text = (raw ?? "").trim();
  if (!text.startsWith("000201")) return null;
  const top = tlv(text);
  const account = [...top.entries()].find(([id, v]) => Number(id) >= 26 && Number(id) <= 51 && /br\.gov\.bcb\.pix/i.test(v));
  if (!account) return null;
  const acc = tlv(account[1]);
  const extra = tlv(top.get("62") ?? "");
  const crcOk = text.length > 4 && text.slice(-8, -4) === "6304" && crc16(text.slice(0, -4)) === text.slice(-4).toUpperCase();
  const amount = top.get("54");
  return {
    key: acc.get("01") ?? null, url: acc.get("25") ?? null, dynamic: top.get("01") === "12" || acc.has("25"), amount: amount ? Number(amount) : null,
    merchant: top.get("59") ?? null, city: top.get("60") ?? null, txid: extra.get("05") ?? null, description: acc.get("02") ?? null, valid: crcOk,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// O que é este código?
// ---------------------------------------------------------------------------------------------------------------------------------
export type CodeKind = "EAN" | "BOLETO" | "NFE_KEY" | "PIX" | "SKU";

/** Classifica um código lido pela câmera ou digitado: produto, boleto, chave de nota ou Pix. */
export function classifyCode(raw: string): CodeKind {
  const t = raw.trim();
  if (parsePixCode(t)) return "PIX";
  const nfe = parseNfeKey(t);
  if (nfe?.valid && (nfe.model === "55" || nfe.model === "65")) return "NFE_KEY";
  const boleto = parseBoleto(t);
  if (boleto?.valid) return "BOLETO";
  if (validGtin(t)) return "EAN";
  return "SKU";
}
