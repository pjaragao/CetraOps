"""Webhooks da Meta (WhatsApp Cloud API e Instagram) → eventos normalizados para `omni.ingest_event`."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

WA_TYPES = {
    "text": "TEXT", "image": "IMAGE", "audio": "AUDIO", "video": "VIDEO", "document": "DOCUMENT", "sticker": "STICKER",
    "location": "LOCATION", "interactive": "INTERACTIVE", "button": "INTERACTIVE", "reaction": "REACTION",
}
WA_STATUS = {"sent": "SENT", "delivered": "DELIVERED", "read": "READ", "failed": "FAILED"}
PLACEHOLDER = {"IMAGE": "[imagem]", "AUDIO": "[áudio]", "VIDEO": "[vídeo]", "DOCUMENT": "[documento]", "STICKER": "[figurinha]", "LOCATION": "[localização]"}


def _iso(ts: Any, millis: bool = False) -> str | None:
    if ts in (None, ""):
        return None
    value = float(ts) / (1000 if millis else 1)
    return datetime.fromtimestamp(value, tz=UTC).isoformat()


def _wa_message(m: dict[str, Any], phone_number_id: str, names: dict[str, str], echo: bool = False) -> dict[str, Any]:
    kind = WA_TYPES.get(m.get("type", "text"), "TEXT")
    body: str | None = None
    payload: dict[str, Any] = {"raw_type": m.get("type")}
    t = m.get("type")
    if t == "text":
        body = m["text"]["body"]
    elif t in ("image", "video", "document", "audio", "sticker"):
        media = m.get(t, {})
        body = media.get("caption") or (media.get("filename") if t == "document" else None)
        payload["media"] = {"id": media.get("id"), "mime_type": media.get("mime_type"), "voice": media.get("voice")}
    elif t == "location":
        loc = m["location"]
        body = loc.get("name") or loc.get("address")
        payload["location"] = {"lat": loc.get("latitude"), "lng": loc.get("longitude")}
    elif t == "interactive":
        reply = m["interactive"].get("button_reply") or m["interactive"].get("list_reply") or {}
        body = reply.get("title")
        payload["reply_id"] = reply.get("id")
    elif t == "button":
        body = m["button"].get("text")
        payload["reply_id"] = m["button"].get("payload")
    elif t == "reaction":
        body = m["reaction"].get("emoji")
        payload["reacted_to"] = m["reaction"].get("message_id")
    if body is None:
        body = PLACEHOLDER.get(kind)
    if m.get("context"):
        payload["reply_to"] = m["context"].get("id")

    customer = m["to"] if echo else m["from"]
    event: dict[str, Any] = {
        "kind": "ECHO" if echo else "MESSAGE", "channel": "WHATSAPP", "provider_account_id": phone_number_id,
        "external_id": customer, "phone": customer, "display_name": names.get(customer),
        "provider_message_id": m["id"], "type": kind, "body": body, "payload": payload, "occurred_at": _iso(m.get("timestamp")),
    }
    if m.get("referral"):          # Click-to-WhatsApp: origem do anúncio para atribuição/CAPI
        ref = m["referral"]
        event["referral"] = {k: ref.get(k) for k in ("source_url", "source_type", "source_id", "headline", "ctwa_clid") if ref.get(k)}
    return event


def _wa_status(s: dict[str, Any], phone_number_id: str) -> dict[str, Any]:
    status = WA_STATUS.get(s.get("status", ""))
    err = (s.get("errors") or [{}])[0]
    return {
        "kind": "STATUS", "channel": "WHATSAPP", "provider_account_id": phone_number_id, "provider_message_id": s["id"], "status": status,
        "error": f'{err.get("code")}: {err.get("title") or err.get("message")}' if status == "FAILED" else None, "occurred_at": _iso(s.get("timestamp")),
    }


def _wa_template(field: str, v: dict[str, Any], waba_id: str) -> dict[str, Any] | None:
    """Situação/qualidade de template (não trazem phone_number_id: a conta é identificada pelo WABA, o `entry.id`)."""
    base = {"kind": "TEMPLATE", "waba_id": waba_id, "external_id": str(v["message_template_id"]) if v.get("message_template_id") is not None else None,
            "name": v.get("message_template_name"), "language": v.get("message_template_language"), "status": None, "reason": None, "quality": None}
    if field == "message_template_status_update":
        reason = v.get("reason")
        return {**base, "status": str(v.get("event", "")).upper() or None, "reason": None if not reason or str(reason).upper() == "NONE" else str(reason)}
    if field == "message_template_quality_update":
        return {**base, "quality": str(v.get("new_quality_score", "")).upper() or None}
    return None


def normalize_whatsapp(payload: dict[str, Any]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            if change.get("field") in ("message_template_status_update", "message_template_quality_update"):
                ev = _wa_template(change["field"], value, str(entry.get("id") or ""))
                if ev and (ev["status"] or ev["quality"]):
                    events.append(ev)
                continue
            pnid = (value.get("metadata") or {}).get("phone_number_id")
            if not pnid:
                continue
            names = {c.get("wa_id"): (c.get("profile") or {}).get("name") for c in value.get("contacts", [])}
            for m in value.get("messages", []):
                events.append(_wa_message(m, pnid, names))
            for m in value.get("message_echoes", []):        # coexistência: resposta enviada pelo app do celular
                events.append(_wa_message(m, pnid, names, echo=True))
            for s in value.get("statuses", []):
                ev = _wa_status(s, pnid)
                if ev["status"]:
                    events.append(ev)
    return events


def normalize_instagram(payload: dict[str, Any]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for entry in payload.get("entry", []):
        account = str(entry.get("id"))
        for item in entry.get("messaging", []):
            sender, recipient = str((item.get("sender") or {}).get("id")), str((item.get("recipient") or {}).get("id"))
            when = _iso(item.get("timestamp"), millis=True)
            if "read" in item:
                events.append({"kind": "STATUS", "channel": "INSTAGRAM", "provider_account_id": account, "provider_message_id": item["read"].get("mid"), "status": "READ", "occurred_at": when})
                continue
            msg = item.get("message")
            if not msg or msg.get("is_deleted"):
                continue
            echo = bool(msg.get("is_echo"))
            kind, body, extra = "TEXT", msg.get("text"), {"raw_type": "message"}
            reply_to = msg.get("reply_to") or {}
            if "story" in reply_to:
                kind, extra["story"] = "STORY_REPLY", reply_to["story"]
            for att in msg.get("attachments", []) or []:
                atype = att.get("type")
                if atype == "story_mention":
                    kind = "STORY_MENTION"
                elif atype in ("image", "video", "audio", "file"):
                    kind = {"image": "IMAGE", "video": "VIDEO", "audio": "AUDIO", "file": "DOCUMENT"}[atype] if kind == "TEXT" else kind
                    extra.setdefault("media", []).append({"type": atype, "url": (att.get("payload") or {}).get("url")})
            if body is None:
                body = PLACEHOLDER.get(kind) or ("[menção no story]" if kind == "STORY_MENTION" else None)
            events.append({
                "kind": "ECHO" if echo else "MESSAGE", "channel": "INSTAGRAM", "provider_account_id": account,
                "external_id": recipient if echo else sender, "provider_message_id": msg["mid"], "type": kind, "body": body, "payload": extra, "occurred_at": when,
            })
        for change in entry.get("changes", []):       # comentários em publicações
            if change.get("field") != "comments":
                continue
            v = change.get("value", {})
            author = v.get("from") or {}
            if str(author.get("id")) == account:
                continue
            events.append({
                "kind": "MESSAGE", "channel": "INSTAGRAM", "provider_account_id": account, "external_id": str(author.get("id")), "handle": author.get("username"),
                "provider_message_id": f'comment:{v.get("id")}', "type": "COMMENT", "body": v.get("text"),
                "payload": {"raw_type": "comment", "comment_id": v.get("id"), "media_id": (v.get("media") or {}).get("id")}, "occurred_at": _iso(entry.get("time")),
            })
    return events
