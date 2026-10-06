import Link from "next/link";
import { EDITABLE_ROLES, PARTY_ROLE_LABEL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Empty, inputClass, LinkButton, PageHeader, Pager, Table } from "@/components/ui";

const PAGE = 100;

/** Lista de pessoas ou de empresas do cadastro único, com busca por nome, CPF/CNPJ, telefone ou e-mail, filtro por papel e paginação. */
export async function PartyList({ kind, searchParams }: { kind: "PERSON" | "COMPANY"; searchParams: SP }) {
  const session = await requirePerm("crm.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const q = (str(sp.q) ?? "").replace(/[%,()]/g, " ").trim();
  const role = str(sp.papel);
  const page = Math.max(1, Number(str(sp.p)) || 1);

  // role_filter: o mesmo vínculo de papéis, só para filtrar (party_roles continua trazendo todos os papéis para os selos)
  let query = supabase.schema("crm").from("parties")
    .select("id, display_name, legal_name, cnpj, city, uf, lifecycle_stage, created_at, party_roles(role), party_contact_points(type, value_display, is_primary), role_filter:party_roles(role)", { count: "exact" })
    .eq("kind", kind).is("merged_into_id", null).is("anonymized_at", null).order("display_name").order("id").range((page - 1) * PAGE, page * PAGE - 1);
  if (q) {
    const digits = q.replace(/\D/g, "");
    if (digits.length >= 6) {
      const { data: cps } = await supabase.schema("crm").from("party_contact_points").select("party_id").like("value_normalized", `%${digits}%`).limit(50);
      const { data: byDoc } = kind === "COMPANY" ? await supabase.schema("crm").from("parties").select("id").like("cnpj", `${digits}%`).limit(20) : { data: [] as { id: string }[] };
      const byCpf = kind === "PERSON" && digits.length === 11 ? ((await supabase.schema("crm").rpc("find_by_cpf", { p_cpf: digits })).data as { party_id?: string } | null)?.party_id : undefined;
      const ids = [...new Set([...(cps ?? []).map((c) => c.party_id), ...(byDoc ?? []).map((d) => d.id), ...(byCpf ? [byCpf] : [])])];
      query = query.in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    } else if (q.includes("@")) {
      const { data: cps } = await supabase.schema("crm").from("party_contact_points").select("party_id").eq("type", "EMAIL").ilike("value_normalized", `%${q.toLowerCase()}%`).limit(50);
      query = query.in("id", (cps ?? []).length ? (cps ?? []).map((c) => c.party_id) : ["00000000-0000-0000-0000-000000000000"]);
    } else {
      query = query.or(`display_name.ilike.%${q}%,legal_name.ilike.%${q}%`);
    }
  }
  // filtro por papel no próprio join (lista de ids na URL estoura o limite do gateway quando há centenas de cadastros)
  if (role && (EDITABLE_ROLES as readonly string[]).includes(role)) query = query.eq("role_filter.role", role as "CUSTOMER").not("role_filter", "is", null);
  const { data: parties, count } = await query;
  const title = kind === "PERSON" ? "Pessoas" : "Empresas";

  return (
    <>
      <PageHeader title={title} description={kind === "PERSON"
        ? "Cadastro único: a mesma pessoa pode ser cliente, afiliada, prestadora ou colaboradora, sem duplicar. Aqui se cria e se corrige o cadastro; a ficha comercial (compras, score, avise-me) fica em Clientes."
        : "Fornecedores, academias parceiras, transportadoras e outras empresas. O CNPJ preenche a razão social e o endereço."}
        actions={can(session, "crm.write") ? <LinkButton href={`/cadastros/novo?tipo=${kind === "PERSON" ? "pessoa" : "empresa"}`}>{kind === "PERSON" ? "Nova pessoa" : "Nova empresa"}</LinkButton> : undefined} />
      <form className="mb-4 flex flex-wrap gap-2">
        <input name="q" defaultValue={q} placeholder={kind === "PERSON" ? "Nome, CPF, telefone ou e-mail" : "Nome, CNPJ, telefone ou e-mail"} className={`${inputClass} max-w-xs`} aria-label="Buscar" />
        <select name="papel" defaultValue={role ?? ""} className={`${inputClass} max-w-[200px]`} aria-label="Papel">
          <option value="">Todos os papéis</option>{EDITABLE_ROLES.map((r) => <option key={r} value={r}>{PARTY_ROLE_LABEL[r]}</option>)}
        </select>
        <button className="rounded-lg border border-border px-3 text-sm">Filtrar</button>
      </form>
      {(parties ?? []).length === 0 ? <Empty title={`Nenhum${kind === "PERSON" ? "a pessoa" : "a empresa"} encontrada`}>Mude a busca ou crie um cadastro novo.</Empty> : (
        <Table head={kind === "PERSON" ? ["Nome", "Papéis", "Contato", "Cidade"] : ["Nome", "CNPJ", "Papéis", "Contato", "Cidade"]}>
          {(parties ?? []).map((p) => {
            const main = (p.party_contact_points ?? []).find((c) => c.is_primary) ?? (p.party_contact_points ?? [])[0];
            return (
              <tr key={p.id} className="hover:bg-surface-2">
                <td className="px-3 py-2"><Link href={`/cadastros/${p.id}`} className="font-medium text-brand">{p.display_name}</Link>{p.legal_name && p.legal_name !== p.display_name && <span className="block text-xs text-muted">{p.legal_name}</span>}</td>
                {kind === "COMPANY" && <td className="px-3 py-2 font-mono text-xs">{p.cnpj ? p.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : "—"}</td>}
                <td className="px-3 py-2"><div className="flex flex-wrap gap-1">{(p.party_roles ?? []).map((r) => <Badge key={r.role}>{PARTY_ROLE_LABEL[r.role] ?? r.role}</Badge>)}</div></td>
                <td className="px-3 py-2 text-xs">{main?.value_display ?? "—"}</td>
                <td className="px-3 py-2 text-xs">{p.city ? `${p.city}${p.uf ? `/${p.uf}` : ""}` : "—"}</td>
              </tr>
            );
          })}
        </Table>
      )}
      <Pager path={kind === "PERSON" ? "/cadastros/pessoas" : "/cadastros/empresas"} params={{ q: q || undefined, papel: role }} page={page} pageSize={PAGE} total={count ?? 0} />
    </>
  );
}
