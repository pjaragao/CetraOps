// Verificação de vida para Traefik/Coolify/uptime: não exige sessão (o proxy deixa passar) e não toca no banco.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
