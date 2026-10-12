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
