import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { SEGMENTS, STAGE_LABEL, TIER_LABEL } from "@centralops/domain";
import { Badge, Empty, inputClass, PageHeader, Table } from "@/components/ui";

export const metadata = { title: "Clientes" };

const STAGES = ["LEAD", "PROSPECT", "CUSTOMER", "VIP", "INACTIVE", "LOST"] as const;

export default async function ClientesPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  await requirePerm("crm.read");
  const supabase = await createClient();
  const q = (str(sp.q) ?? "").replace(/[%,()]/g, " ").trim();
  const stage = str(sp.estagio);
  const papel = str(sp.papel) ?? "clientes";
  const segmento = str(sp.segmento);
  const risco = str(sp.risco) === "1";
  // clientes e leads: fora quem só é colaborador, fornecedor ou prestador (cadastro único, mas cada tela mostra o seu público)
  const { data: internal } = papel === "clientes"
    ? await supabase.schema("crm").from("party_roles").select("party_id").in("role", ["EMPLOYEE", "SUPPLIER", "SERVICE_PROVIDER", "CARRIER", "ACQUIRER", "BANK"])
    : { data: [] as { party_id: string }[] };
  const { data: byRole } = papel !== "clientes" && papel !== "todos"
    ? await supabase.schema("crm").from("party_roles").select("party_id").eq("role", papel === "fornecedores" ? "SUPPLIER" : papel === "colaboradores" ? "EMPLOYEE" : "AFFILIATE_TRAINER")
    : { data: null };

  let query = supabase.schema("crm").from("parties")
    .select("id, display_name, city, lifecycle_stage, tier, lead_score, last_purchase_at, tags, party_roles(role)")
    .is("merged_into_id", null).is("anonymized_at", null)
    .order("lead_score", { ascending: false }).order("display_name").limit(200);
  if (q) query = query.ilike("display_name", `%${q}%`);
  if (stage && (STAGES as readonly string[]).includes(stage)) query = query.eq("lifecycle_stage", stage as (typeof STAGES)[number]);
  const hide = [...new Set((internal ?? []).map((r) => r.party_id))];
  if (hide.length) query = query.not("id", "in", `(${hide.join(",")})`);
  if (byRole) query = query.in("id", byRole.length ? byRole.map((r) => r.party_id) : ["00000000-0000-0000-0000-000000000000"]);
  if ((segmento && SEGMENTS[segmento]) || risco) {
    let mq = supabase.schema("crm").from("customer_metrics").select("party_id").limit(5000);
    if (segmento && SEGMENTS[segmento]) mq = mq.eq("rfm_segment", segmento);
    if (risco) mq = mq.eq("at_risk", true);
    const { data: ms } = await mq;
    query = query.in("id", (ms ?? []).length ? (ms ?? []).map((m) => m.party_id) : ["00000000-0000-0000-0000-000000000000"]);
  }
  const { data: parties } = await query;

  return (
    <>
      <PageHeader title="Clientes & Leads" description="Cadastro único: a mesma pessoa é lead, cliente, fornecedora ou afiliada — sem duplicidade." />
      <form className="mb-4 flex flex-wrap gap-2">
        <input name="q" defaultValue={q} placeholder="Buscar por nome" className={`${inputClass} max-w-xs`} aria-label="Buscar" />
        <select name="estagio" defaultValue={stage ?? ""} className={`${inputClass} max-w-[180px]`} aria-label="Estágio">
          <option value="">Todos os estágios</option>
          {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </select>
        <select name="papel" defaultValue={papel} className={`${inputClass} max-w-[180px]`} aria-label="Público">
          <option value="clientes">Clientes e leads</option><option value="fornecedores">Fornecedores</option><option value="colaboradores">Colaboradores</option><option value="afiliadas">Afiliadas / trainers</option><option value="todos">Todos</option>
        </select>
        <select name="segmento" defaultValue={segmento ?? ""} className={`${inputClass} max-w-[200px]`} aria-label="Segmento">
          <option value="">Todos os segmentos</option>
          {Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="risco" value="1" defaultChecked={risco} /> Só em risco</label>
        <button className="rounded-lg border border-border px-3 text-sm">Filtrar</button>
      </form>
      {(parties ?? []).length === 0 ? <Empty title="Nenhuma pessoa encontrada">Clientes entram pelo PDV, pela inbox ou por importação.</Empty> : (
        <Table head={["Nome", "Estágio", "Score", "Cidade", "Última compra", "Papéis"]}>
          {(parties ?? []).map((p) => (
            <tr key={p.id} className="hover:bg-surface-2">
              <td className="px-3 py-2"><Link href={`/clientes/${p.id}`} className="font-medium text-brand">{p.display_name}</Link>{p.tier !== "STANDARD" && <span className="ml-2"><Badge tone="warning">{TIER_LABEL[p.tier]}</Badge></span>}</td>
              <td className="px-3 py-2"><Badge tone="brand">{STAGE_LABEL[p.lifecycle_stage]}</Badge></td>
              <td className="px-3 py-2">{p.lead_score}</td>
              <td className="px-3 py-2">{p.city ?? "—"}</td>
              <td className="px-3 py-2">{p.last_purchase_at ? new Date(p.last_purchase_at).toLocaleDateString("pt-BR") : "—"}</td>
              <td className="px-3 py-2 text-xs text-muted">{(p.party_roles ?? []).map((r) => r.role).join(", ")}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
