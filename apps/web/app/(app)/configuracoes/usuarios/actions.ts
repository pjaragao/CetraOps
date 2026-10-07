"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const USERS = "/configuracoes/usuarios";
const ROLES = "/configuracoes/perfis";

function go(path: string, params: Record<string, string | undefined>): never {
  revalidatePath("/configuracoes", "layout");
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  redirect(q ? `${path}?${q}` : path);
}

/** Perfis, lojas e loja padrão vindos do formulário (checkboxes "roles" e "stores"). */
const access = (formData: FormData) => ({
  display_name: str(formData.get("display_name")),
  roles: formData.getAll("roles").map(String),
  all_stores: formData.get("all_stores") === "on",
  stores: formData.getAll("stores").map(String),
  default_store_id: str(formData.get("default_store_id")) || null,
});

export async function createUserAction(formData: FormData) {
  const supabase = await createClient();
  const email = str(formData.get("email"));
  const { data, error } = await supabase.schema("core").rpc("create_user", { p: { ...access(formData), email, password: String(formData.get("password") ?? ""), party_id: str(formData.get("party_id")) || null } as Json });
  if (error) go(USERS, { erro: friendly(error.message), pessoa: str(formData.get("party_id")) || undefined });
  go(`${USERS}/${data as unknown as string}`, { ok: `Usuário criado. Passe à pessoa o e-mail ${email} e a senha provisória: no primeiro acesso ela cria a própria senha.` });
}

export async function linkUserPartyAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { data, error } = await supabase.schema("core").rpc("link_user_party", { p_member: id, p_party: str(formData.get("party_id")) });
  const merged = (data as unknown as { merged?: boolean } | null)?.merged;
  go(`${USERS}/${id}`, error ? { erro: friendly(error.message) } : { ok: merged ? "Usuário ligado à pessoa do cadastro. O cadastro duplicado criado junto com o usuário foi mesclado." : "Usuário ligado à pessoa do cadastro." });
}

export async function updateUserAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("core").rpc("update_user", { p_member: id, p: access(formData) as Json });
  go(`${USERS}/${id}`, error ? { erro: friendly(error.message) } : { ok: "Acessos salvos. Valem a partir da próxima página que a pessoa abrir." });
}

export async function setUserStatusAction(formData: FormData) {
  const id = str(formData.get("id"));
  const active = str(formData.get("active")) === "1";
  const supabase = await createClient();
  const { error } = await supabase.schema("core").rpc("set_user_status", { p_member: id, p_active: active });
  go(`${USERS}/${id}`, error ? { erro: friendly(error.message) } : { ok: active ? "Usuário reativado." : "Usuário suspenso: não consegue mais entrar e as sessões abertas foram encerradas." });
}

export async function resetPasswordAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("core").rpc("reset_user_password", { p_member: id, p_password: String(formData.get("password") ?? "") });
  go(`${USERS}/${id}`, error ? { erro: friendly(error.message) } : { ok: "Senha provisória definida. A pessoa cria a própria senha no próximo acesso." });
}

export async function saveRoleAction(formData: FormData) {
  const supabase = await createClient();
  const id = str(formData.get("id"));
  const { error } = await supabase.schema("core").rpc("save_role", { p: { id: id || null, name: str(formData.get("name")), permissions: formData.getAll("permissions").map(String) } as Json });
  go(ROLES, error ? { erro: friendly(error.message), ...(id ? { perfil: id } : { novo: "1" }) } : { ok: id ? "Perfil salvo." : "Perfil criado." });
}

export async function deleteRoleAction(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.schema("core").rpc("delete_role", { p_id: str(formData.get("id")) });
  go(ROLES, error ? { erro: friendly(error.message) } : { ok: "Perfil apagado." });
}
