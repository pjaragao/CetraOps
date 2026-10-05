import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const STORE_COOKIE = "centralops_store";

export interface Session {
  userId: string;
  memberId: string;
  orgId: string;
  name: string;
  roles: string[];
  isSuperuser: boolean;
  mustChangePassword: boolean;
  perms: Set<string>;
  stores: { id: string; name: string; code: string; status: string; legal_entity_id: string }[];
  storeId: string | null; // null = "Todas as lojas"
}

/** Sessão do request (memoizada): membro, papéis, permissões, lojas e loja ativa (cookie). */
export const getSession = cache(async (): Promise<Session> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/login");

  const { data: member, error: memberError } = await supabase
    .schema("core")
    .from("members")
    .select("id, org_id, display_name, default_store_id, member_roles(roles(key, is_superuser, role_permissions(permission_key)))")
    .eq("user_id", data.claims.sub)
    .maybeSingle();

  if (memberError) redirect("/login?erro=sistema");          // banco fora do ar ou sem as migrations: não confundir com "sem acesso"
  if (!member) redirect("/login?erro=sem-acesso");

  // Lido à parte: se o banco ainda não recebeu a migration da troca de senha, o login continua funcionando.
  const { data: pw } = await supabase.schema("core").from("members").select("must_change_password").eq("id", member.id).maybeSingle();

  const roles = (member.member_roles ?? []).map((mr) => mr.roles).filter(Boolean);
  const perms = new Set<string>(roles.flatMap((r) => (r?.role_permissions ?? []).map((p) => p.permission_key)));
  const isSuperuser = roles.some((r) => r?.is_superuser);

  const { data: stores } = await supabase
    .schema("core")
    .from("stores")
    .select("id, name, code, status, legal_entity_id")
    .order("name");

  const cookieStore = await cookies();
  const wanted = cookieStore.get(STORE_COOKIE)?.value;
  const list = stores ?? [];
  let storeId: string | null = member.default_store_id ?? list[0]?.id ?? null;
  if (wanted === "ALL" && isSuperuser) storeId = null;
  else if (wanted && list.some((s) => s.id === wanted)) storeId = wanted;

  return {
    userId: data.claims.sub,
    memberId: member.id,
    orgId: member.org_id,
    name: member.display_name,
    roles: roles.map((r) => r!.key),
    isSuperuser,
    mustChangePassword: Boolean(pw?.must_change_password),
    perms,
    stores: list,
    storeId,
  };
});

export function can(session: Session, perm: string) {
  return session.isSuperuser || session.perms.has(perm);
}

/** Bloqueia a página se faltar a permissão (o RLS também bloquearia os dados). */
export async function requirePerm(perm: string) {
  const s = await getSession();
  if (!can(s, perm)) redirect("/inicio?erro=sem-permissao");
  return s;
}
