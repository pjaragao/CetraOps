import Link from "next/link";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { AccessFields } from "./access-fields";
import { createUserAction } from "./actions";
import { loadAdminData, when } from "./data";

export const metadata = { title: "Usuários & permissões" };

export default async function UsuariosPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("core.admin");
  const sp = await searchParams;
  const { users, roles, stores, error } = await loadAdminData();
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const storeName = new Map(stores.map((s) => [s.id, s.name]));

  return (
    <>
      <PageHeader title="Usuários & permissões" description="Quem entra no sistema e o que cada pessoa pode ver e fazer. O que a pessoa pode fazer vem dos perfis de acesso; as lojas limitam quais dados ela vê." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro) ?? error} />
      <Table head={["Pessoa", "E-mail", "Perfis", "Lojas", "Último acesso", "Situação", ""]}>
        {users.map((u) => (
          <tr key={u.id}>
            <td className="px-3 py-2 font-medium">{u.display_name}{u.id === session.memberId && <span className="ml-1 text-xs text-muted">(você)</span>}</td>
            <td className="px-3 py-2 text-sm">{u.email}</td>
            <td className="px-3 py-2 text-sm">{u.roles.map((r) => roleName.get(r)).filter(Boolean).join(", ") || "—"}</td>
            <td className="px-3 py-2 text-sm">{u.all_stores ? "Todas" : u.stores.map((s) => storeName.get(s)).join(", ")}</td>
            <td className="px-3 py-2 text-xs text-muted">{when(u.last_sign_in_at)}</td>
            <td className="px-3 py-2">{u.status === "ACTIVE" ? (u.must_change_password ? <Badge tone="warning">aguardando 1º acesso</Badge> : <Badge tone="success">ativo</Badge>) : <Badge tone="danger">suspenso</Badge>}</td>
            <td className="px-3 py-2"><Link href={`/configuracoes/usuarios/${u.id}`} className="text-sm text-brand">Editar</Link></td>
          </tr>
        ))}
      </Table>

      <Card className="mt-6" title="Novo usuário">
        <p className="mb-3 text-sm text-muted">Você define uma senha provisória e passa à pessoa junto com o e-mail. No primeiro acesso o sistema pede que ela crie a própria senha.</p>
        <form action={createUserAction} className="grid gap-3 sm:grid-cols-2">
          <Field label="Nome"><input name="display_name" required minLength={2} className={inputClass} placeholder="Luisa" /></Field>
          <Field label="E-mail de acesso"><input name="email" type="email" required autoComplete="off" className={inputClass} /></Field>
          <Field label="Senha provisória" hint="Ao menos 8 caracteres, com letras e números"><input name="password" type="text" required minLength={8} autoComplete="off" className={inputClass} /></Field>
          <div />
          <AccessFields roles={roles} stores={stores} />
          <div className="sm:col-span-2"><Button>Criar usuário</Button></div>
        </form>
      </Card>
    </>
  );
}
