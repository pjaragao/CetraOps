// Ingresso do Telegram Bot API. URL: /functions/v1/webhooks-telegram/<bot_id> (o id do bot é o `provider_account_id` do canal).
// O `setWebhook` é feito com `secret_token`; o Telegram devolve esse segredo no cabeçalho X-Telegram-Bot-Api-Secret-Token a cada update.
// Segredo: TELEGRAM_WEBHOOK_SECRET. Sem ele a função recusa tudo.
import { ingest, json } from "../_shared/ingest.ts";
import { telegramEvent, verifyTelegramSecret } from "../_shared/webhooks.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  const secret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
  if (!secret) return json(500, { error: "webhook not configured" });
  if (!verifyTelegramSecret(req.headers.get("x-telegram-bot-api-secret-token"), secret)) return json(401, { error: "invalid secret token" });

  const botId = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  let update: unknown;
  try {
    update = await req.json();
  } catch {
    return json(400, { error: "invalid json" });
  }
  const event = telegramEvent(update, botId);
  if (!event) return json(400, { error: "invalid update or bot id" });

  try {
    return json(200, await ingest([event]));
  } catch (e) {
    console.error(JSON.stringify({ fn: "webhooks-telegram", error: String((e as Error).message) }));
    return json(500, { error: "temporary failure" });                              // o Telegram reenvia o mesmo update_id; a gravação é idempotente
  }
});
