import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSession, requirePerm } from "@/lib/session";
import { Badge, Button, Card, inputClass, PageHeader, Table } from "@/components/ui";

export const metadata = { title: "Empresas & lojas" };

async function saveLegalEntity(formData: FormData) {
  "use server";
  const s = await getSession();
  const supabase = await createClient();
  const cnpj = String(formData.get("cnpj") || "").replace(/\D/g, "");
  await supabase.schema("core").from("legal_entities").insert({
    org_id: s.orgId, cnpj, razao_social: String(formData.get("razao_social")), nome_fantasia: String(formData.get("nome_fantasia") || "") || null,
    ie: String(formData.get("ie") || "") || null, cnae_principal: "4781400",
    cnaes_secundarios: ["4763602", "4782201", "4782202", "4772500", "4789099", "4642701", "7319002", "8230001"],
  });
  revalidatePath("/configuracoes");
}

async function saveStore(formData: FormData) {
  "use server";
  const s = await getSession();
  const supabase = await createClient();
  const { data: store } = await supabase.schema("core").from("stores").insert({
    org_id: s.orgId, legal_entity_id: String(formData.get("legal_entity_id")), code: String(formData.get("code")).toUpperCase(),
    name: String(formData.get("name")), format: String(formData.get("format")) as "SHOP_IN_SHOP", status: "ACTIVE",
  }).select("id, legal_entity_id").single();
  if (store) {
    await supabase.schema("inv").from("locations").insert([
      { org_id: s.orgId, store_id: store.id, legal_entity_id: store.legal_entity_id, name: "Salão de vendas", kind: "SALES_FLOOR" },
      { org_id: s.orgId, store_id: store.id, legal_entity_id: store.legal_entity_id, name: "Armários VIP", kind: "VIP_LOCKERS", is_sellable: false },
    ]);
    await supabase.schema("sales").from("cash_registers").insert({ org_id: s.orgId, store_id: store.id, name: "Caixa 1" });
  }
  revalidatePath("/configuracoes");
}

export default async function ConfiguracoesPage() {
  await requirePerm("core.admin");
  const supabase = await createClient();
  const [{ data: entities }, { data: stores }] = await Promise.all([
    supabase.schema("core").from("legal_entities").select("id, cnpj, razao_social, nome_fantasia, ie, tax_regime, status").order("razao_social"),
    supabase.schema("core").from("stores").select("id, code, name, format, status, legal_entity_id").order("name"),
  ]);
  const fmtCnpj = (c: string) => c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

  return (
    <>
      <PageHeader title="Empresas & lojas" description="CNPJs do grupo e lojas (cada loja tem estoque, caixa e centro de custo próprios)." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Empresas (CNPJ)">
          <Table head={["CNPJ", "Razão social", "Regime"]}>
            {(entities ?? []).map((e) => <tr key={e.id}><td className="px-3 py-2 whitespace-nowrap">{fmtCnpj(e.cnpj)}</td><td className="px-3 py-2">{e.razao_social}</td><td className="px-3 py-2">{e.tax_regime}</td></tr>)}
          </Table>
          <details className="mt-3"><summary className="cursor-pointer text-sm text-brand">+ Adicionar CNPJ</summary>
            <form action={saveLegalEntity} className="mt-2 grid gap-2">
              <input name="cnpj" required placeholder="CNPJ" className={inputClass} aria-label="CNPJ" />
              <input name="razao_social" required placeholder="Razão social" className={inputClass} aria-label="Razão social" />
              <input name="nome_fantasia" placeholder="Nome fantasia" className={inputClass} aria-label="Nome fantasia" />
              <input name="ie" placeholder="Inscrição estadual" className={inputClass} aria-label="Inscrição estadual" />
              <Button className="w-fit">Salvar</Button>
            </form>
          </details>
        </Card>
        <Card title="Lojas">
          <Table head={["Código", "Nome", "Formato", "Status"]}>
            {(stores ?? []).map((s) => <tr key={s.id}><td className="px-3 py-2">{s.code}</td><td className="px-3 py-2">{s.name}</td><td className="px-3 py-2">{s.format}</td><td className="px-3 py-2"><Badge tone={s.status === "ACTIVE" ? "success" : "neutral"}>{s.status}</Badge></td></tr>)}
          </Table>
          <details className="mt-3"><summary className="cursor-pointer text-sm text-brand">+ Adicionar loja</summary>
            <form action={saveStore} className="mt-2 grid gap-2">
              <select name="legal_entity_id" className={inputClass} aria-label="Empresa">{(entities ?? []).map((e) => <option key={e.id} value={e.id}>{e.razao_social}</option>)}</select>
              <input name="code" required placeholder="Código (ex.: JOY)" className={inputClass} aria-label="Código" />
              <input name="name" required placeholder="Nome da loja" className={inputClass} aria-label="Nome" />
              <select name="format" className={inputClass} aria-label="Formato">
                <option value="SHOP_IN_SHOP">Shop-in-shop</option><option value="CONSIGNMENT_CORNER">Corner em consignação</option>
                <option value="POPUP">Pop-up</option><option value="DIGITAL">Digital</option><option value="B2B">B2B</option>
              </select>
              <Button className="w-fit">Salvar (cria estoque e caixa)</Button>
            </form>
          </details>
        </Card>
      </div>
    </>
  );
}
