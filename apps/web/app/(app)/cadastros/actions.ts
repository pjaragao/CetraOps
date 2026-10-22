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

const editSchema = z.object({
  id: z.string().uuid(), kind: z.enum(["PERSON", "COMPANY"]), display_name: z.string().min(2).max(120), legal_name: z.string().max(160).optional(),
  cnpj: z.string().regex(/^\d{14}$/).optional(), ie: z.string().max(20).optional(), birth_date: z.string().max(10).optional(), gender: z.string().max(1).optional(),
  instagram_handle: z.string().max(31), tags: z.array(z.string()).max(10), notes: z.string().max(500), roles: z.array(z.string()).max(8).optional(),
  cpf: z.string().regex(/^\d{11}$/).optional(),
  add_contacts: z.array(z.object({ type: z.enum(["WHATSAPP", "PHONE", "EMAIL"]), value: z.string().min(1).max(120), primary: z.boolean() })).max(5),
  remove_contacts: z.array(z.string().uuid()).max(50),
  address: z.object({ id: z.string().uuid().optional(), label: z.string().max(40).optional(), cep: z.string(), street: z.string(), number: z.string(), complement: z.string(), district: z.string(), city: z.string(), uf: z.string() }).optional(),
});

/**
 * Edição pelo mesmo formulário da criação: identidade, CPF, Instagram/etiquetas/observações, papéis, contatos (sai/entra) e endereço principal.
 * Cada parte vai pela RPC que já valida aquela regra; para no primeiro erro (o formulário mantém o que foi digitado).
 */
export async function updatePartyAction(_prev: State, formData: FormData): Promise<State> {
  let raw: unknown;
  try { raw = JSON.parse(String(formData.get("payload") ?? "")); } catch { return { ok: false, error: "Dados inválidos" }; }
  const parsed = editSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Confira o cadastro: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}` };
  const d = parsed.data;
  const supabase = await createClient();
  const crm = supabase.schema("crm");
  const fail = (e: { message: string } | null) => (e ? { ok: false, error: friendly(e.message) } as const : null);

  const identity: Record<string, string> = { display_name: d.display_name };
  if (d.kind === "COMPANY") { identity.legal_name = d.legal_name ?? ""; identity.ie = d.ie ?? ""; if (d.cnpj) identity.cnpj = d.cnpj; }
  else { identity.birth_date = d.birth_date ?? ""; identity.gender = d.gender ?? ""; }
  let r = fail((await crm.rpc("update_party_identity", { p_party: d.id, p: identity as Json })).error);
  if (r) return r;
  if (d.cpf) { r = fail((await crm.rpc("set_cpf", { p_party: d.id, p_cpf: d.cpf })).error); if (r) return r; }
  r = fail((await crm.rpc("update_profile", { p_party: d.id, p: { instagram_handle: d.instagram_handle, tags: d.tags, notes: d.notes } as Json })).error);
  if (r) return r;
  if (d.roles) { r = fail((await crm.rpc("set_party_roles", { p_party: d.id, p_roles: d.roles })).error); if (r) return r; }
  for (const c of d.remove_contacts) { r = fail((await crm.rpc("remove_contact", { p_id: c })).error); if (r) return r; }
  for (const c of d.add_contacts) { r = fail((await crm.rpc("add_contact", { p_party: d.id, p_type: c.type, p_value: c.value, p_primary: c.primary })).error); if (r) return r; }
  if (d.address && (d.address.cep || d.address.street)) {
    r = fail((await crm.rpc("save_address", { p: { party_id: d.id, ...d.address, id: d.address.id ?? null, label: d.address.label ?? "", is_default: true } as Json })).error);
    if (r) return r;
  }
  const registry = (raw as { registry?: unknown }).registry;
  if (registry && typeof registry === "object") await crm.rpc("save_registry", { p_party: d.id, p_data: registry as Json });   // retrato da Receita do CNPJ novo
  return go(`/cadastros/${d.id}`, null, "Cadastro salvo");
}

/** CPF completo, só com a permissão de dados sensíveis; o banco registra a consulta em audit.log. */
export async function revealCpfAction(_prev: State, formData: FormData): Promise<State> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema("crm").rpc("reveal_cpf", { p_party: str(formData.get("id")) });
  if (error) return { ok: false, error: friendly(error.message) };
  if (!data) return { ok: false, error: "Este cadastro não tem CPF" };
  return { ok: true, message: data.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4") };
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
