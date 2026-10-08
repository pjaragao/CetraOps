import { describe, expect, it } from "vitest";
import { classifyUserAgent, linkDestination, shortLink, trackingMessage, trackingUrl, type ResolvedLink } from "./tracking";

describe("links rastreados", () => {
  it("WhatsApp leva o código no texto pronto", () => {
    expect(trackingMessage("qr-recepcao", "Vim pelo QR da recepção")).toBe("Vim pelo QR da recepção (ref: qr-recepcao)");
    expect(trackingUrl("WHATSAPP", "+55 48 99999-0000", "qr-recepcao", "Oi!")).toBe("https://wa.me/5548999990000?text=Oi!%20(ref%3A%20qr-recepcao)");
  });
  it("Telegram usa /start com o código", () => {
    expect(trackingUrl("TELEGRAM", "@minhalojabot", "bio")).toBe("https://t.me/minhalojabot?start=bio");
  });
  it("sem número cadastrado não há link", () => {
    expect(trackingUrl("WHATSAPP", null, "x")).toBeNull();
    expect(trackingUrl("INSTAGRAM", "loja", "x")).toBeNull();
  });
});

const base: ResolvedLink = { target: "WEB", code: "outono-web", kind: "CAMPAIGN", channel: null, address: null, prefill_text: null, target_url: "https://loja.com.br/colecao", utm: { source: "whatsapp", medium: "campanha", campaign: "outono" }, campaign_code: "outono" };

describe("link curto", () => {
  it("monta o endereço curto sem barra duplicada", () => {
    expect(shortLink("https://app.loja.com.br/", "outono-qr")).toBe("https://app.loja.com.br/r/outono-qr");
    expect(shortLink(null, "x")).toBeNull();
  });
  it("página do site recebe UTM sem sobrescrever o que já existe", () => {
    expect(linkDestination(base)).toBe("https://loja.com.br/colecao?utm_source=whatsapp&utm_medium=campanha&utm_campaign=outono&utm_content=outono-web");
    expect(linkDestination({ ...base, target_url: "https://loja.com.br/c?utm_source=ig&x=1" })).toBe("https://loja.com.br/c?utm_source=ig&x=1&utm_medium=campanha&utm_campaign=outono&utm_content=outono-web");
    expect(linkDestination({ ...base, utm: null, campaign_code: null })).toBe("https://loja.com.br/colecao?utm_source=campaign&utm_medium=link&utm_campaign=outono-web&utm_content=outono-web");
    expect(linkDestination({ ...base, target_url: "não é url" })).toBeNull();
  });
  it("WhatsApp e Telegram seguem o mesmo formato dos links diretos", () => {
    expect(linkDestination({ ...base, target: "WHATSAPP", channel: "WHATSAPP", address: "5548999990000", code: "outono-qr", prefill_text: "Oi!" })).toBe("https://wa.me/5548999990000?text=Oi!%20(ref%3A%20outono-qr)");
    expect(linkDestination({ ...base, target: "TELEGRAM", channel: "TELEGRAM", address: "@lojabot", code: "bio" })).toBe("https://t.me/lojabot?start=bio");
    expect(linkDestination({ ...base, target: "WHATSAPP", channel: "WHATSAPP", address: null })).toBeNull();
  });
  it("robôs de pré-visualização não contam como clique", () => {
    expect(classifyUserAgent("WhatsApp/2.23.20 A")).toBe("BOT");
    expect(classifyUserAgent("facebookexternalhit/1.1")).toBe("BOT");
    expect(classifyUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit")).toBe("MOBILE");
    expect(classifyUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120")).toBe("DESKTOP");
    expect(classifyUserAgent("")).toBe("OTHER");
  });
});
