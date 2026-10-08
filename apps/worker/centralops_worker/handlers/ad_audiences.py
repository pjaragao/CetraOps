"""Públicos da Meta (fila `campaign_tasks`, ações AUDIENCE_SYNC, LOOKALIKE_CREATE e AUDIENCE_DELETE).
O banco decide quem pode subir (consentimento de anúncios, telefone ou e-mail, fora do grupo de controle); aqui só se faz o hash e a chamada à Meta.
Contato em claro nunca é enviado nem registrado."""
from __future__ import annotations

import logging
from typing import Any

from ..adapters.errors import PermanentError as ProviderPermanent
from ..adapters.errors import TransientError
from ..adapters.meta import MetaClient
from ..db import call_fn, fetch_one
from ..deps import Deps
from ..runner import RetryLater

log = logging.getLogger("centralops_worker.ad_audiences")
MIN_LOOKALIKE_SOURCE = 100


async def _client(deps: Deps, org_id: str) -> tuple[MetaClient, str] | None:
    conn = await fetch_one(deps.pool, "select id, config from core.integration_connections where org_id = %s and provider = 'META_ADS' and status <> 'DISABLED' and secret_ref is not null order by created_at limit 1", (org_id,))
    if conn is None:
        return None
    token = (await deps.secret(str(conn["id"]))).get("token")
    account = str((conn["config"] or {}).get("ad_account_id") or "").strip()
    if not token or not account:
        return None
    return MetaClient(deps.http, deps.settings.graph_api_base, str(token)), (account if account.startswith("act_") else f"act_{account}")


async def _fail(deps: Deps, org_id: str, audience_id: str, name: str, why: str) -> None:
    await call_fn(deps.pool, "mkt.ad_audience_set", audience_id, "ERROR", None, None, None, None, why[:300])
    await deps.notify(org_id, "INTEGRATION_ERROR", f"Público da Meta «{name}» não foi enviado: {why[:200]}", {"audience_id": audience_id}, perm="core.admin")


async def sync(deps: Deps, org_id: str, audience_id: str) -> None:
    aud = await fetch_one(deps.pool, "select id, name, meta_audience_id, kind from mkt.ad_audiences where id = %s and org_id = %s", (audience_id, org_id))
    if aud is None or aud["kind"] != "CUSTOM":
        return                                                       # excluído enquanto esperava na fila
    cl = await _client(deps, org_id)
    if cl is None:
        await _fail(deps, org_id, audience_id, aud["name"], "A Meta (Anúncios) não está conectada ou falta o código da conta de anúncios")
        return
    client, account = cl
    await call_fn(deps.pool, "mkt.ad_audience_set", audience_id, "SYNCING", None, None, None, account, None)
    contacts: list[dict[str, Any]] = await call_fn(deps.pool, "mkt.audience_upload_rows", audience_id) or []
    if not contacts:
        await _fail(deps, org_id, audience_id, aud["name"], "Ninguém do público aceitou receber anúncios (consentimento) ou tem telefone/e-mail")
        return
    try:
        meta_id = aud["meta_audience_id"] or await client.create_custom_audience(account, str(aud["name"]), "Criado pelo CentralOps")
        await call_fn(deps.pool, "mkt.ad_audience_set", audience_id, "SYNCING", meta_id, None, None, account, None)   # guarda o id já: se o envio falhar, a próxima rodada reaproveita
        sent = await client.replace_audience_users(meta_id, contacts)
        info = await client.audience_info(meta_id)
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 120), str(e)) from e
    except ProviderPermanent as e:
        await _fail(deps, org_id, audience_id, aud["name"], str(e))
        return
    matched = info.get("approximate_count_lower_bound")
    await call_fn(deps.pool, "mkt.ad_audience_set", audience_id, "READY", meta_id, sent, int(matched) if isinstance(matched, int) and matched > 0 else None, account, None)


async def lookalike(deps: Deps, org_id: str, audience_id: str) -> None:
    aud = await fetch_one(deps.pool, """select a.id, a.name, a.lookalike_ratio, s.meta_audience_id as origin from mkt.ad_audiences a join mkt.ad_audiences s on s.id = a.source_audience_id
                                         where a.id = %s and a.org_id = %s and a.kind = 'LOOKALIKE'""", (audience_id, org_id))
    if aud is None:
        return
    cl = await _client(deps, org_id)
    if cl is None or not aud["origin"]:
        await _fail(deps, org_id, audience_id, aud["name"], "A Meta não está conectada ou o público de origem ainda não existe")
        return
    client, account = cl
    await call_fn(deps.pool, "mkt.ad_audience_set", audience_id, "SYNCING", None, None, None, account, None)
    try:
        meta_id = await client.create_lookalike(account, str(aud["name"]), str(aud["origin"]), float(aud["lookalike_ratio"]))
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 120), str(e)) from e
    except ProviderPermanent as e:
        await _fail(deps, org_id, audience_id, aud["name"], str(e))
        return
    await call_fn(deps.pool, "mkt.ad_audience_set", audience_id, "READY", meta_id, None, None, account, None)


async def delete(deps: Deps, org_id: str, meta_audience_id: str) -> None:
    cl = await _client(deps, org_id)
    if cl is None:
        return
    try:
        await cl[0].delete_audience(meta_audience_id)
    except TransientError as e:
        raise RetryLater(int(e.retry_after or 120), str(e)) from e
    except ProviderPermanent as e:
        log.warning("público %s não pôde ser apagado na Meta: %s", meta_audience_id, e)      # já não existe ou sem permissão: segue
