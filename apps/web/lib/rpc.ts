import "server-only";

type RpcClient = { schema(s: string): { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> } };

/** Chama uma função do banco que ainda não está nos tipos gerados (@centralops/db). */
export function rpcAny(client: unknown, schema: string, fn: string, args: Record<string, unknown>) {
  return (client as RpcClient).schema(schema).rpc(fn, args);
}
