"""Linha de comando: `uv run --package sie-worker python -m sie_worker.evals --models modelo1,modelo2`.
Roda os casos ativos da organização em cada modelo, grava os lotes (aparecem em Inteligência › Avaliações) e imprime o ranking."""
from __future__ import annotations

import argparse
import asyncio
import sys

import httpx

from ..config import get_settings
from ..db import fetch_all, fetch_one, make_pool
from .runner import run_suite


async def main_async(args: argparse.Namespace) -> int:
    settings = get_settings()
    pool = make_pool(settings)
    await pool.open(wait=True)
    try:
        org = args.org or (await fetch_one(pool, "select id from core.orgs order by created_at limit 1"))["id"]  # type: ignore[index]
        models = [m.strip() for m in args.models.split(",") if m.strip()]
        async with httpx.AsyncClient() as http:
            async def progress(text: str) -> None:
                print(f"  {text}", flush=True)
            batches = await run_suite(settings, http, pool, str(org), models, suite=args.suite, persona_id=args.persona, progress=progress)
        rows = await fetch_all(pool, """select model, cases, passed, factual_failures, handoff_misses, p95_latency_ms, round(cost_usd / greatest(cases, 1), 5) as cost_per_case
                                        from ai.eval_batches where id = any(%s::uuid[]) order by passed desc, factual_failures, cost_usd""", (batches,))
        print(f"\n{'modelo':44} {'passou':>8} {'sem fundamento':>15} {'handoff':>8} {'p95 ms':>8} {'US$/caso':>9}")
        for r in rows:
            print(f"{r['model']:44} {r['passed']:>3}/{r['cases']:<4} {r['factual_failures']:>15} {r['handoff_misses']:>8} {r['p95_latency_ms'] or 0:>8} {r['cost_per_case']:>9}")
        return 0
    finally:
        await pool.close()


def main() -> None:
    p = argparse.ArgumentParser(prog="sie_worker.evals")
    p.add_argument("--models", required=True, help="slugs do OpenRouter separados por vírgula (1 a 4)")
    p.add_argument("--suite", default="conversation")
    p.add_argument("--org", default=None, help="id da organização (padrão: a primeira)")
    p.add_argument("--persona", default=None, help="id da persona a usar (padrão: a da conta de WhatsApp)")
    code = asyncio.run(main_async(p.parse_args()), loop_factory=asyncio.SelectorEventLoop if sys.platform == "win32" else None)
    sys.exit(code)


if __name__ == "__main__":
    main()
