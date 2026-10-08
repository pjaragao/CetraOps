import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, todayIsoSP, type SP } from "@/lib/context";
import { SEGMENTS, STAGE_LABEL, TIER_LABEL } from "@centralops/domain";
import { Badge, Button, Empty, inputClass, PageHeader, Pager, Table } from "@/components/ui";
import { createCampaignFromClientsAction, createSegmentFromClientsAction } from "./actions";

export const metadata = { title: "Clientes" };

const STAGES = ["LEAD", "PROSPECT", "CUSTOMER", "VIP", "INACTIVE", "LOST"] as const;
const PAGE = 100;
const ROLE_FILTER: Record<string, string> = { fornecedores: "SUPPLIER", colaboradores: "EMPLOYEE", afiliadas: "AFFILIATE_TRAINER" };
// coluna da tela → coluna da visão (aniversário ordena por mês-dia)
const SORTS = { nome: "display_name", estagio: "lifecycle_stage", score: "lead_score", cidade: "city", aniversario: "birth_md", compra: "last_purchase_at" } as const;
type SortKey = keyof typeof SORTS;

export default async function ClientesPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const session = await requirePerm("crm.read");
  const canWrite = can(session, "crm.write");
  const supabase = await createClient();
  const q = (str(sp.q) ?? "").replace(/[%,()]/g, " ").trim();
  const stage = str(sp.estagio);
  const papel = str(sp.papel) ?? "clientes";
  const segmento = str(sp.segmento);
  const risco = str(sp.risco) === "1";
  const aniversario = str(sp.aniversario) === "hoje" ? "hoje" : str(sp.aniversario) === "mes" ? "mes" : "";
  const ordem: SortKey = (str(sp.ordem) ?? "") in SORTS ? (str(sp.ordem) as SortKey) : "aniversario";
  const dir = str(sp.dir) === "desc" ? "desc" : "asc";
  const page = Math.max(1, Number(str(sp.p)) || 1);
  const today = todayIsoSP();

  // Filtros por coluna da visão (sem listas de ids na URL)
  let query = supabase.schema("crm").from("v_people_list")
    .select("id, display_name, city, birth_date, lifecycle_stage, tier, lead_score, last_purchase_at, roles", { count: "exact" })
    .order(SORTS[ordem], { ascending: dir === "asc", nullsFirst: false });
  if (ordem !== "nome") query = query.order("display_name");
  query = query.order("id").range((page - 1) * PAGE, page * PAGE - 1);
  if (q) query = query.ilike("display_name", `%${q}%`);
  if (stage && (STAGES as readonly string[]).includes(stage)) query = query.eq("lifecycle_stage", stage as (typeof STAGES)[number]);
  // clientes e leads: fora quem é colaborador, fornecedor ou prestador (cadastro único, mas cada tela mostra o seu público)
  if (papel === "clientes") query = query.eq("is_internal", false);
  else if (ROLE_FILTER[papel]) query = query.contains("roles", [ROLE_FILTER[papel]]);
  if (segmento && SEGMENTS[segmento]) query = query.eq("rfm_segment", segmento);
  if (risco) query = query.eq("at_risk", true);
  // aniversariantes: mesma regra do resumo do dia (quem é cliente, aniversário hoje ou neste mês)
  if (aniversario) {
    query = query.contains("roles", ["CUSTOMER"]).eq("is_internal", false);
    query = aniversario === "hoje" ? query.eq("birth_md", today.slice(5)) : query.like("birth_md", `${today.slice(5, 7)}-%`);
  }
  const { data: parties, count, error } = await query;

  const params = { q: q || undefined, estagio: stage, papel: papel === "clientes" ? undefined : papel, segmento, risco: risco ? "1" : undefined, aniversario: aniversario || undefined };
  const sortHref = (k: SortKey) => {
    const u = new URLSearchParams(Object.entries({ ...params, ordem: k, dir: ordem === k && dir === "asc" ? "desc" : "asc" }).filter((e): e is [string, string] => Boolean(e[1])));
    return `/clientes?${u.toString()}`;
  };
  const th = (k: SortKey, label: string) => (
    <Link href={sortHref(k)} className="inline-flex items-center gap-1 hover:text-text" aria-sort={ordem === k ? (dir === "asc" ? "ascending" : "descending") : undefined}>
      {label}<span aria-hidden className={ordem === k ? "text-brand" : "opacity-30"}>{ordem === k && dir === "desc" ? "↓" : "↑"}</span>
    </Link>
  );
  const control = `${inputClass.replace("w-full", "")} min-w-[9rem] flex-1 basis-0`;   // ocupa a linha toda, dividindo o espaço

  return (
    <>
      <PageHeader
        title="Clientes & Leads"
        description="Cadastro único: a mesma pessoa é lead, cliente, fornecedora ou afiliada — sem duplicidade."
        actions={
          canWrite ? (
            <div className="flex flex-wrap items-center gap-2">
              <form action={createCampaignFromClientsAction}>
                {stage && <input type="hidden" name="estagio" value={stage} />}
                <Button variant="secondary" className="px-2 py-1 text-xs">Criar campanha</Button>
              </form>
              <form action={createSegmentFromClientsAction}>
                {stage && <input type="hidden" name="estagio" value={stage} />}
                <Button variant="ghost" className="px-2 py-1 text-xs">Salvar como público</Button>
              </form>
            </div>
          ) : undefined
        }
      />
      <form className="mb-4 flex flex-wrap items-center gap-2">
        {ordem !== "aniversario" && <input type="hidden" name="ordem" value={ordem} />}
        {dir !== "asc" && <input type="hidden" name="dir" value={dir} />}
        <input name="q" defaultValue={q} placeholder="Buscar por nome" className={`${control} min-w-[12rem] flex-[2]`} aria-label="Buscar" />
        <select name="estagio" defaultValue={stage ?? ""} className={control} aria-label="Estágio">
          <option value="">Todos os estágios</option>
          {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </select>
        <select name="papel" defaultValue={papel} className={control} aria-label="Público">
          <option value="clientes">Clientes e leads</option><option value="fornecedores">Fornecedores</option><option value="colaboradores">Colaboradores</option><option value="afiliadas">Afiliadas / trainers</option><option value="todos">Todos</option>
        </select>
        <select name="segmento" defaultValue={segmento ?? ""} className={control} aria-label="Segmento">
          <option value="">Todos os segmentos</option>
          {Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select name="aniversario" defaultValue={aniversario} className={control} aria-label="Aniversário">
          <option value="">Qualquer aniversário</option><option value="hoje">Aniversário hoje</option><option value="mes">Aniversário no mês</option>
        </select>
        <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-sm"><input type="checkbox" name="risco" value="1" defaultChecked={risco} /> Só em risco</label>
        <button className="shrink-0 rounded-lg border border-border px-3 py-2 text-sm">Filtrar</button>
      </form>
      {error && <p className="mb-3 text-sm text-danger">Não foi possível carregar a lista. Tente de novo; se continuar, avise o suporte.</p>}
      {(parties ?? []).length === 0 ? <Empty title="Nenhuma pessoa encontrada">Clientes entram pelo PDV, pela inbox ou por importação.</Empty> : (
        <Table head={[th("nome", "Nome"), th("estagio", "Estágio"), th("score", "Score"), th("cidade", "Cidade"), th("aniversario", "Aniversário"), th("compra", "Última compra"), "Papéis"]}>
          {(parties ?? []).map((p) => (
            <tr key={p.id} className="hover:bg-surface-2">
              <td className="px-3 py-2"><Link href={`/clientes/${p.id}`} className="font-medium text-brand">{p.display_name}</Link>{p.tier && p.tier !== "STANDARD" && <span className="ml-2"><Badge tone="warning">{TIER_LABEL[p.tier]}</Badge></span>}</td>
              <td className="px-3 py-2">{p.lifecycle_stage && <Badge tone="brand">{STAGE_LABEL[p.lifecycle_stage]}</Badge>}</td>
              <td className="px-3 py-2">{p.lead_score}</td>
              <td className="px-3 py-2">{p.city ?? "—"}</td>
              <td className="px-3 py-2">{p.birth_date ? p.birth_date.slice(5).split("-").reverse().join("/") : "—"}</td>
              <td className="px-3 py-2">{p.last_purchase_at ? new Date(p.last_purchase_at).toLocaleDateString("pt-BR") : "—"}</td>
              <td className="px-3 py-2 text-xs text-muted">{(p.roles ?? []).join(", ")}</td>
            </tr>
          ))}
        </Table>
      )}
      <Pager path="/clientes" params={{ ...params, ordem: ordem !== "aniversario" ? ordem : undefined, dir: dir !== "asc" ? dir : undefined }} page={page} pageSize={PAGE} total={count ?? 0} />
    </>
  );
}
