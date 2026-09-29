import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { Badge, PageHeader, Table } from "@/components/ui";

export const metadata = { title: "Equipe" };

export default async function EquipePage() {
  await requirePerm("core.admin");
  const supabase = await createClient();
  const { data: members } = await supabase.schema("core").from("members")
    .select("id, display_name, status, default_store_id, member_roles(roles(name)), member_store_access(all_stores, stores(name))").order("display_name");

  return (
    <>
      <PageHeader title="Pessoas & acessos" description="Quem acessa o sistema, com qual papel e em quais lojas. Novos acessos são por convite (Supabase Auth)." />
      <Table head={["Nome", "Papéis", "Lojas", "Status"]}>
        {(members ?? []).map((m) => (
          <tr key={m.id}>
            <td className="px-3 py-2 font-medium">{m.display_name}</td>
            <td className="px-3 py-2">{(m.member_roles ?? []).map((r) => r.roles?.name).join(", ")}</td>
            <td className="px-3 py-2">{(m.member_store_access ?? []).map((a) => (a.all_stores ? "Todas" : a.stores?.name)).join(", ")}</td>
            <td className="px-3 py-2"><Badge tone={m.status === "ACTIVE" ? "success" : "danger"}>{m.status}</Badge></td>
          </tr>
        ))}
      </Table>
    </>
  );
}
