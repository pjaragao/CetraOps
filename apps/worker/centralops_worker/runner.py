"""Consumidor genérico de fila: lê em lote, processa com concorrência limitada, apaga em caso de sucesso,
deixa reaparecer (com recuo) em caso de erro transitório e manda para a DLQ depois de N tentativas."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

from psycopg_pool import AsyncConnectionPool

from . import queues
from .config import Settings

log = logging.getLogger("centralops_worker.runner")

Handler = Callable[[queues.QueueMessage], Awaitable[None]]


class PermanentError(Exception):
    """Erro que não adianta repetir (dado inválido, regra violada): vai direto para a DLQ."""


class RetryLater(Exception):
    """Pede nova tentativa depois de `delay_s` (ex.: emissão fiscal ainda em processamento) sem contar como falha."""

    def __init__(self, delay_s: int, reason: str = "") -> None:
        super().__init__(reason or f"tentar de novo em {delay_s}s")
        self.delay_s = delay_s


def backoff_s(read_ct: int) -> int:
    """5s, 15s, 45s, 2min, 5min (limitado)."""
    return min(5 * 3 ** max(read_ct - 1, 0), 300)


async def process_one(pool: AsyncConnectionPool, msg: queues.QueueMessage, handler: Handler, settings: Settings) -> str:
    """Devolve 'ok' | 'retry' | 'dlq'."""
    try:
        await handler(msg)
    except RetryLater as e:
        await queues.set_visibility(pool, msg.queue, msg.msg_id, e.delay_s)
        return "retry"
    except PermanentError as e:
        log.warning("erro permanente na fila %s msg=%s: %s", msg.queue, msg.msg_id, e)
        await queues.to_dlq(pool, msg, str(e))
        return "dlq"
    except Exception as e:
        if msg.read_ct >= settings.max_attempts:
            log.error("fila %s msg=%s esgotou %s tentativas: %s", msg.queue, msg.msg_id, msg.read_ct, e)
            await queues.to_dlq(pool, msg, f"{type(e).__name__}: {e}")
            return "dlq"
        delay = backoff_s(msg.read_ct)
        log.warning("fila %s msg=%s falhou (tentativa %s), nova em %ss: %s", msg.queue, msg.msg_id, msg.read_ct, delay, e)
        await queues.set_visibility(pool, msg.queue, msg.msg_id, delay)
        return "retry"
    await queues.delete(pool, msg.queue, msg.msg_id)
    return "ok"


async def drain(pool: AsyncConnectionPool, queue: str, handler: Handler, settings: Settings, max_batches: int = 50) -> dict[str, int]:
    """Processa o que estiver visível agora (usado em testes e no modo `--once`)."""
    stats = {"ok": 0, "retry": 0, "dlq": 0}
    sem = asyncio.Semaphore(settings.concurrency)

    async def run(m: queues.QueueMessage) -> None:
        async with sem:
            stats[await process_one(pool, m, handler, settings)] += 1

    for _ in range(max_batches):
        batch = await queues.read(pool, queue, settings.visibility_timeout_s, settings.batch_size)
        if not batch:
            break
        await asyncio.gather(*(run(m) for m in batch))
    return stats


async def consume_forever(pool: AsyncConnectionPool, queue: str, handler: Handler, settings: Settings, stop: asyncio.Event) -> None:
    sem = asyncio.Semaphore(settings.concurrency)
    tasks: set[asyncio.Task[None]] = set()

    async def run(m: queues.QueueMessage) -> None:
        async with sem:
            await process_one(pool, m, handler, settings)

    while not stop.is_set():
        try:
            batch = await queues.read(pool, queue, settings.visibility_timeout_s, settings.batch_size)
        except Exception as e:
            log.error("falha ao ler a fila %s: %s", queue, e)
            await asyncio.sleep(5)
            continue
        for m in batch:
            t = asyncio.create_task(run(m))
            tasks.add(t)
            t.add_done_callback(tasks.discard)
        if not batch:
            try:
                await asyncio.wait_for(stop.wait(), timeout=settings.poll_interval_s)
            except TimeoutError:
                pass
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
