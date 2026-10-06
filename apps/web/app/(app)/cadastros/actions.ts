"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Json } from "@centralops/db";
import { createClient } from "@/lib/supabase/server";
import { lookupCnpj } from "@/lib/cnpj";
import { findParty } from "../clientes/party-lookup";

export type State = { ok: boolean; error?: string; message?: string } | null;

const friendly = (m: string) => m.replace(/^ERROR:\s*/, "");
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

function go(path: string, error: { message: string } | null, ok: string): never {
  revalidatePath("/cadastros", "layout");
  revalidatePath("/clientes", "layout");
  const q = new URLSearchParams(error ? { erro: friendly(error.message) } : { ok });
  redirect(`${path}${path.includes("?") ? "&" : "?"}${q}`);
}

const partySchema = z.object({
  kind: z.enum(["PERSON", "COMPANY"]), display_name: z.string().min(2).max(120), legal_name: z.string().max(160).optional(), cnpj: z.string().max(18).optional(),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), gender: z.enum(["F", "M", "O"]).optional(), instagram_handle: z.string().max(31).optional(),
  phones: z.array(z.string().max(25)).max(5), emails: z.array(z.string().max(120)).max(5), roles: z.array(z.string()).max(8), tags: z.array(z.string()).max(10), notes: z.string().max(500).optional(),
  address: z.record(z.string(), z.string()).optional(),
  cpf: z.string().regex(/^\d{11}$/).optional(), ie: z.string().max(20).optional(),
});

/** Novo cadastro (pessoa ou empresa). */
export async function createPartyAction(_prev: State, formData: FormData): Promise<State> {
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const parsed = partySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Confira o cadastro: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const supabase = await createClient();
  const { cpf, ...party } = parsed.data;
  if (cpf) {   // o CPF não pode estar em dois cadastros: confere antes de criar
    const { data: found, error: e } = await supabase.schema("crm").rpc("find_by_cpf", { p_cpf: cpf });
    if (e) return { ok: false, error: friendly(e.message) };
    const f = found as unknown as { found: boolean; display_name?: string };
    if (f.found) return { ok: false, error: `Este CPF já está no cadastro de ${f.display_name}` };
  }
  const { data, error } = await supabase.schema("crm").rpc("create_party", { p: party as unknown as Json });
  if (error) return { ok: false, error: friendly(error.message) };
  if (cpf) {
    const { error: e } = await supabase.schema("crm").rpc("set_cpf", { p_party: (data as unknown as { id: string }).id, p_cpf: cpf });
    if (e) return redirect(`/cadastros/${(data as unknown as { id: string }).id}?erro=${encodeURIComponent(`Cadastro criado, mas o CPF não foi gravado: ${friendly(e.message)}`)}`);
  }
  const registry = (raw as { registry?: unknown }).registry;
  if (registry && typeof registry === "object") {   // retrato da Receita da consulta de CNPJ (falha aqui não desfaz o cadastro)
    await supabase.schema("crm").rpc("save_registry", { p_party: (data as unknown as { id: string }).id, p_data: registry as Json });
  }
  revalidatePath("/cadastros", "layout");
  return redirect(`/cadastros/${(data as unknown as { id: string }).id}?ok=${encodeURIComponent("Cadastro criado")}`);
}

export async function updateIdentityAction(formData: FormData) {
  const id = str(formData.get("id"));
  const p: Record<string, string> = { display_name: str(formData.get("display_name")) };
  if (formData.has("legal_name")) p.legal_name = str(formData.get("legal_name"));
  if (formData.has("cnpj")) p.cnpj = str(formData.get("cnpj"));
  if (formData.has("ie")) p.ie = str(formData.get("ie"));
  if (formData.has("birth_date")) p.birth_date = str(formData.get("birth_date"));
  if (formData.has("gender")) p.gender = str(formData.get("gender"));
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("update_party_identity", { p_party: id, p: p as Json });
  const cpf = str(formData.get("cpf")).replace(/\D/g, "");   // em branco = mantém o CPF atual
  if (!error && cpf) {
    const { error: e } = await supabase.schema("crm").rpc("set_cpf", { p_party: id, p_cpf: cpf });
    go(`/cadastros/${id}`, e, "Identidade e CPF atualizados");
  }
  go(`/cadastros/${id}`, error, "Identidade atualizada");
}

/** CPF completo, só com a permissão de dados sensíveis; o banco registra a consulta em audit.log. */
export async function revealCpfAction(_prev: State, formData: FormData): Promise<State> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("crm").rpc("reveal_cpf", { p_party: str(formData.get("id")) });
  if (error) return { ok: false, error: friendly(error.message) };
  if (!data) return { ok: false, error: "Este cadastro não tem CPF" };
  return { ok: true, message: data.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4") };
}

export async function addContactAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("add_contact", { p_party: id, p_type: str(formData.get("type")) as "PHONE", p_value: str(formData.get("value")), p_primary: formData.get("primary") === "on" });
  go(`/cadastros/${id}`, error, "Contato adicionado");
}

export async function removeContactAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("remove_contact", { p_id: str(formData.get("contact_id")) });
  go(`/cadastros/${id}`, error, "Contato removido");
}

export async function saveAddressAction(formData: FormData) {
  const id = str(formData.get("id"));
  const g = (k: string) => str(formData.get(`a_${k}`));
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("save_address", { p: {
    party_id: id, id: str(formData.get("address_id")) || null, label: str(formData.get("label")), cep: g("cep"), street: g("street"), number: g("number"), complement: g("complement"),
    district: g("district"), city: g("city"), uf: g("uf"), is_default: formData.get("is_default") === "on",
  } as Json });
  go(`/cadastros/${id}`, error, "Endereço salvo");
}

export async function deleteAddressAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("delete_address", { p_id: str(formData.get("address_id")) });
  go(`/cadastros/${id}`, error, "Endereço removido");
}

export async function setRolesAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("set_party_roles", { p_party: id, p_roles: formData.getAll("roles").map(String) });
  go(`/cadastros/${id}`, error, "Papéis atualizados");
}

export async function addRelationAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const other = await findParty(supabase, str(formData.get("other")));
  if ("error" in other) go(`/cadastros/${id}`, { message: other.error }, "");
  const { error } = await supabase.schema("crm").rpc("add_relation", { p_party: id, p_other: other.id, p_role: str(formData.get("role")), p_note: str(formData.get("note")) || undefined });
  go(`/cadastros/${id}`, error, "Vínculo registrado");
}

export async function removeRelationAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("remove_relation", { p_id: str(formData.get("relation_id")) });
  go(`/cadastros/${id}`, error, "Vínculo removido");
}

/** Mescla a duplicada na principal (a principal é a página aberta). Exige digitar MESCLAR. */
export async function mergePartiesAction(formData: FormData) {
  const keep = str(formData.get("id"));
  if (str(formData.get("confirm")).toUpperCase() !== "MESCLAR") go(`/cadastros/${keep}`, { message: "Digite MESCLAR para confirmar" }, "");
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("merge_parties", { p_keep: keep, p_dup: str(formData.get("dup")) });
  go(`/cadastros/${keep}`, error, "Cadastros mesclados: tudo da duplicada agora está aqui");
}

/** Consulta o CNPJ de novo (Receita via fontes gratuitas) e grava o retrato; só preenche o que estiver vazio no cadastro. */
export async function refreshRegistryAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { data: p } = await supabase.schema("crm").from("parties").select("cnpj").eq("id", id).maybeSingle();
  if (!p?.cnpj) go(`/cadastros/${id}`, { message: "Cadastre o CNPJ antes de consultar a Receita" }, "");
  const r = await lookupCnpj(p!.cnpj!);
  if (!r.ok) go(`/cadastros/${id}`, { message: r.error }, "");
  const { error } = await supabase.schema("crm").rpc("save_registry", { p_party: id, p_data: r.data as unknown as Json });
  go(`/cadastros/${id}`, error, `Dados da Receita atualizados (${r.data.sources.join(", ")})`);
}

/** Tipo de favorecido e categoria padrão do plano de contas (usada quando o título é lançado sem conta). */
export async function setPayeeDefaultsAction(formData: FormData) {
  const id = str(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.schema("crm").rpc("set_payee_defaults", { p_party: id, p_kind: str(formData.get("payee_kind")), p_account: (str(formData.get("account")) || null) as string });
  go(`/cadastros/${id}`, error, "Dados de favorecido salvos");
}
