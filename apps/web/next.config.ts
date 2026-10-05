import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NEXT_DIST_DIR permite rodar a build de produção sem apagar a pasta do servidor de desenvolvimento
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // XMLs de NF-e (vários por vez) e históricos de conversa da persona (até 24 MB) chegam por Server Action
  // cpus: 2 limita workers de compilação em máquinas com muitos núcleos (ex: 20 cores) evitando estourar a RAM
  experimental: {
    cpus: 2,
    serverActions: { bodySizeLimit: "25mb" },
  },
  // Imagem Docker (NEXT_OUTPUT=standalone): servidor mínimo em .next/standalone, com o rastreio de arquivos a partir da raiz do monorepo (packages/*)
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const, outputFileTracingRoot: path.resolve(process.cwd(), "../..") } : {}),
};

export default nextConfig;
