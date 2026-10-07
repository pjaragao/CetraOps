import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { AccessFields } from "./access-fields";
import { createUserAction } from "./actions";
import { loadAdminData, ROLE_LABEL, searchPeople, when } from "./data";

export const metadata = { title: "Usuários & permissões" };

export default async function UsuariosPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("core.admin");
  const sp = await searchParams;
  const { users, roles, stores, error } = await loadAdminData();
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const storeName = new Map(stores.map((s) => [s.id, s.name]));

  // Vindo da ficha da pessoa (Cadastros › Pessoa › Dar acesso ao sistema): o usuário nasce já ligado a ela
  const pessoa = str(sp.pessoa);
  let person: { id: string; name: string; email: string; shareholder: boolean } | null = null;
  if (pessoa) {
    const supabase = await createClient();
    const crm = supabase.schema("crm");
    const [{ data: p }, { data: email }, { data: sh }] = await Promise.all([
      crm.from("parties").select("id, display_name").eq("id", pessoa).eq("kind", "PERSON").maybeSingle(),
      crm.from("party_contact_points").select("value_display").eq("party_id", pessoa).eq("type", "EMAIL").order("is_primary", { ascending: false }).limit(1).maybeSingle(),
      crm.from("party_roles").select("role").eq("party_id", pessoa).eq("role", "SHAREHOLDER").maybeSingle(),
    ]);
    if (p) person = { id: p.id, name: p.display_name, email: email?.value_display ?? "", shareholder: Boolean(sh) };
  }

  const buscar = str(sp.buscar) ?? "";
  const hits = person ? [] : await searchPeople(buscar);
  const taken = new Set(users.flatMap((u) => (u.party ? [u.party.id] : [])));

  return (
    <>
      <PageHeader title="Usuários & permissões" description="Quem entra no sistema e o que pode ver e fazer. Cada usuário é uma pessoa do Cadastro: o que ela pode fazer vem dos perfis de acesso; as lojas limitam quais dados ela vê. Ser sócio(a) da empresa é marcado no Cadastro e não dá acesso por si só." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro) ?? error} />
      <Table head={["Pessoa", "E-mail", "Perfis", "Lojas", "Último acesso", "Situação", ""]}>
        {users.map((u) => (
          <tr key={u.id}>
            <td className="px-3 py-2 font-medium">
              {u.party ? <Link href={`/cadastros/${u.party.id}`} className="hover:underline">{u.display_name}</Link> : u.display_name}
              {u.id === session.memberId && <span className="ml-1 text-xs text-muted">(você)</span>}
              {u.party?.shareholder && <span className="ml-1"><Badge tone="info">sócio(a) da empresa</Badge></span>}
            </td>
            <td className="px-3 py-2 text-sm">{u.email}</td>
            <td className="px-3 py-2 text-sm">{u.roles.map((r) => roleName.get(r)).filter(Boolean).join(", ") || "—"}</td>
            <td className="px-3 py-2 text-sm">{u.all_stores ? "Todas" : u.stores.map((s) => storeName.get(s)).join(", ")}</td>
            <td className="px-3 py-2 text-xs text-muted">{when(u.last_sign_in_at)}</td>
            <td className="px-3 py-2">{u.status === "ACTIVE" ? (u.must_change_password ? <Badge tone="warning">aguardando 1º acesso</Badge> : <Badge tone="success">ativo</Badge>) : <Badge tone="danger">suspenso</Badge>}</td>
            <td className="px-3 py-2"><Link href={`/configuracoes/usuarios/${u.id}`} className="text-sm text-brand">Editar</Link></td>
          </tr>
        ))}
      </Table>

      <div id="novo" />
      <Card className="mt-6" title={person ? `Dar acesso ao sistema para ${person.name}` : "Novo usuário"}>
        <p className="mb-3 text-sm text-muted">
          {person
            ? `O usuário fica ligado ao cadastro de ${person.name}.${person.shareholder ? " Ela é sócia da empresa no cadastro, então o perfil de acesso total já vem marcado: desmarque se ela não deve administrar o sistema." : ""}`
            : "Busque primeiro a pessoa no Cadastro (abaixo): o usuário fica ligado a ela, sem duplicar. Só se ela não existir o sistema cria o cadastro."}
          {" "}Você define uma senha provisória e passa à pessoa junto com o e-mail; no primeiro acesso ela cria a própria senha.
        </p>
        {!person && (
          <div className="mb-4 rounded-lg border border-border p-3">
            <form className="flex flex-wrap items-end gap-2">
              <Field label="Pessoa do Cadastro"><input name="buscar" defaultValue={buscar} placeholder="Nome (ex.: Luisa)" className={`${inputClass} w-64`} /></Field>
              <Button variant="secondary">Buscar</Button>
            </form>
            {buscar.trim().length >= 2 && (hits.length === 0 ? <p className="mt-2 text-sm text-muted">Ninguém com esse nome no Cadastro: preencha abaixo para criar a pessoa junto com o usuário.</p> : (
              <ul className="mt-2 space-y-1 text-sm">{hits.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{h.name}</span><span className="text-xs text-muted">{[h.city, ...h.roles.map((r) => ROLE_LABEL[r]).filter(Boolean)].filter(Boolean).join(" · ")}</span>
                  {taken.has(h.id) ? <Badge tone="neutral">já tem usuário</Badge> : <Link href={`/configuracoes/usuarios?pessoa=${h.id}#novo`} className="text-brand">Dar acesso a esta pessoa</Link>}
                </li>
              ))}</ul>
            ))}
          </div>
        )}
        <form action={createUserAction} className="grid gap-3 sm:grid-cols-2">
          {person && <input type="hidden" name="party_id" value={person.id} />}
          <Field label="Nome"><input name="display_name" required minLength={2} defaultValue={person?.name ?? ""} className={inputClass} placeholder="Luisa" /></Field>
          <Field label="E-mail de acesso"><input name="email" type="email" required autoComplete="off" defaultValue={person?.email ?? ""} className={inputClass} /></Field>
          <Field label="Senha provisória" hint="Ao menos 8 caracteres, com letras e números"><input name="password" type="text" required minLength={8} autoComplete="off" className={inputClass} /></Field>
          <div />
          <AccessFields roles={roles} stores={stores} suggestSuperuser={person?.shareholder} />
          <div className="sm:col-span-2 flex gap-3">
            <Button>Criar usuário</Button>
            {person && <Link href="/configuracoes/usuarios" className="self-center text-sm text-muted">Criar sem ligar a {person.name}</Link>}
          </div>
        </form>
      </Card>
    </>
  );
}
