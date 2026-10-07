import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { AccessFields } from "../access-fields";
import { linkUserPartyAction, resetPasswordAction, setUserStatusAction, updateUserAction } from "../actions";
import { loadAdminData, ROLE_LABEL, searchPeople, when } from "../data";

export const metadata = { title: "Usuário" };

export default async function UsuarioPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("core.admin");
  const { id } = await params;
  const sp = await searchParams;
  const { users, roles, stores } = await loadAdminData();
  const u = users.find((x) => x.id === id);
  if (!u) notFound();
  const self = u.id === session.memberId;
  const buscar = str(sp.buscar) ?? "";
  const hits = await searchPeople(buscar);
  const taken = new Set(users.flatMap((x) => (x.party ? [x.party.id] : [])));

  return (
    <>
      <PageHeader title={u.display_name} description={`${u.email} · criado em ${when(u.created_at)} · último acesso ${when(u.last_sign_in_at)}`}
        actions={<Link href="/configuracoes/usuarios" className="text-sm text-brand">Voltar aos usuários</Link>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 flex flex-wrap gap-2">
        {u.status === "ACTIVE" ? <Badge tone="success">ativo</Badge> : <Badge tone="danger">suspenso</Badge>}
        {u.must_change_password && <Badge tone="warning">ainda com a senha provisória</Badge>}
        {u.employee && <Badge tone="info">colaborador: {u.employee.name}</Badge>}
        {u.party && <Link href={`/cadastros/${u.party.id}`} className="text-sm text-brand">Cadastro: {u.party.name}{u.party.shareholder ? " (sócio(a) da empresa)" : ""}</Link>}
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

      <Card className="mt-4" title="Pessoa no Cadastro">
        <p className="mb-3 text-sm text-muted">
          {u.party ? `Este usuário está ligado a ${u.party.name}.` : "Este usuário ainda não está ligado a uma pessoa."} Se a pessoa já existe no Cadastro com outro registro (por exemplo, como sócia), busque e ligue aqui:
          o cadastro criado automaticamente com o usuário é mesclado nele, e ela passa a ser uma só.
        </p>
        <form className="flex flex-wrap items-end gap-2">
          <Field label="Buscar no Cadastro"><input name="buscar" defaultValue={buscar} placeholder="Nome" className={`${inputClass} w-64`} /></Field>
          <Button variant="secondary">Buscar</Button>
        </form>
        {buscar.trim().length >= 2 && (hits.length === 0 ? <p className="mt-2 text-sm text-muted">Ninguém com esse nome no Cadastro.</p> : (
          <ul className="mt-2 space-y-2 text-sm">{hits.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{h.name}</span><span className="text-xs text-muted">{[h.city, ...h.roles.map((r) => ROLE_LABEL[r]).filter(Boolean)].filter(Boolean).join(" · ")}</span>
              {h.id === u.party?.id ? <Badge tone="info">pessoa atual</Badge> : taken.has(h.id) ? <Badge tone="neutral">já tem usuário</Badge> : (
                <form action={linkUserPartyAction}><input type="hidden" name="id" value={u.id} /><input type="hidden" name="party_id" value={h.id} /><Button variant="secondary" className="px-2 py-1 text-xs">Ligar a esta pessoa</Button></form>
              )}
            </li>
          ))}</ul>
        ))}
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
