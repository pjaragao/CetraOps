"""Links de foto dentro do texto → fotos de verdade no WhatsApp.

A IA (e a equipe) escrevem "Bermuda Stefan: https://cdn.shopify.com/....jpg". No WhatsApp isso chegava como link. Aqui o texto é
quebrado em partes: textos soltos e fotos (com legenda = o que vinha antes do link na mesma linha). O envio converte formatos que o
WhatsApp não aceita como foto (webp, gif…) em JPEG."""
from __future__ import annotations

import io
import re
from dataclasses import dataclass
from urllib.parse import urlparse

_URL = re.compile(r"https?://[^\s<>\"')\]]+")
_IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".heic")
_STORAGE_PATH = "/storage/v1/object/public/catalog-media/"
MAX_IMAGES = 6                         # mais que isso vira spam; o resto segue como link no texto
WHATSAPP_IMAGE_MIMES = ("image/jpeg", "image/png")
MAX_IMAGE_BYTES = 5 * 1024 * 1024      # limite da Cloud API para imagem


@dataclass(frozen=True)
class Part:
    kind: str                          # "text" | "image"
    text: str = ""                     # texto, ou legenda da foto
    url: str = ""


def is_image_url(url: str) -> bool:
    u = urlparse(url.rstrip(".,;:!?"))
    path = u.path.lower()
    return path.endswith(_IMAGE_EXT) or _STORAGE_PATH in path


def _caption(fragment: str) -> str:
    """'… e Nico (Preta):' → 'Nico (Preta)'."""
    c = fragment.strip().rstrip(":-–—").strip()
    c = re.sub(r"^(?:e|ou|,|;|\.)\s+", "", c, flags=re.IGNORECASE).strip()
    return c[:1024]


def split(body: str, max_images: int = MAX_IMAGES) -> list[Part]:
    """Quebra o texto em partes na ordem em que devem sair. Sem link de foto, devolve uma única parte de texto (igual ao original)."""
    images = [m for m in _URL.finditer(body or "") if is_image_url(m.group(0))]
    if not images:
        return [Part("text", body)]
    parts: list[Part] = []
    buf: list[str] = []
    sent = 0

    def flush() -> None:
        text = "\n".join(buf).strip()
        buf.clear()
        text = re.sub(r"\n{3,}", "\n\n", text)
        if text:
            parts.append(Part("text", text))

    for line in body.split("\n"):
        urls = [m for m in _URL.finditer(line) if is_image_url(m.group(0))]
        if not urls or sent >= max_images:
            buf.append(line)
            continue
        flush()
        pos = 0
        for m in urls:
            if sent >= max_images:
                break
            url = m.group(0).rstrip(".,;:!?")
            parts.append(Part("image", _caption(line[pos:m.start()]), url))
            sent += 1
            pos = m.start() + len(url)
        rest = line[pos:].strip()
        rest = re.sub(r"^[.,;:!?\s]+", "", rest)
        if rest:
            buf.append(rest)
    flush()
    return parts


def to_whatsapp_image(data: bytes, mime: str) -> tuple[bytes, str]:
    """Devolve (bytes, mime) aceitos pelo WhatsApp como foto: JPEG/PNG até 5 MB. Converte webp/gif/avif e reduz fotos grandes."""
    mime = (mime or "").split(";")[0].strip().lower()
    if mime in WHATSAPP_IMAGE_MIMES and len(data) <= MAX_IMAGE_BYTES:
        return data, mime
    from PIL import Image  # import tardio: só quem envia foto paga o custo

    img = Image.open(io.BytesIO(data))
    img.seek(0)                                    # gif/webp animado: primeiro quadro
    if img.mode not in ("RGB", "L"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        rgba = img.convert("RGBA")
        bg.paste(rgba, mask=rgba.split()[-1])
        img = bg
    img.thumbnail((2048, 2048))
    for quality in (88, 80, 70, 60):
        out = io.BytesIO()
        img.convert("RGB").save(out, "JPEG", quality=quality, optimize=True)
        if out.tell() <= MAX_IMAGE_BYTES:
            return out.getvalue(), "image/jpeg"
    return out.getvalue(), "image/jpeg"
