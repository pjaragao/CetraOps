import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { TIER_LABEL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Button, Card, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { updateProfileAction } from "../../actions";

export const metadata = { title: "Editar ficha" };

export default async function EditarFicha({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const sp = await searchParams;
  const session = await requirePerm("crm.read");
  if (!can(session, "crm.write")) redirect(`/clientes/${id}`);
  const supabase = await createClient();
  const [{ data: p }, { data: members }, { data: emails }] = await Promise.all([
    supabase.schema("crm").from("parties").select("*").eq("id", id).maybeSingle(),
    supabase.schema("core").from("members").select("id, display_name").eq("status", "ACTIVE").order("display_name"),
    supabase.schema("crm").from("party_contact_points").select("value_display").eq("party_id", id).eq("type", "EMAIL").limit(1),
  ]);
  if (!p) notFound();
  const sizes = (p.sizes ?? {}) as Record<string, string>;
  const prefs = (p.preferences ?? {}) as { activities?: string[]; notes?: string };
  const isAdmin = can(session, "core.admin");

  return (
    <>
      <PageHeader title={`Editar: ${p.display_name}`} description="Tamanho, aniversário e atividades alimentam as recomendações, o score e as réguas de relacionamento."
        actions={<Link href={`/clientes/${id}`} className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Ficha</Link>} />
      <Flash erro={str(sp.erro)} />
      <form action={updateProfileAction} className="space-y-4">
        <input type="hidden" name="id" value={id} />
        <Card title="Dados pessoais">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Nome"><input name="display_name" required minLength={2} maxLength={120} defaultValue={p.display_name} className={inputClass} /></Field>
            <Field label="Aniversário"><input name="birth_date" type="date" defaultValue={p.birth_date ?? ""} className={inputClass} /></Field>
            <Field label="Profissão"><input name="profession" maxLength={80} defaultValue={p.profession ?? ""} className={inputClass} /></Field>
            <Field label="Cidade"><input name="city" maxLength={80} defaultValue={p.city ?? ""} className={inputClass} /></Field>
            <Field label="UF"><input name="uf" maxLength={2} defaultValue={p.uf ?? ""} className={`${inputClass} uppercase`} /></Field>
            <Field label="Instagram"><input name="instagram_handle" maxLength={31} defaultValue={p.instagram_handle ?? ""} className={inputClass} placeholder="@usuario" /></Field>
            <Field label="E-mail" hint={emails?.[0] ? `Atual: ${emails[0].value_display} (um novo é acrescentado)` : undefined}><input name="email" type="email" className={inputClass} /></Field>
            <Field label="Aluna JOY">
              <select name="joy_member_status" defaultValue={p.joy_member_status} className={inputClass}>
                <option value="UNKNOWN">Não informado</option><option value="SELF_DECLARED">Disse que é aluna</option><option value="CONFIRMED_IN_STORE">Confirmado na loja</option>
              </select>
            </Field>
          </div>
        </Card>
        <Card title="Tamanhos e preferências">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Top"><input name="size_top" maxLength={6} defaultValue={sizes.top ?? ""} className={`${inputClass} uppercase`} placeholder="M" /></Field>
            <Field label="Calça/short"><input name="size_bottom" maxLength={6} defaultValue={sizes.bottom ?? ""} className={`${inputClass} uppercase`} placeholder="P" /></Field>
            <Field label="Top/sutiã"><input name="size_bra" maxLength={6} defaultValue={sizes.bra ?? ""} className={`${inputClass} uppercase`} /></Field>
            <Field label="Calçado"><input name="size_shoe" maxLength={6} defaultValue={sizes.shoe ?? ""} className={inputClass} /></Field>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Atividades" hint="Separadas por vírgula. Ex.: pilates, corrida"><input name="activities" defaultValue={(prefs.activities ?? []).join(", ")} className={inputClass} /></Field>
            <Field label="Etiquetas" hint="Separadas por vírgula, minúsculas. Ex.: embaixadora, indicacao"><input name="tags" defaultValue={(p.tags ?? []).join(", ")} className={inputClass} /></Field>
          </div>
          <Field label="Observações" className="mt-3"><textarea name="notes" maxLength={500} rows={3} defaultValue={prefs.notes ?? ""} className={inputClass} placeholder="Prefere cintura alta, não gosta de estampa…" /></Field>
        </Card>
        <Card title="Relacionamento">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Dona do relacionamento" hint="Recebe os avisos de VIP em risco">
              <select name="owner" defaultValue={p.relationship_owner_member_id ?? ""} className={inputClass}><option value="">Ninguém</option>{(members ?? []).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select>
            </Field>
            <Field label="Loja de origem">
              <select name="home_store" defaultValue={p.home_store_id ?? ""} className={inputClass}><option value="">—</option>{session.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            </Field>
            <Field label="Nível" hint={isAdmin ? "Automático segue as regras do ciclo de vida; VIP Black é sempre manual" : "Só sócios mudam o nível à mão"}>
              <select name="tier" defaultValue={p.tier_manual ? p.tier : "AUTO"} disabled={!isAdmin} className={inputClass}>
                <option value="AUTO">Automático ({TIER_LABEL[p.tier]})</option>
                {["STANDARD", "VIP", "VIP_BLACK"].map((t) => <option key={t} value={t}>{TIER_LABEL[t]} (fixo)</option>)}
              </select>
            </Field>
          </div>
        </Card>
        <div className="flex items-center gap-3"><Button>Salvar ficha</Button><Link href={`/clientes/${id}`} className="text-sm text-brand">Cancelar</Link></div>
      </form>
    </>
  );
}
