# syntax=docker/dockerfile:1.7
# Imagem do servidor MCP (ferramentas do agente). Contexto de build = RAIZ do repositório:
#   docker build -f apps/agent/mcp_server/Dockerfile -t centralops-mcp .
# Só na rede interna do Docker: o Hermes chama com `Authorization: Bearer $CENTRALOPS_MCP_KEY`; nenhuma porta é publicada.

FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS build
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /repo
COPY pyproject.toml uv.lock ./
COPY apps/agent/contract apps/agent/contract
COPY apps/agent/mcp_server apps/agent/mcp_server
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-editable --package centralops-mcp

FROM python:3.15-slim-bookworm AS runtime
ENV PATH="/repo/.venv/bin:$PATH" PYTHONUNBUFFERED=1
RUN useradd --system --uid 10001 --no-create-home app
WORKDIR /repo
COPY --from=build --chown=10001:10001 /repo/.venv /repo/.venv
USER 10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).status == 200 else 1)"
CMD ["centralops-mcp"]
