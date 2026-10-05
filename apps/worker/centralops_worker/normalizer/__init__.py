from __future__ import annotations

from typing import Any

from .meta import normalize_instagram, normalize_whatsapp
from .telegram import normalize_telegram

PROVIDERS = {"META_WA": normalize_whatsapp, "META_IG": normalize_instagram, "TELEGRAM": normalize_telegram}


def normalize(provider: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        fn = PROVIDERS[provider]
    except KeyError as e:
        raise ValueError(f"Provedor de webhook desconhecido: {provider}") from e
    return fn(payload)
