"""Ponto de entrada: `sie-worker` (ou `python -m sie_worker`). Sobe um consumidor por fila e encerra com SIGTERM/SIGINT sem perder mensagens."""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import sys
from collections.abc import Awaitable, Callable

import httpx
from psycopg_pool import AsyncConnectionPool

from . import queues
from .ai.agent import AgentClient, FallbackAgent, HermesAgent, OpenRouterAgent
from .ai.llm import LLM
from .config import Settings, get_settings
from .db import make_pool
from .deps import Deps
from .handlers import fiscal, inbound, integrations, media, notifications, outbound, persona, router, templates
from .runner import consume_forever, drain

Handler = Callable[[Deps, queues.QueueMessage], Awaitable[None]]

HANDLERS: dict[str, Handler] = {
    "inbound_events": inbound.handle,
    "conversation_router": router.handle,
    "outbound_messages": outbound.handle,
    "media_processing": media.handle,
    "fiscal_emission": fiscal.handle,
    "notifications": notifications.handle,
    "integration_checks": integrations.handle,
    "template_tasks": templates.handle,
    "persona_tasks": persona.handle,
}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data = {"ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"), "level": record.levelname, "logger": record.name, "msg": record.getMessage()}
        if record.exc_info:
            data["exc"] = self.formatException(record.exc_info)
        return json.dumps(data, ensure_ascii=False)


def setup_logging(level: str) -> None:
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(JsonFormatter())
    logging.basicConfig(level=level, handlers=[h], force=True)


def build_agent(settings: Settings, deps_pool: AsyncConnectionPool, http: httpx.AsyncClient) -> AgentClient | None:
    """Hermes é o padrão quando configurado; o Plano B (laço de ferramentas aqui, direto no OpenRouter) cobre a falha do Hermes.
    Só com o OpenRouter configurado (sem Hermes), o Plano B é o único caminho."""
    hermes = HermesAgent(http, settings.hermes_base, settings.hermes_key) if settings.hermes_key else None
    direct = OpenRouterAgent(deps_pool, http, settings.openrouter_base, settings.openrouter_key) if settings.openrouter_key else None
    if hermes and direct:
        return FallbackAgent(hermes, direct)
    return hermes or direct


async def main_async(once: bool) -> None:
    settings = get_settings()
    setup_logging(settings.log_level)
    log = logging.getLogger("sie_worker")
    pool = make_pool(settings)
    await pool.open(wait=True)
    async with httpx.AsyncClient() as http:
        llm = LLM(pool, http, settings.openrouter_base, settings.openrouter_key) if settings.openrouter_key else None
        deps = Deps(pool=pool, settings=settings, http=http, agent=build_agent(settings, pool, http), llm=llm)
        names = settings.queues or list(HANDLERS)
        unknown = [q for q in names if q not in HANDLERS]
        if unknown:
            log.warning("filas sem handler ainda (ignoradas): %s", unknown)
            names = [q for q in names if q in HANDLERS]
        if once:
            for q in names:
                stats = await drain(pool, q, lambda m, h=HANDLERS[q]: h(deps, m), settings)
                log.info("fila %s: %s", q, stats)
        else:
            stop = asyncio.Event()
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                try:
                    loop.add_signal_handler(sig, stop.set)
                except NotImplementedError:          # Windows
                    signal.signal(sig, lambda *_: stop.set())
            log.info("worker iniciado: %s", names)
            await asyncio.gather(*(consume_forever(pool, q, lambda m, h=HANDLERS[q]: h(deps, m), settings, stop) for q in names))
            log.info("worker encerrado")
    await pool.close()


def run() -> None:
    p = argparse.ArgumentParser(prog="sie-worker")
    p.add_argument("--once", action="store_true", help="processa o que estiver na fila agora e sai")
    # psycopg assíncrono não roda no ProactorEventLoop (padrão do Windows): em desenvolvimento local usamos o seletor
    asyncio.run(main_async(p.parse_args().once), loop_factory=asyncio.SelectorEventLoop if sys.platform == "win32" else None)


if __name__ == "__main__":
    run()
