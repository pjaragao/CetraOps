import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // XMLs de NF-e (vários por vez) chegam por Server Action
  experimental: { serverActions: { bodySizeLimit: "8mb" } },
};

export default nextConfig;
