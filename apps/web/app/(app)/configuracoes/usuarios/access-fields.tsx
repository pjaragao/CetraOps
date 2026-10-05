import { inputClass } from "@/components/ui";
import { Field } from "@/components/form";

export interface RoleOpt { id: string; name: string; is_superuser: boolean; count: number }
export interface StoreOpt { id: string; name: string }

/** Campos de acesso (perfis, lojas e loja padrão), iguais na criação e na edição. */
export function AccessFields({ roles, stores, value }: {
  roles: RoleOpt[]; stores: StoreOpt[];
  value?: { roles: string[]; all_stores: boolean; stores: string[]; default_store_id: string | null };
}) {
  const v = value ?? { roles: [], all_stores: true, stores: [], default_store_id: stores[0]?.id ?? null };
  return (
    <>
      <fieldset className="sm:col-span-2">
        <legend className="mb-1 text-sm font-medium">Perfis de acesso</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {roles.map((r) => (
            <label key={r.id} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <input type="checkbox" name="roles" value={r.id} defaultChecked={v.roles.includes(r.id)} className="mt-0.5" />
              <span><b>{r.name}</b>{r.is_superuser ? <span className="block text-xs text-muted">Acesso total, inclusive administração</span> : <span className="block text-xs text-muted">{r.count} permissões</span>}</span>
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">Com mais de um perfil, a pessoa soma as permissões de todos. Ajuste os perfis em Configurações › Perfis de acesso.</p>
      </fieldset>
      <fieldset className="sm:col-span-2">
        <legend className="mb-1 text-sm font-medium">Lojas</legend>
        <label className="mb-1.5 flex items-center gap-2 text-sm"><input type="checkbox" name="all_stores" defaultChecked={v.all_stores} /> Todas as lojas (inclusive as que forem abertas depois)</label>
        <div className="flex flex-wrap gap-3">
          {stores.map((s) => <label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="stores" value={s.id} defaultChecked={v.stores.includes(s.id)} /> {s.name}</label>)}
        </div>
      </fieldset>
      <Field label="Loja padrão ao entrar">
        <select name="default_store_id" defaultValue={v.default_store_id ?? ""} className={inputClass}>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
    </>
  );
}
