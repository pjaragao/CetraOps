import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // XMLs de NF-e (vários por vez) chegam por Server Action
  experimental: { serverActions: { bodySizeLimit: "8mb" } },
  // Imagem Docker (NEXT_OUTPUT=standalone): servidor mínimo em .next/standalone, com o rastreio de arquivos a partir da raiz do monorepo (packages/*)
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const, outputFileTracingRoot: path.resolve(process.cwd(), "../..") } : {}),
};

export default nextConfig;
