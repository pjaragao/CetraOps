"""Fila `template_tasks`: envia template para aprovação da Meta (SUBMIT) e sincroniza os que já existem lá (SYNC).
A situação final (aprovado/rejeitado) chega depois pelo webhook `message_template_status_update` (ver handlers/inbound) ou pela próxima sincronização."""
from __future__ import annotations

import logging
from typing import Any

from .. import queues
from ..adapters.errors import PermanentError as ProviderPermanent
from ..adapters.errors import TransientError
from ..adapters.meta import MetaClient
from ..db import call_fn, fetch_one
from ..deps import Deps
from ..runner import RetryLater

log = logging.getLogger("sie_worker.templates")


async def _credentials(deps: Deps, account_id: Any) -> tuple[str, str] | str:
    """(token, waba_id) da conta, ou o motivo de não ser possível."""
    row = await fetch_one(deps.pool, """select ca.connection_id, ic.config from omni.channel_accounts ca left join core.integration_connections ic on ic.id = ca.connection_id where ca.id = %s""", (account_id,))
    if not row or not row["connection_id"]:
        return "O canal não tem conexão (credencial) configurada em Configurações › Integrações"
    token = (await deps.secret(str(row["connection_id"]))).get("token") or ""
    waba = str((row["config"] or {}).get("waba_id") or "").strip()
    if not token:
        return "A conexão do WhatsApp não tem credencial no cofre"
    if not waba:
        return "Informe o ID da conta do WhatsApp Business (WABA) na conexão: é por ele que a Meta recebe os templates"
    return token, waba


async def _submit(deps: Deps, p: dict[str, Any]) -> None:
    t = await fetch_one(deps.pool, "select id, org_id, channel_account_id, name, language, category, components, status, external_id from omni.templates where id = %s", (p["template_id"],))
    if t is None or t["status"] != "PENDING" or t["external_id"]:
        return                                                      # reentrega: já enviado, editado ou removido
    cred = await _credentials(deps, t["channel_account_id"])
    if isinstance(cred, str):
        await call_fn(deps.pool, "omni.fail_template_submission", t["id"], cred)
        return
    token, waba = cred
    try:
        resp = await MetaClient(deps.http, deps.settings.graph_api_base, token).create_template(waba, t["name"], t["language"], t["category"], t["components"])
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 30), str(e)) from e
    except ProviderPermanent as e:                                  # a Meta recusou na hora (nome repetido, texto fora da política…)
        await call_fn(deps.pool, "omni.record_template_status", {"template_id": t["id"], "status": "REJECTED", "reason": str(e)})
        return
    await call_fn(deps.pool, "omni.record_template_status", {"template_id": t["id"], "status": resp.get("status") or "PENDING", "external_id": str(resp.get("id") or "") or None})


async def _sync(deps: Deps, p: dict[str, Any]) -> None:
    cred = await _credentials(deps, p["channel_account_id"])
    if isinstance(cred, str):
        await deps.notify(p["org_id"], "INTEGRATION_ERROR", f"Sincronização de templates parada: {cred}", {"channel_account_id": p["channel_account_id"]}, perm="omni.write")
        return
    token, waba = cred
    try:
        remote = await MetaClient(deps.http, deps.settings.graph_api_base, token).list_templates(waba)
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 30), str(e)) from e
    except ProviderPermanent as e:
        await deps.notify(p["org_id"], "INTEGRATION_ERROR", f"Sincronização de templates recusada pela Meta: {e}", {"channel_account_id": p["channel_account_id"]}, perm="omni.write")
        return
    for r in remote:
        await call_fn(deps.pool, "omni.upsert_remote_template", {
            "channel_account_id": p["channel_account_id"], "external_id": str(r.get("id") or ""), "name": r.get("name"), "language": r.get("language"), "category": r.get("category"),
            "components": r.get("components") or [], "status": r.get("status"), "quality": (r.get("quality_score") or {}).get("score"), "rejected_reason": r.get("rejected_reason"),
        })


async def handle(deps: Deps, msg: queues.QueueMessage) -> None:
    action = msg.payload.get("action")
    if action == "SUBMIT":
        await _submit(deps, msg.payload)
    elif action == "SYNC":
        await _sync(deps, msg.payload)
    else:
        log.warning("ação de template desconhecida: %s", action)
