"""Updates do Telegram Bot API → eventos normalizados. O id do bot vem no envelope (`_bot_id`), preenchido pela Edge Function."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def normalize_telegram(update: dict[str, Any]) -> list[dict[str, Any]]:
    msg = update.get("message") or update.get("edited_message")
    if not msg:
        return []
    bot = str(update.get("_bot_id", ""))
    if not bot:
        raise ValueError("update do Telegram sem _bot_id (a Edge Function precisa informar o bot do webhook)")
    chat, sender = msg.get("chat", {}), msg.get("from", {})
    if chat.get("type") != "private" or sender.get("is_bot"):
        return []
    body = msg.get("text") or msg.get("caption")
    kind = "TEXT"
    for field, k in (("photo", "IMAGE"), ("voice", "AUDIO"), ("audio", "AUDIO"), ("video", "VIDEO"), ("document", "DOCUMENT"), ("sticker", "STICKER"), ("location", "LOCATION")):
        if field in msg:
            kind = k
            body = body or f"[{k.lower()}]"
            break
    name = " ".join(x for x in (sender.get("first_name"), sender.get("last_name")) if x) or sender.get("username")
    payload: dict[str, Any] = {"raw_type": "message"}
    if body and body.startswith("/start"):
        payload["start_param"] = body.partition(" ")[2].strip() or None          # deep link t.me/<bot>?start=<token>
    return [{
        "kind": "MESSAGE", "channel": "TELEGRAM", "provider_account_id": bot, "external_id": str(chat["id"]), "handle": sender.get("username"),
        "display_name": name, "provider_message_id": f'{chat["id"]}:{msg["message_id"]}', "type": kind, "body": body, "payload": payload,
        "occurred_at": datetime.fromtimestamp(msg["date"], tz=UTC).isoformat() if msg.get("date") else None,
    }]
