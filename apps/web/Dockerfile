# syntax=docker/dockerfile:1.7
# Imagem do app web (Next.js standalone). Contexto de build = RAIZ do repositório:
#   docker build -f apps/web/Dockerfile -t centralops-web \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<projeto>.supabase.co --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key> .
# As variáveis NEXT_PUBLIC_* são embutidas no bundle em tempo de build (a chave anon é pública por desenho; a service role NUNCA entra aqui).

FROM node:25-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# 1) dependências (camada em cache enquanto os package.json e o lockfile não mudam)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --filter @centralops/web...

# 2) build
FROM deps AS build
COPY apps/web apps/web
COPY packages packages
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_OUTPUT=standalone
ENV NODE_OPTIONS="--max-old-space-size=2048" NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @centralops/web build

# 3) execução: só o servidor standalone, sem root e com o sistema de arquivos pronto para somente-leitura
FROM node:25-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN useradd --system --uid 10001 --no-create-home app
COPY --from=build --chown=10001:10001 /repo/apps/web/.next/standalone ./
COPY --from=build --chown=10001:10001 /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=10001:10001 /repo/apps/web/public ./apps/web/public
USER 10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
