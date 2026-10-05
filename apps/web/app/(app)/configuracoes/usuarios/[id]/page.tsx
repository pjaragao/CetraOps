import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { AccessFields } from "../access-fields";
import { resetPasswordAction, setUserStatusAction, updateUserAction } from "../actions";
import { loadAdminData, when } from "../data";

export const metadata = { title: "Usuário" };

export default async function UsuarioPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("core.admin");
  const { id } = await params;
  const sp = await searchParams;
  const { users, roles, stores } = await loadAdminData();
  const u = users.find((x) => x.id === id);
  if (!u) notFound();
  const self = u.id === session.memberId;

  return (
    <>
      <PageHeader title={u.display_name} description={`${u.email} · criado em ${when(u.created_at)} · último acesso ${when(u.last_sign_in_at)}`}
        actions={<Link href="/configuracoes/usuarios" className="text-sm text-brand">Voltar aos usuários</Link>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 flex flex-wrap gap-2">
        {u.status === "ACTIVE" ? <Badge tone="success">ativo</Badge> : <Badge tone="danger">suspenso</Badge>}
        {u.must_change_password && <Badge tone="warning">ainda com a senha provisória</Badge>}
        {u.employee && <Badge tone="info">colaborador: {u.employee.name}</Badge>}
      </div>

      <Card title="Acessos">
        <form action={updateUserAction} className="grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="id" value={u.id} />
          <Field label="Nome"><input name="display_name" required minLength={2} defaultValue={u.display_name} className={inputClass} /></Field>
          <div />
          <AccessFields roles={roles} stores={stores} value={u} />
          <div className="sm:col-span-2"><Button>Salvar acessos</Button></div>
        </form>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Senha">
          <p className="mb-3 text-sm text-muted">{self ? "Para trocar a sua senha use Minha conta (clique no seu nome no topo)." : "Defina uma nova senha provisória se a pessoa esqueceu a dela. As sessões abertas dela são encerradas e ela cria uma senha nova no próximo acesso."}</p>
          {!self && (
            <form action={resetPasswordAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={u.id} />
              <Field label="Nova senha provisória"><input name="password" type="text" required minLength={8} autoComplete="off" className={`${inputClass} w-56`} /></Field>
              <Button variant="secondary">Redefinir senha</Button>
            </form>
          )}
        </Card>
        <Card title={u.status === "ACTIVE" ? "Suspender acesso" : "Reativar acesso"}>
          <p className="mb-3 text-sm text-muted">{u.status === "ACTIVE" ? "A pessoa deixa de conseguir entrar e as sessões abertas são encerradas. O histórico (vendas, conversas, lançamentos) continua com o nome dela." : "A pessoa volta a entrar com a senha que já tinha."}</p>
          {self ? <p className="text-sm text-muted">Você não pode suspender a si mesmo.</p> : (
            <form action={setUserStatusAction}>
              <input type="hidden" name="id" value={u.id} /><input type="hidden" name="active" value={u.status === "ACTIVE" ? "0" : "1"} />
              <Button variant={u.status === "ACTIVE" ? "danger" : "primary"}>{u.status === "ACTIVE" ? "Suspender" : "Reativar"}</Button>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
