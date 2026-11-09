# syntax=docker/dockerfile:1.7
# Imagem do worker (filas pgmq, integrações e IA). Contexto de build = RAIZ do repositório:
#   docker build -f apps/worker/Dockerfile -t centralops-worker .

FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS build
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /repo
COPY pyproject.toml uv.lock ./
COPY apps/agent/contract apps/agent/contract
COPY apps/worker apps/worker
# --no-editable: os pacotes do workspace são instalados no venv (nada aponta para o código-fonte)
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-editable --package centralops-worker

FROM python:3.15-slim-bookworm AS runtime
ENV PATH="/repo/.venv/bin:$PATH" PYTHONUNBUFFERED=1
RUN useradd --system --uid 10001 --no-create-home app
WORKDIR /repo
COPY --from=build --chown=10001:10001 /repo/.venv /repo/.venv
# migrations e seeds de configuração: o mesmo container roda `centralops-migrate` antes de cada deploy (serviço migrate do compose)
COPY --chown=10001:10001 supabase/migrations /repo/supabase/migrations
COPY --chown=10001:10001 supabase/seed /repo/supabase/seed
USER 10001
# sem porta: o worker só consome filas (pgmq) e fala com Meta, Telegram, Focus NFe, OpenRouter/Hermes e o banco
CMD ["centralops-worker"]
