// Rodar com: node --test supabase/functions/_shared/   (Node 22.18+ executa TypeScript direto; o mesmo arquivo roda no Deno)
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { hmacSha256Hex, metaChallenge, splitMetaPayload, telegramEvent, timingSafeEqual, verifyMetaSignature, verifyTelegramSecret } from "./webhooks.ts";

const SECRET = "app-secret-de-teste";
const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

test("HMAC confere com a implementação de referência do Node", async () => {
  assert.equal(await hmacSha256Hex(SECRET, body), createHmac("sha256", SECRET).update(body).digest("hex"));
});

test("assinatura do Meta: válida, adulterada, ausente, formato errado e múltiplos segredos", async () => {
  const sig = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  assert.equal(await verifyMetaSignature(body, sig, [SECRET]), true);
  assert.equal(await verifyMetaSignature(body, sig.toUpperCase().replace("SHA256=", "sha256="), [SECRET]), true);   // hex em maiúsculas também vale
  assert.equal(await verifyMetaSignature(body + " ", sig, [SECRET]), false);                                        // corpo alterado
  assert.equal(await verifyMetaSignature(body, sig, ["outro-segredo"]), false);
  assert.equal(await verifyMetaSignature(body, sig, ["", "outro", SECRET]), true);                                  // WhatsApp e Instagram com apps distintos
  assert.equal(await verifyMetaSignature(body, null, [SECRET]), false);
  assert.equal(await verifyMetaSignature(body, sig.replace("sha256=", "sha1="), [SECRET]), false);
  assert.equal(await verifyMetaSignature(body, sig, []), false);                                                     // sem segredo configurado, nada passa
  assert.equal(await verifyMetaSignature(body, sig, [""]), false);
});

test("comparação em tempo constante", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
});

test("handshake GET do Meta", () => {
  const u = (q: string) => new URL(`https://x.test/webhooks-meta?${q}`);
  assert.equal(metaChallenge(u("hub.mode=subscribe&hub.verify_token=tok&hub.challenge=1234"), "tok"), "1234");
  assert.equal(metaChallenge(u("hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1234"), "tok"), null);
  assert.equal(metaChallenge(u("hub.mode=unsubscribe&hub.verify_token=tok&hub.challenge=1"), "tok"), null);
  assert.equal(metaChallenge(u("hub.mode=subscribe&hub.verify_token=&hub.challenge=1"), ""), null);                   // sem token configurado, recusa
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

test("WhatsApp: um evento por mensagem/status/eco, cada um com a sua chave", async () => {
  const ev = await splitMetaPayload(wa);
  assert.deepEqual(ev.slice(0, 5).map((e) => e.key), ["wamid.A:msg", "wamid.B:msg", "wamid.OUT:delivered", "wamid.OUT:read", "wamid.E:echo"]);
  const first = ev[0].payload as { entry: { changes: { value: { messages: { id: string }[]; metadata: unknown } }[] }[] };
  assert.equal(first.entry[0].changes[0].value.messages.length, 1);                                                 // só a mensagem daquele evento
  assert.deepEqual(first.entry[0].changes[0].value.metadata, { phone_number_id: "PN1" });                            // mantém o envelope necessário ao normalizador
  assert.ok(ev.every((e) => e.provider === "META_WA"));
  assert.match(ev[5].key, /^wa:message_template_status_update:[0-9a-f]{32}$/);                                       // campos sem id: chave pelo conteúdo
  const again = await splitMetaPayload(structuredClone(wa));
  assert.deepEqual(again.map((e) => e.key), ev.map((e) => e.key));                                                    // determinístico: reentrega gera as mesmas chaves
});

test("Instagram: mensagem, eco, leitura, story e comentário", async () => {
  const ig = { object: "instagram", entry: [{ id: "IGBIZ", time: 1, messaging: [
    { sender: { id: "S1" }, message: { mid: "m1", text: "oi" } },
    { sender: { id: "IGBIZ" }, message: { mid: "m2", text: "resposta", is_echo: true } },
    { sender: { id: "S1" }, read: { mid: "m2" } },
    { sender: { id: "S1" }, reaction: { mid: "m1", action: "react", reaction: "love" } },
  ], changes: [{ field: "comments", value: { id: "C1", text: "quero!" } }, { field: "mentions", value: { media_id: "M9" } }] }] };
  const ev = await splitMetaPayload(ig);
  assert.deepEqual(ev.slice(0, 5).map((e) => e.key), ["m1", "m2", "read:m2", "reaction:m1:react", "comments:C1"]);
  assert.match(ev[5].key, /^ig:mentions:[0-9a-f]{32}$/);
  assert.ok(ev.every((e) => e.provider === "META_IG"));
});

test("outros objetos do Meta são ignorados", async () => {
  assert.deepEqual(await splitMetaPayload({ object: "page", entry: [{}] }), []);
  assert.deepEqual(await splitMetaPayload(null), []);
});

test("Telegram: chave por bot+update e id do bot injetado", () => {
  const e = telegramEvent({ update_id: 42, message: { message_id: 1 } }, "987654");
  assert.deepEqual(e, { provider: "TELEGRAM", key: "987654:42", payload: { update_id: 42, message: { message_id: 1 }, _bot_id: "987654" } });
  assert.equal(telegramEvent({ update_id: "x" }, "987654"), null);
  assert.equal(telegramEvent({ update_id: 1 }, "../etc"), null);                                                       // id do bot vem da URL: só dígitos
  assert.equal(verifyTelegramSecret("segredo", "segredo"), true);
  assert.equal(verifyTelegramSecret("errado", "segredo"), false);
  assert.equal(verifyTelegramSecret(null, "segredo"), false);
  assert.equal(verifyTelegramSecret("segredo", ""), false);
});
