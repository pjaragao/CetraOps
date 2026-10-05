import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { deleteRoleAction, saveRoleAction } from "../usuarios/actions";

export const metadata = { title: "Perfis de acesso" };

interface Perm { key: string; area: string; label: string; description: string; position: number }

function PermissionGrid({ catalog, checked }: { catalog: Perm[]; checked: Set<string> }) {
  const areas = [...new Set(catalog.map((p) => p.area))];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {areas.map((a) => (
        <fieldset key={a} className="rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-semibold">{a}</legend>
          {catalog.filter((p) => p.area === a).map((p) => (
            <label key={p.key} className="flex items-start gap-2 py-1 text-sm">
              <input type="checkbox" name="permissions" value={p.key} defaultChecked={checked.has(p.key)} className="mt-0.5" />
              <span>{p.label}<span className="block text-xs text-muted">{p.description}</span></span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

export default async function PerfisPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("core.admin");
  const sp = await searchParams;
  const supabase = await createClient();
  const [{ data: catalog }, { data: roles }, { data: memberRoles }] = await Promise.all([
    supabase.schema("core").from("permission_catalog").select("key, area, label, description, position").order("position"),
    supabase.schema("core").from("roles").select("id, name, is_superuser, role_permissions(permission_key)").order("is_superuser", { ascending: false }).order("name"),
    supabase.schema("core").from("member_roles").select("role_id"),
  ]);
  const used = new Map<string, number>();
  for (const m of memberRoles ?? []) used.set(m.role_id, (used.get(m.role_id) ?? 0) + 1);
  const open = str(sp.perfil);

  return (
    <>
      <PageHeader title="Perfis de acesso" description="Um perfil é um conjunto de permissões (ex.: Vendedora, Financeiro). Cada usuário recebe um ou mais perfis em Usuários & permissões. Mudanças valem para todos que têm o perfil." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="space-y-3">
        {(roles ?? []).map((r) => {
          const perms = new Set((r.role_permissions ?? []).map((p) => p.permission_key));
          return (
            <details key={r.id} open={open === r.id} className="rounded-xl border border-border bg-surface p-4">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                <span className="font-medium">{r.name}</span>
                {r.is_superuser ? <Badge tone="info">acesso total</Badge> : <Badge>{perms.size} permissões</Badge>}
                <span className="text-xs text-muted">{used.get(r.id) ?? 0} usuário(s)</span>
              </summary>
              {r.is_superuser ? (
                <form action={saveRoleAction} className="mt-3 flex flex-wrap items-end gap-2">
                  <p className="w-full text-sm text-muted">Este perfil tem todas as permissões, inclusive as que forem criadas no futuro. Dê só aos sócios.</p>
                  <input type="hidden" name="id" value={r.id} />
                  <Field label="Nome"><input name="name" required defaultValue={r.name} className={`${inputClass} w-64`} /></Field>
                  <Button variant="secondary">Renomear</Button>
                </form>
              ) : (
                <>
                  <form action={saveRoleAction} className="mt-3 space-y-3">
                    <input type="hidden" name="id" value={r.id} />
                    <Field label="Nome do perfil"><input name="name" required minLength={3} defaultValue={r.name} className={`${inputClass} w-64`} /></Field>
                    <PermissionGrid catalog={(catalog ?? []) as Perm[]} checked={perms} />
                    <Button>Salvar perfil</Button>
                  </form>
                  {!used.get(r.id) && (
                    <form action={deleteRoleAction} className="mt-2"><input type="hidden" name="id" value={r.id} /><Button variant="ghost" className="text-danger">Apagar perfil</Button></form>
                  )}
                </>
              )}
            </details>
          );
        })}
      </div>

      <Card className="mt-6" title="Novo perfil">
        <form action={saveRoleAction} className="space-y-3">
          <Field label="Nome do perfil"><input name="name" required minLength={3} placeholder="Gerente de loja" className={`${inputClass} w-64`} /></Field>
          <PermissionGrid catalog={(catalog ?? []) as Perm[]} checked={new Set()} />
          <Button>Criar perfil</Button>
        </form>
      </Card>
    </>
  );
}
