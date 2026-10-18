import { createHash } from "node:crypto";
import { loadPosCatalog } from "@/lib/pos-catalog";
import { operatorFromRequest, posRoute, requirePosPerm } from "@/lib/pos-api";

/** Catálogo vendável da loja da maquininha (o app guarda e busca por código de barras/SKU/referência sem rede). ETag evita baixar de novo. */
export const GET = posRoute(async (request) => {
  const op = await operatorFromRequest(request);
  requirePosPerm(op, "sales.write");
  const products = await loadPosCatalog(op.supabase, op.device.storeId);
  const body = JSON.stringify({ products, generatedAt: new Date().toISOString() });
  const etag = `"${createHash("sha1").update(JSON.stringify(products)).digest("hex")}"`;
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return new Response(body, { headers: { "Content-Type": "application/json", ETag: etag } });
});
