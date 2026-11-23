import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { splitMetaPayload } from "../../../supabase/functions/_shared/webhooks";
import { metaSecretList, metaWebhookChallenge, splitMetaWebhook, verifyMetaWebhookSignature } from "./meta-webhook";

const SECRET = "app-secret-de-teste";
// A Meta manda o JSON com é e \/ escapados: a assinatura vale para esses bytes, não para o JSON remontado
const raw = '{"object":"whatsapp_business_account","entry":[{"id":"WABA","changes":[{"field":"messages","value":{"messages":[{"id":"wamid.A","text":{"body":"Ol\\u00e1 \\/ tem?"}}]}}]}]}';
const sig = (body: string, secret = SECRET) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

describe("assinatura da Meta", () => {
  it("confere sobre o corpo bruto", async () => {
    expect(await verifyMetaWebhookSignature(raw, sig(raw), [SECRET])).toBe(true);
    expect(await verifyMetaWebhookSignature(raw, sig(raw).toUpperCase().replace("SHA256=", "sha256="), [SECRET])).toBe(true);
  });
  it("JSON remontado não passa (por isso o relay repassa os bytes sem mexer)", async () => {
    const remontado = JSON.stringify(JSON.parse(raw));
    expect(remontado).not.toBe(raw);
    expect(await verifyMetaWebhookSignature(remontado, sig(raw), [SECRET])).toBe(false);
  });
  it("recusa segredo errado, cabeçalho ausente ou de outro formato e lista vazia", async () => {
    expect(await verifyMetaWebhookSignature(raw, sig(raw), ["outro"])).toBe(false);
    expect(await verifyMetaWebhookSignature(raw, null, [SECRET])).toBe(false);
    expect(await verifyMetaWebhookSignature(raw, sig(raw).replace("sha256=", "sha1="), [SECRET])).toBe(false);
    expect(await verifyMetaWebhookSignature(raw, sig(raw), [])).toBe(false);
  });
  it("aceita um segredo por app (WhatsApp e Instagram)", async () => {
    const lista = metaSecretList(" segredo-ig , ,app-secret-de-teste ");
    expect(lista).toEqual(["segredo-ig", SECRET]);
    expect(await verifyMetaWebhookSignature(raw, sig(raw), lista)).toBe(true);
    expect(metaSecretList(undefined)).toEqual([]);
  });
});

describe("handshake da Meta", () => {
  const q = (s: string) => new URLSearchParams(s);
  it("devolve o challenge só com o token certo", () => {
    expect(metaWebhookChallenge(q("hub.mode=subscribe&hub.verify_token=tok&hub.challenge=1234"), "tok")).toBe("1234");
    expect(metaWebhookChallenge(q("hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1234"), "tok")).toBeNull();
    expect(metaWebhookChallenge(q("hub.mode=unsubscribe&hub.verify_token=tok&hub.challenge=1"), "tok")).toBeNull();
    expect(metaWebhookChallenge(q("hub.mode=subscribe&hub.verify_token=&hub.challenge=1"), "")).toBeNull();
  });
});

const wa = {
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [
    { field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "PN1" }, contacts: [{ wa_id: "5548" }],
      messages: [{ id: "wamid.A", type: "text", text: { body: "oi" } }, { id: "wamid.B", type: "text", text: { body: "tem?" } }],
      statuses: [{ id: "wamid.OUT", status: "delivered" }, { id: "wamid.OUT", status: "read" }] } },
    { field: "smb_message_echoes", value: { metadata: { phone_number_id: "PN1" }, message_echoes: [{ id: "wamid.E", to: "5548" }] } },
    { field: "message_template_status_update", value: { event: "APPROVED", message_template_id: 7 } },
  ] }],
};
const ig = {
  object: "instagram",
  entry: [{ id: "IGID", time: 1, messaging: [
    { sender: { id: "1" }, message: { mid: "m1", text: "oi" } }, { sender: { id: "1" }, read: { mid: "m0" } },
    { sender: { id: "1" }, reaction: { mid: "m1", action: "react" } }, { sender: { id: "1" }, postback: { mid: "p1" } }, { sender: { id: "1" }, other: true },
  ], changes: [{ field: "comments", value: { id: "c1", text: "lindo" } }, { field: "mentions", value: { media_id: "x" } }] }],
};

describe("divisão em eventos", () => {
  it("WhatsApp: um evento por mensagem/status/eco, cada um com a sua chave", async () => {
    const ev = await splitMetaWebhook(wa);
    expect(ev.slice(0, 5).map((e) => e.key)).toEqual(["wamid.A:msg", "wamid.B:msg", "wamid.OUT:delivered", "wamid.OUT:read", "wamid.E:echo"]);
    expect(ev[5].key).toMatch(/^wa:message_template_status_update:[0-9a-f]{32}$/);
    expect(ev.every((e) => e.provider === "META_WA")).toBe(true);
  });
  it("objeto desconhecido não gera evento", async () => {
    expect(await splitMetaWebhook({ object: "page", entry: [] })).toEqual([]);
    expect(await splitMetaWebhook(null)).toEqual([]);
  });
  it("divide igual à Edge Function webhooks-meta (mesma chave = mesmo evento, venha por onde vier)", async () => {
    for (const p of [wa, ig]) expect(await splitMetaWebhook(p)).toEqual(await splitMetaPayload(p));
  });
});
