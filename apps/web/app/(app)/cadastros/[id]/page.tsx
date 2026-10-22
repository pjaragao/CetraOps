import Link from "next/link";
import { notFound } from "next/navigation";
import { RELATION_OPTIONS, relativeLabel } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Button, Card, Empty, inputClass, LinkButton, Narrow, PageHeader } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { addRelationAction, deleteAddressAction, mergePartiesAction, removeRelationAction, saveAddressAction } from "../actions";
import { PartyForm } from "../novo/party-form";
import { AddressForm } from "./address-form";
import { RegistryCard } from "./registry-card";
import { PayeeCard } from "./payee-card";
import type { CnpjData } from "@centralops/domain";

export const metadata = { title: "Cadastro" };

interface Access { member_id: string; email: string; status: string; must_change_password: boolean; roles: string[]; superuser: boolean }

const fmtCnpj = (c: string) => c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
const fmtCep = (c: string | null) => (c ? c.replace(/^(\d{5})(\d{3})$/, "$1-$2") : "");

export default async function CadastroPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const sp = await searchParams;
  const session = await requirePerm("crm.read");
  const canWrite = can(session, "crm.write");
  const canSensitive = can(session, "crm.sensitive");
  const isAdmin = can(session, "core.admin");
  const supabase = await createClient();
  const { data: p } = await supabase.schema("crm").from("parties").select("*").eq("id", id).maybeSingle();
  if (!p) notFound();
  if (p.merged_into_id) return (<><PageHeader title={p.display_name} /><Empty title="Este cadastro foi mesclado">Tudo dele agora está no cadastro principal. <Link className="text-brand" href={`/cadastros/${p.merged_into_id}`}>Abrir o principal</Link></Empty></>);

  const company = p.kind === "COMPANY";
  const [{ data: contacts }, { data: addresses }, { data: roles }, { data: relatives }, { data: dups }, { data: cpfMasked }] = await Promise.all([
    supabase.schema("crm").from("party_contact_points").select("id, type, value_display, is_primary").eq("party_id", id).order("type").order("created_at"),
    supabase.schema("crm").from("party_addresses").select("*").eq("party_id", id).order("is_default", { ascending: false }).order("created_at"),
    supabase.schema("crm").from("party_roles").select("role").eq("party_id", id),
    company ? Promise.resolve({ data: [] as never[] }) : supabase.schema("crm").rpc("relatives_of", { p_party: id }),
    supabase.schema("crm").rpc("duplicate_candidates", { p_party: id }),
    company ? Promise.resolve({ data: null }) : supabase.schema("crm").rpc("party_cpf_masked", { p_party: id }),   // só o final; o completo exige crm.sensitive
  ]);
  const { data: accounts } = company ? await supabase.schema("fin").from("chart_accounts").select("id, code, name").eq("kind", "ANALYTIC").is("archived_at", null).order("code") : { data: [] as { id: string; code: string; name: string }[] };
  const access = isAdmin && !company ? ((await supabase.schema("core").rpc("party_access", { p_party: id })).data as unknown as Access | null) : null;
  const myRoles = new Set<string>((roles ?? []).map((r) => r.role));
  const main = (addresses ?? []).find((a) => a.is_default) ?? (addresses ?? [])[0];
  const others = (addresses ?? []).filter((a) => a.id !== main?.id);

  return (
    <>
      <PageHeader title={p.display_name} description={[company ? (p.cnpj ? `CNPJ ${fmtCnpj(p.cnpj)}` : "Empresa") : "Pessoa", p.legal_name && p.legal_name !== p.display_name ? p.legal_name : null].filter(Boolean).join(" · ")}
        actions={<div className="flex gap-2"><LinkButton href={`/clientes/${p.id}`}>Ficha comercial</LinkButton><LinkButton href={company ? "/cadastros/empresas" : "/cadastros/pessoas"}>Voltar</LinkButton></div>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      {/* o mesmo formulário do "Novo cadastro", já preenchido; o que não muda aqui aparece travado, com o motivo */}
      <Narrow>
        <PartyForm company={company} canReadDocs={can(session, "ai.assistant")} readOnly={!canWrite} edit={{
          id, display_name: p.display_name, legal_name: p.legal_name, cnpj: p.cnpj, ie: p.ie, birth_date: p.birth_date, gender: p.gender,
          instagram_handle: p.instagram_handle, tags: p.tags ?? [], notes: (p.preferences as { notes?: string } | null)?.notes ?? "", roles: [...myRoles],
          cpfMasked: (cpfMasked as string | null) ?? null, canSensitive,
          contacts: (contacts ?? []).map((c) => ({ id: c.id, type: c.type, value_display: c.value_display, is_primary: c.is_primary })),
          address: main ? { id: main.id, label: main.label, cep: fmtCep(main.cep), street: main.street ?? "", number: main.number ?? "", complement: main.complement ?? "", district: main.district ?? "", city: main.city ?? "", uf: main.uf ?? "" } : null,
        }} />
      </Narrow>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {company && <RegistryCard id={id} hasCnpj={Boolean(p.cnpj)} registry={(p.registry as unknown as CnpjData | null) ?? null} registryAt={p.registry_at} canWrite={canWrite} />}

        {company && <PayeeCard id={id} kind={p.payee_kind} account={p.default_chart_account_id} notes={null}
          accounts={(accounts ?? []).map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))} canWrite={canWrite} />}

        {isAdmin && !company && (
          <Card title="Acesso ao sistema">
            {access ? (
              <div className="space-y-2 text-sm">
                <p><b>{access.email}</b> · {access.status === "ACTIVE" ? (access.must_change_password ? "aguardando o 1º acesso" : "ativo") : "suspenso"}</p>
                <p className="text-muted">Perfis: {access.roles.join(", ") || "nenhum"}</p>
                <LinkButton href={`/configuracoes/usuarios/${access.member_id}`}>Gerenciar acesso</LinkButton>
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <p className="text-muted">Esta pessoa não entra no sistema.{myRoles.has("SHAREHOLDER") ? " Como é sócia da empresa, o perfil de acesso total já vem sugerido." : ""}</p>
                <LinkButton href={`/configuracoes/usuarios?pessoa=${id}#novo`}>Dar acesso ao sistema</LinkButton>
              </div>
            )}
            {!myRoles.has("EMPLOYEE") && can(session, "hr.write") && <p className="mt-3 text-xs"><Link href={`/equipe/novo?pessoa=${id}`} className="text-brand">Admitir como colaborador(a)</Link> <span className="text-muted">— usa este mesmo cadastro, sem criar outro.</span></p>}
          </Card>
        )}

        <Card title="Outros endereços">
          {others.length === 0 ? <p className="text-sm text-muted">Só o endereço principal (no formulário acima).</p> : (
            <ul className="space-y-2 text-sm">{others.map((a) => (
              <li key={a.id} className="rounded-lg border border-border p-2">
                <div className="flex items-start justify-between gap-2">
                  <span>{a.label && <b>{a.label} · </b>}{[a.street, a.number, a.complement].filter(Boolean).join(", ")}<span className="block text-xs text-muted">{[a.district, a.city && `${a.city}${a.uf ? `/${a.uf}` : ""}`, fmtCep(a.cep)].filter(Boolean).join(" · ")}</span></span>
                  {canWrite && (
                    <span className="flex items-center gap-1">
                      <form action={saveAddressAction}>
                        <input type="hidden" name="id" value={id} /><input type="hidden" name="address_id" value={a.id} /><input type="hidden" name="label" value={a.label ?? ""} /><input type="hidden" name="is_default" value="on" />
                        {(["cep", "street", "number", "complement", "district", "city", "uf"] as const).map((k) => <input key={k} type="hidden" name={`a_${k}`} value={a[k] ?? ""} />)}
                        <Button variant="ghost" className="px-2 py-1 text-xs">Tornar principal</Button>
                      </form>
                      <form action={deleteAddressAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="address_id" value={a.id} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Remover</Button></form>
                    </span>
                  )}
                </div>
              </li>
            ))}</ul>
          )}
          {canWrite && <div className="mt-3 border-t border-border pt-3"><p className="mb-2 text-xs font-medium text-muted">Novo endereço</p><AddressForm partyId={id} /></div>}
        </Card>
      </div>

      {!company && (
        <Card className="mt-4" title="Vínculos (família e relações)">
          <p className="mb-2 text-xs text-muted">Registre só o que a cliente contou. Serve para lembrar de datas (aniversário de parente, Dia das Mães, Natal) e oferecer presente, respeitando o aceite de marketing.</p>
          {(relatives ?? []).length === 0 ? <p className="text-sm text-muted">Nenhum vínculo.</p> : (
            <ul className="space-y-1.5 text-sm">{(relatives ?? []).map((r) => (
              <li key={r.relation_id} className="flex items-center justify-between gap-2">
                <span><Link className="font-medium text-brand" href={`/cadastros/${r.relative_id}`}>{r.relative_name}</Link> <span className="text-muted">é {relativeLabel(r.role, r.gender)} desta pessoa</span>
                  {r.birth_date && <span className="ml-2 text-xs text-muted">aniversário {r.birth_date.slice(5).split("-").reverse().join("/")}{r.birthday_in_days != null && r.birthday_in_days <= 30 ? ` (em ${r.birthday_in_days} dia(s))` : ""}</span>}
                  {r.note && <span className="ml-2 text-xs text-muted">· {r.note}</span>}</span>
                {canWrite && <form action={removeRelationAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="relation_id" value={r.relation_id} /><Button variant="ghost" className="px-2 py-1 text-xs text-danger">Remover</Button></form>}
              </li>
            ))}</ul>
          )}
          {canWrite && (
            <form action={addRelationAction} className="mt-3 grid gap-2 sm:grid-cols-[1fr_1.4fr_1fr_auto] sm:items-end">
              <input type="hidden" name="id" value={id} />
              <Field label="Pessoa (nome ou telefone)" hint="Ela precisa estar cadastrada"><input name="other" required className={inputClass} placeholder="Maria Silva" /></Field>
              <Field label="Ela…"><select name="role" required className={inputClass} defaultValue="PARENT">{RELATION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
              <Field label="Observação"><input name="note" maxLength={200} className={inputClass} /></Field>
              <Button variant="secondary">Vincular</Button>
            </form>
          )}
        </Card>
      )}

      {isAdmin && (dups ?? []).length > 0 && (
        <Card className="mt-4" title="Possíveis duplicadas">
          <p className="mb-2 text-xs text-muted">Mesclar leva tudo da duplicada (contatos, tarefas, pedidos, conversas, aceites) para este cadastro e não tem volta. Uma recusa de contato da duplicada prevalece.</p>
          <ul className="space-y-2 text-sm">{(dups ?? []).map((d) => (
            <li key={d.party_id} className="flex flex-wrap items-center justify-between gap-2">
              <span><Link className="font-medium text-brand" href={`/cadastros/${d.party_id}`}>{d.display_name}</Link> <span className="text-xs text-muted">({d.reason})</span></span>
              <form action={mergePartiesAction} className="flex items-center gap-1">
                <input type="hidden" name="id" value={id} /><input type="hidden" name="dup" value={d.party_id} />
                <input name="confirm" required placeholder="digite MESCLAR" aria-label={`Confirmar a mesclagem de ${d.display_name}`} className={`${inputClass} w-36 py-1 text-xs`} />
                <Button variant="danger" className="px-2 py-1 text-xs">Mesclar aqui</Button>
              </form>
            </li>
          ))}</ul>
        </Card>
      )}
    </>
  );
}
