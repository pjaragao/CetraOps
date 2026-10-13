import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash, fmtDate } from "@/components/form";
import { updateStoreAction, updateStoreAddressAction } from "../actions";

export const metadata = { title: "Loja" };

const FORMAT: Record<string, string> = { SHOP_IN_SHOP: "Shop-in-shop", CONSIGNMENT_CORNER: "Corner em consignação", POPUP: "Pop-up", DIGITAL: "Digital", WAREHOUSE: "Depósito", B2B: "B2B" };
const STATUS: Record<string, string> = { PLANNED: "Planejada", ACTIVE: "Ativa", CLOSED: "Fechada" };

export default async function LojaPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  await requirePerm("core.admin");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: s } = await supabase.schema("core").from("stores").select("*").eq("id", id).maybeSingle();
  if (!s) notFound();
  const addr = ((s as { address?: unknown }).address ?? {}) as Record<string, string | undefined>;
  const [{ data: entity }, { data: cc }, { data: registers }, { data: locations }, { data: banks }] = await Promise.all([
    supabase.schema("core").from("legal_entities").select("razao_social, nome_fantasia, cnpj").eq("id", s.legal_entity_id).maybeSingle(),
    s.cost_center_id ? supabase.schema("core").from("cost_centers").select("id, code, name").eq("id", s.cost_center_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.schema("sales").from("cash_registers").select("id, name, active").eq("store_id", id).order("name"),
    supabase.schema("inv").from("locations").select("id, name, kind, is_sellable").eq("store_id", id).order("name"),
    supabase.schema("fin").from("bank_accounts").select("id, name").eq("store_id", id).order("name"),
  ]);

  return (
    <>
      <PageHeader title={s.name} description={`Código ${s.code} · ${FORMAT[s.format] ?? s.format} · ${entity?.nome_fantasia ?? entity?.razao_social ?? ""}`}
        actions={<Link href="/configuracoes" className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Empresas & lojas</Link>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 flex flex-wrap gap-2"><Badge tone={s.status === "ACTIVE" ? "success" : "neutral"}>{STATUS[s.status] ?? s.status}</Badge>{s.opened_at && <span className="text-sm text-muted">aberta em {fmtDate(s.opened_at)}</span>}{s.closed_at && <span className="text-sm text-muted">· fechada em {fmtDate(s.closed_at)}</span>}</div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Financeiro">
          <ul className="space-y-1.5 text-sm">
            <li className="flex justify-between gap-2"><span className="text-muted">Empresa (CNPJ)</span><span>{entity?.cnpj ?? "—"}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Centro de custo</span><span>{cc ? <Link href="/configuracoes/centros-de-custo" className="text-brand">{cc.code} · {cc.name}</Link> : "—"}</span></li>
            <li className="flex justify-between gap-2"><span className="text-muted">Contas / caixas</span><span className="text-right">{(banks ?? []).map((b) => <Link key={b.id} href={`/configuracoes/contas-bancarias/${b.id}`} className="block text-brand">{b.name}</Link>)}{(banks ?? []).length === 0 && "—"}</span></li>
          </ul>
        </Card>
        <Card title="Caixas (PDV)"><ul className="space-y-1 text-sm">{(registers ?? []).map((r) => <li key={r.id}>{r.name}{!r.active && <span className="ml-1 text-xs text-muted">(inativo)</span>}</li>)}{(registers ?? []).length === 0 && <li className="text-muted">Nenhum</li>}</ul></Card>
        <Card title="Locais de estoque"><ul className="space-y-1 text-sm">{(locations ?? []).map((l) => <li key={l.id}>{l.name}{!l.is_sellable && <span className="ml-1 text-xs text-muted">(não vende)</span>}</li>)}{(locations ?? []).length === 0 && <li className="text-muted">Nenhum</li>}</ul></Card>
      </div>
      <Card className="mt-4" title="Editar">
        <form action={updateStoreAction} className="grid gap-3 sm:grid-cols-6">
          <input type="hidden" name="id" value={s.id} />
          <Field label="Nome" className="sm:col-span-2"><input name="name" required minLength={2} maxLength={80} defaultValue={s.name} className={inputClass} /></Field>
          <Field label="Formato"><select name="format" defaultValue={s.format} className={inputClass}>{Object.entries(FORMAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Situação"><select name="status" defaultValue={s.status} className={inputClass}>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Aberta em"><input name="opened_at" type="date" defaultValue={s.opened_at ?? ""} className={inputClass} /></Field>
          <Field label="Fechada em" hint="Só se fechada"><input name="closed_at" type="date" defaultValue={s.closed_at ?? ""} className={inputClass} /></Field>
          <Field label="Área (m²)"><input name="area_m2" inputMode="decimal" defaultValue={s.area_m2 ?? ""} className={inputClass} /></Field>
          <div className="sm:col-span-5 self-end text-xs text-muted">O código ({s.code}) e a empresa não mudam: estão nas notas fiscais, no estoque e no centro de custo. O nome do centro de custo acompanha o da loja.</div>
          <div className="sm:col-span-6"><Button>Salvar loja</Button></div>
        </form>
      </Card>
      <Card className="mt-4" title="Endereço para as clientes">
        <form action={updateStoreAddressAction} className="grid gap-3 sm:grid-cols-6">
          <input type="hidden" name="id" value={s.id} />
          <Field label="Rua" className="sm:col-span-3"><input name="street" maxLength={120} defaultValue={addr.street ?? ""} className={inputClass} /></Field>
          <Field label="Número"><input name="number" maxLength={20} defaultValue={addr.number ?? ""} className={inputClass} /></Field>
          <Field label="Complemento" className="sm:col-span-2"><input name="complement" maxLength={120} defaultValue={addr.complement ?? ""} className={inputClass} /></Field>
          <Field label="Bairro" className="sm:col-span-2"><input name="district" maxLength={120} defaultValue={addr.district ?? ""} className={inputClass} /></Field>
          <Field label="Cidade" className="sm:col-span-2"><input name="city" maxLength={120} defaultValue={addr.city ?? ""} className={inputClass} /></Field>
          <Field label="UF"><input name="uf" maxLength={2} defaultValue={addr.uf ?? ""} className={inputClass} /></Field>
          <Field label="CEP"><input name="cep" maxLength={9} defaultValue={addr.cep ?? ""} className={inputClass} /></Field>
          <Field label="Como chegar" hint="ex.: dentro do JOY Wellness Club, 2º andar" className="sm:col-span-6"><input name="reference" maxLength={120} defaultValue={addr.reference ?? ""} className={inputClass} /></Field>
          <div className="sm:col-span-6 flex items-center gap-3"><Button>Salvar endereço</Button><span className="text-xs text-muted">É o endereço que a assistente do atendimento passa às clientes, junto com o horário da loja.</span></div>
        </form>
      </Card>
    </>
  );
}
