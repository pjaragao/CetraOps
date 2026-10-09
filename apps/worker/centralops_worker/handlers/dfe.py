"""NF-e recebidas (MDe) pelo Focus NFe: varredura periódica das notas emitidas contra o CNPJ, manifestação do destinatário pedida por uma
pessoa e download do XML quando a SEFAZ libera. Nada é manifestado sozinho (tem efeito legal)."""
from __future__ import annotations

import logging
from typing import Any

from ..adapters.brasilnfe import BrasilNfeClient
from ..adapters.errors import PermanentError as ProviderPermanent
from ..adapters.errors import TransientError
from ..adapters.focus import FocusClient
from ..db import call_fn, fetch_all, fetch_one
from ..deps import Deps
from ..runner import RetryLater

log = logging.getLogger("centralops_worker.dfe")
MAX_PAGES = 5                       # por CNPJ e por varredura; o resto fica para a próxima (a "versão" guarda o ponto)


async def sync(deps: Deps, client: FocusClient | BrasilNfeClient, org_id: str) -> None:
    entities = await fetch_all(deps.pool, "select id, cnpj from core.legal_entities where org_id = %s order by cnpj", (org_id,))
    for ent in entities:
        state = await fetch_one(deps.pool, "select last_version from fiscal.dfe_sync_state where legal_entity_id = %s", (ent["id"],))
        version = int(state["last_version"]) if state else 0
        found = 0
        try:
            for _ in range(MAX_PAGES):
                notes = await client.list_received(ent["cnpj"], version)
                if not notes:
                    break
                found += await call_fn(deps.pool, "fiscal.dfe_upsert", org_id, ent["id"], notes)
                top = max((int(n["nsu"]) for n in notes if n.get("nsu") and str(n["nsu"]).isdigit()), default=version)
                if top <= version:
                    break
                version = top
            await call_fn(deps.pool, "fiscal.dfe_set_state", org_id, ent["id"], version, found, None)
        except TransientError as e:
            raise RetryLater(int(e.retry_after or 60), str(e)) from e
        except ProviderPermanent as e:
            await call_fn(deps.pool, "fiscal.dfe_set_state", org_id, ent["id"], version, found, str(e)[:300])
            await deps.notify(org_id, "INTEGRATION_ERROR", f"Busca de notas recebidas parou: {e}", {"legal_entity_id": str(ent["id"])}, perm="fiscal.write")


async def manifest(deps: Deps, client: FocusClient | BrasilNfeClient, p: dict[str, Any]) -> None:
    d = await fetch_one(deps.pool, "select id, access_key, manifest_status, manifest_requested, manifest_reason from fiscal.inbound_dfe where id = %s and org_id = %s", (p["dfe_id"], p["org_id"]))
    if d is None or not d["manifest_requested"] or d["manifest_status"] == d["manifest_requested"]:
        return                                                      # reentrega da fila ou pedido já atendido
    kind = d["manifest_requested"]
    try:
        await client.manifest(str(d["access_key"]), kind, d["manifest_reason"])
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 30), str(e)) from e
    except ProviderPermanent as e:
        await call_fn(deps.pool, "fiscal.dfe_mark", d["id"], None, str(e)[:300], None)
        return
    xml = None
    if kind in ("CIENCIA", "CONFIRMADA"):
        try:
            xml = await client.received_xml(str(d["access_key"]))
        except (TransientError, ProviderPermanent) as e:
            log.info("XML ainda indisponível para %s: %s", d["access_key"], e)          # a SEFAZ pode levar alguns minutos para liberar
    await call_fn(deps.pool, "fiscal.dfe_mark", d["id"], kind, None, xml)
