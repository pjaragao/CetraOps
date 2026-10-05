import { describe, expect, it } from "vitest";
import { trackingMessage, trackingUrl } from "./tracking";

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
