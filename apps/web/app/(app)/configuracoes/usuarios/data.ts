import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { RoleOpt, StoreOpt } from "./access-fields";

export interface AdminUser {
  id: string; user_id: string; display_name: string; email: string; status: "ACTIVE" | "SUSPENDED"; last_sign_in_at: string | null; created_at: string;
  default_store_id: string | null; must_change_password: boolean; roles: string[]; all_stores: boolean; stores: string[]; employee: { id: string; name: string } | null;
  party: { id: string; name: string; shareholder: boolean } | null;
}

/** Usuários, perfis (com o número de permissões) e lojas para as telas de administração. */
export async function loadAdminData() {
  const supabase = await createClient();
  const [{ data: users, error }, { data: roles }, { data: stores }] = await Promise.all([
    supabase.schema("core").rpc("admin_users"),
    supabase.schema("core").from("roles").select("id, name, is_superuser, role_permissions(permission_key)").order("is_superuser", { ascending: false }).order("name"),
    supabase.schema("core").from("stores").select("id, name").order("name"),
  ]);
  return {
    error: error?.message,
    users: ((users as unknown as AdminUser[] | null) ?? []),
    roles: (roles ?? []).map((r) => ({ id: r.id, name: r.name, is_superuser: r.is_superuser, count: (r.role_permissions ?? []).length })) as RoleOpt[],
    stores: (stores ?? []) as StoreOpt[],
  };
}

export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "nunca");

export interface PersonHit { id: string; name: string; city: string | null; roles: string[]; }

/** Pessoas do Cadastro (não empresas, não mescladas) pelo nome: a fonte única para quem vai ganhar acesso. */
export async function searchPeople(text: string): Promise<PersonHit[]> {
  const q = text.replace(/[%,()]/g, " ").trim();
  if (q.length < 2) return [];
  const supabase = await createClient();
  const { data } = await supabase.schema("crm").from("parties").select("id, display_name, city, party_roles(role)")
    .eq("kind", "PERSON").is("merged_into_id", null).is("anonymized_at", null).ilike("display_name", `%${q}%`).order("display_name").limit(8);
  return (data ?? []).map((p) => ({ id: p.id, name: p.display_name, city: p.city, roles: (p.party_roles ?? []).map((r) => r.role) }));
}

export const ROLE_LABEL: Record<string, string> = { CUSTOMER: "cliente", EMPLOYEE: "colaborador(a)", SHAREHOLDER: "sócio(a)", SUPPLIER: "fornecedor(a)", AFFILIATE_TRAINER: "afiliada" };
