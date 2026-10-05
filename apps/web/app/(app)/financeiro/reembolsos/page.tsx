import Link from "next/link";
import { redirect } from "next/navigation";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, getSession } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, cn, Empty, LinkButton, PageHeader, Table } from "@/components/ui";
import { Flash } from "@/components/form";
import { STATUS } from "./labels";

export const metadata = { title: "Reembolsos" };

export default async function ReembolsosPage({ searchParams }: { searchParams: SP }) {
  const session = await getSession();
  const seeAll = can(session, "fin.read");
  if (!seeAll && !can(session, "fin.reimburse")) redirect("/inicio?erro=sem-permissao");
  const sp = await searchParams;
  const filtro = str(sp.filtro) ?? (can(session, "fin.approve") ? "aprovar" : "meus");
  const supabase = await createClient();
  let q = supabase.schema("fin").from("reimbursements").select("id, number, purpose, status, total, created_at, submitted_at, due_date, party_id, requester_member_id").order("created_at", { ascending: false }).limit(200);
  if (filtro === "aprovar") q = q.eq("status", "SUBMITTED");
  else if (filtro === "meus" || !seeAll) q = q.eq("requester_member_id", session.memberId);
  const { data: rows } = await q;
  const ids = [...new Set((rows ?? []).map((r) => r.party_id))];
  const { data: people } = ids.length ? await supabase.schema("crm").from("parties").select("id, display_name").in("id", ids) : { data: [] as { id: string; display_name: string }[] };
  const who = new Map((people ?? []).map((p) => [p.id, p.display_name]));
  const tabs = [...(can(session, "fin.approve") ? [["aprovar", "Para aprovar"]] : []), ["meus", "Meus"], ...(seeAll ? [["todos", "Todos"]] : [])];

  return (
    <>
      <PageHeader title="Reembolsos" description="Despesas pagas do próprio bolso (almoço com fornecedor, material, combustível) com a nota ou o recibo. Aprovado, vira conta a pagar para a pessoa, já classificado; pago, o reembolso fecha sozinho."
        actions={<LinkButton href="/financeiro/reembolsos/novo" variant="primary">Novo reembolso</LinkButton>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {tabs.map(([k, l]) => <Link key={k} href={`/financeiro/reembolsos?filtro=${k}`} className={cn("rounded-full border px-3 py-1 text-sm", filtro === k ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2")}>{l}</Link>)}
      </div>
      {(rows ?? []).length === 0 ? <Empty title="Nenhum reembolso aqui">Pagou algo da loja do seu bolso? Crie um reembolso e anexe a nota.</Empty> : (
        <Table head={["Número", "Pessoa", "Do que é", "Total", "Situação", "Data"]}>
          {(rows ?? []).map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 font-mono text-xs"><Link href={`/financeiro/reembolsos/${r.id}`} className="text-brand">{r.number}</Link></td>
              <td className="px-3 py-2 text-sm">{who.get(r.party_id) ?? "—"}</td>
              <td className="px-3 py-2 text-sm">{r.purpose}</td>
              <td className="px-3 py-2 tabular-nums">{formatBRL(Number(r.total))}</td>
              <td className="px-3 py-2"><Badge tone={STATUS[r.status]?.tone ?? "neutral"}>{STATUS[r.status]?.label ?? r.status}</Badge></td>
              <td className="px-3 py-2 text-xs text-muted">{new Date(r.submitted_at ?? r.created_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
