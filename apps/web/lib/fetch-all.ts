import "server-only";

/**
 * Lê todas as linhas de uma consulta em páginas de 1.000. O Supabase Cloud devolve no máximo 1.000 linhas por consulta (Max Rows):
 * listas que precisam estar completas (catálogo do PDV, matriz de estoque) usam isto em vez de uma consulta só.
 * `make(from, to)` monta a consulta com `.range(from, to)` (e uma ordenação estável).
 */
export async function fetchAll<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, cap = 20_000): Promise<T[]> {
  const size = 1000;
  const out: T[] = [];
  for (let from = 0; from < cap; from += size) {
    const { data, error } = await make(from, from + size - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < size) break;
  }
  return out;
}

/**
 * Listas grandes de ids em `.in(...)` vão em lotes: o endereço da consulta cresce ~37 bytes por id e, acima de ~50, o proxy do
 * homelab (e outros) recusa a resposta. Use `inChunks(ids, (lote) => consulta)` e junte os resultados.
 */
export const IN_CHUNK = 50;
export function chunks<T>(arr: T[], size = IN_CHUNK): T[][] {
  return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));
}
export async function inChunks<T, R>(ids: T[], run: (part: T[]) => PromiseLike<{ data: R[] | null; error?: { message: string } | null }>): Promise<R[]> {
  const out: R[] = [];
  for (const part of chunks(ids)) {
    const { data, error } = await run(part);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
  }
  return out;
}
