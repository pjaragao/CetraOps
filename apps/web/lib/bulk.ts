/**
 * Ações em lote das tabelas (ver `bulk` em components/data-table.tsx): a tabela manda um `ids` por linha marcada e a
 * action roda a mesma RPC de uma linha para cada id, em sequência (cada uma com as próprias regras e permissões no banco).
 * O que falhar não impede o resto; a mensagem de volta diz quantas deram certo e por que as outras não.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BULK_MAX = 200;

/** Ids marcados (únicos, só uuid, no máximo 200). */
export function bulkIds(formData: FormData, name = "ids"): string[] {
  return [...new Set(formData.getAll(name).map((v) => String(v).trim()).filter((v) => UUID.test(v)))].slice(0, BULK_MAX);
}

type RpcResult = { error: { message: string } | null };

/** Roda `fn` para cada id; `label` nomeia a linha na mensagem de erro (ex.: o número do reembolso). */
export async function runBulk(ids: string[], fn: (id: string) => PromiseLike<RpcResult>, label: (id: string) => string = () => "") {
  let done = 0;
  const failed: string[] = [];
  for (const id of ids) {
    const { error } = await fn(id);
    if (error) failed.push(`${label(id) ? `${label(id)}: ` : ""}${error.message.replace(/^ERROR:\s*/, "")}`);
    else done++;
  }
  return { done, failed };
}

/** Parâmetros ok/erro para a página: "3 aprovados" e, se houver, "2 não foram: REE-1: motivo; REE-2: motivo". */
export function bulkFlash({ done, failed }: { done: number; failed: string[] }, okText: (n: number) => string): { ok?: string; erro?: string } {
  const uniq = [...new Set(failed)];
  return {
    ok: done > 0 ? okText(done) : undefined,
    erro: failed.length > 0 ? `${failed.length} não ${failed.length === 1 ? "foi" : "foram"}: ${uniq.slice(0, 4).join("; ")}${uniq.length > 4 ? "…" : ""}` : undefined,
  };
}
