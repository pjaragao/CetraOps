import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { SEGMENTS, STAGE_LABEL, TIER_LABEL } from "@centralops/domain";
import { Badge, Empty, inputClass, PageHeader, Pager, Table } from "@/components/ui";

export const metadata = { title: "Clientes" };

const STAGES = ["LEAD", "PROSPECT", "CUSTOMER", "VIP", "INACTIVE", "LOST"] as const;
const PAGE = 100;

export default async function ClientesPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  await requirePerm("crm.read");
  const supabase = await createClient();
  const q = (str(sp.q) ?? "").replace(/[%,()]/g, " ").trim();
  const stage = str(sp.estagio);
  const papel = str(sp.papel) ?? "clientes";
  const segmento = str(sp.segmento);
  const risco = str(sp.risco) === "1";
  const aniversario = str(sp.aniversario) === "hoje" ? "hoje" : str(sp.aniversario) === "mes" ? "mes" : "";
  const page = Math.max(1, Number(str(sp.p)) || 1);
  // clientes e leads: fora quem só é colaborador, fornecedor ou prestador (cadastro único, mas cada tela mostra o seu público)
  const { data: internal } = papel === "clientes"
    ? await supabase.schema("crm").from("party_roles").select("party_id").in("role", ["EMPLOYEE", "SUPPLIER", "SERVICE_PROVIDER", "CARRIER", "ACQUIRER", "BANK"])
    : { data: [] as { party_id: string }[] };
  const { data: byRole } = papel !== "clientes" && papel !== "todos"
    ? await supabase.schema("crm").from("party_roles").select("party_id").eq("role", papel === "fornecedores" ? "SUPPLIER" : papel === "colaboradores" ? "EMPLOYEE" : "AFFILIATE_TRAINER")
    : { data: null };

  // aniversariantes: mesma regra do resumo do dia (cliente com aniversário hoje ou neste mês)
  const { data: birthdayIds } = aniversario ? await supabase.schema("crm").rpc("birthday_party_ids", { p_scope: aniversario === "hoje" ? "today" : "month" }) : { data: null };
  let query = supabase.schema("crm").from("parties")
    .select("id, display_name, city, birth_date, lifecycle_stage, tier, lead_score, last_purchase_at, tags, party_roles(role)", { count: "exact" })
    .is("merged_into_id", null).is("anonymized_at", null)
    .order("lead_score", { ascending: false }).order("display_name").order("id").range((page - 1) * PAGE, page * PAGE - 1);
  if (q) query = query.ilike("display_name", `%${q}%`);
  if (stage && (STAGES as readonly string[]).includes(stage)) query = query.eq("lifecycle_stage", stage as (typeof STAGES)[number]);
  // Um único filtro por id: quem vale (aniversário, papel, segmento, risco) menos quem é só colaborador/fornecedor/etc.
  const hide = new Set((internal ?? []).map((r) => r.party_id));
  let allow: string[] | null = null;
  const narrow = (ids: string[]) => { allow = allow ? allow.filter((x) => ids.includes(x)) : [...new Set(ids)]; };
  if (aniversario) narrow(birthdayIds ?? []);
  if (byRole) narrow(byRole.map((r) => r.party_id));
  if ((segmento && SEGMENTS[segmento]) || risco) {
    let mq = supabase.schema("crm").from("customer_metrics").select("party_id").limit(5000);
    if (segmento && SEGMENTS[segmento]) mq = mq.eq("rfm_segment", segmento);
    if (risco) mq = mq.eq("at_risk", true);
    const { data: ms } = await mq;
    narrow((ms ?? []).map((m) => m.party_id));
  }
  if (allow) query = query.in("id", (allow as string[]).filter((x) => !hide.has(x)).concat(["00000000-0000-0000-0000-000000000000"]));
  else if (hide.size) query = query.not("id", "in", `(${[...hide].join(",")})`);
  const { data: parties, count, error } = await query;

  return (
    <>
      <PageHeader title="Clientes & Leads" description="Cadastro único: a mesma pessoa é lead, cliente, fornecedora ou afiliada — sem duplicidade." />
      <form className="mb-4 flex flex-wrap items-center gap-2">
        <input name="q" defaultValue={q} placeholder="Buscar por nome" className={`${inputClass} max-w-[11rem]`} aria-label="Buscar" />
        <select name="estagio" defaultValue={stage ?? ""} className={`${inputClass} max-w-[150px]`} aria-label="Estágio">
          <option value="">Todos os estágios</option>
          {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </select>
        <select name="papel" defaultValue={papel} className={`${inputClass} max-w-[150px]`} aria-label="Público">
          <option value="clientes">Clientes e leads</option><option value="fornecedores">Fornecedores</option><option value="colaboradores">Colaboradores</option><option value="afiliadas">Afiliadas / trainers</option><option value="todos">Todos</option>
        </select>
        <select name="segmento" defaultValue={segmento ?? ""} className={`${inputClass} max-w-[160px]`} aria-label="Segmento">
          <option value="">Todos os segmentos</option>
          {Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select name="aniversario" defaultValue={aniversario} className={`${inputClass} max-w-[165px]`} aria-label="Aniversário">
          <option value="">Qualquer aniversário</option><option value="hoje">Aniversário hoje</option><option value="mes">Aniversário no mês</option>
        </select>
        <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-sm"><input type="checkbox" name="risco" value="1" defaultChecked={risco} /> Só em risco</label>
        <button className="shrink-0 rounded-lg border border-border px-3 py-2 text-sm">Filtrar</button>
      </form>
      {error && <p className="mb-3 text-sm text-danger">Não foi possível carregar a lista: {error.message}</p>}
      {(parties ?? []).length === 0 ? <Empty title="Nenhuma pessoa encontrada">Clientes entram pelo PDV, pela inbox ou por importação.</Empty> : (
        <Table head={["Nome", "Estágio", "Score", "Cidade", "Aniversário", "Última compra", "Papéis"]}>
          {(parties ?? []).map((p) => (
            <tr key={p.id} className="hover:bg-surface-2">
              <td className="px-3 py-2"><Link href={`/clientes/${p.id}`} className="font-medium text-brand">{p.display_name}</Link>{p.tier !== "STANDARD" && <span className="ml-2"><Badge tone="warning">{TIER_LABEL[p.tier]}</Badge></span>}</td>
              <td className="px-3 py-2"><Badge tone="brand">{STAGE_LABEL[p.lifecycle_stage]}</Badge></td>
              <td className="px-3 py-2">{p.lead_score}</td>
              <td className="px-3 py-2">{p.city ?? "—"}</td>
              <td className="px-3 py-2">{p.birth_date ? p.birth_date.slice(5).split("-").reverse().join("/") : "—"}</td>
              <td className="px-3 py-2">{p.last_purchase_at ? new Date(p.last_purchase_at).toLocaleDateString("pt-BR") : "—"}</td>
              <td className="px-3 py-2 text-xs text-muted">{(p.party_roles ?? []).map((r) => r.role).join(", ")}</td>
            </tr>
          ))}
        </Table>
      )}
      <Pager path="/clientes" params={{ q: q || undefined, estagio: stage, papel: papel === "clientes" ? undefined : papel, segmento, risco: risco ? "1" : undefined, aniversario: aniversario || undefined }} page={page} pageSize={PAGE} total={count ?? 0} />
    </>
  );
}
