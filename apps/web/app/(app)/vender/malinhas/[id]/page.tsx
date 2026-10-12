import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBRL } from "@centralops/domain";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { isoFromNow, str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, LinkButton, PageHeader } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { resolveItems } from "../../../produtos/compras/options";
import { extendLoanAction } from "../actions";
import { SettleForm, type SettleLine } from "./settle-form";

export const metadata = { title: "Malinha" };

export default async function MalinhaDetalhe({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const session = await requirePerm("sales.read");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: loan } = await supabase.schema("inv").from("loans")
    .select("id, number, kind, party_id, campaign_id, purpose, due_at, status, notes, created_at, closed_at, order_id").eq("id", id).maybeSingle();
  if (!loan) notFound();
  const [{ data: items }, { data: party }, { data: campaign }, { data: phone }] = await Promise.all([
    supabase.schema("inv").from("loan_items").select("id, variant_id, qty, unit_price, returned, sold, lost, damaged, gifted").eq("loan_id", id),
    loan.party_id ? supabase.schema("crm").from("parties").select("display_name").eq("id", loan.party_id).maybeSingle() : Promise.resolve({ data: null }),
    loan.campaign_id ? supabase.schema("mkt").from("campaigns").select("name").eq("id", loan.campaign_id).maybeSingle() : Promise.resolve({ data: null }),
    loan.party_id ? supabase.schema("crm").from("party_contact_points").select("value_normalized").eq("party_id", loan.party_id).eq("type", "WHATSAPP").limit(1).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const labels = new Map((await resolveItems((items ?? []).map((i) => ({ variant_id: i.variant_id, qty: 0, unit_cost: 0 })))).map((l) => [l.variant_id, l]));
  const lines: SettleLine[] = (items ?? []).map((i) => ({
    id: i.id, sku: labels.get(i.variant_id)?.sku ?? "", label: labels.get(i.variant_id)?.label ?? "", price: i.unit_price == null ? null : Number(i.unit_price),
    qty: Number(i.qty), done: { returned: Number(i.returned), sold: Number(i.sold), lost: Number(i.lost), damaged: Number(i.damaged), gifted: Number(i.gifted) },
  }));
  const open = loan.status === "OPEN";
  const late = open && new Date(loan.due_at).getTime() < new Date(isoFromNow(0)).getTime();
  const pendingValue = lines.reduce((a, l) => a + (l.qty - Object.values(l.done).reduce((x, y) => x + y, 0)) * (l.price ?? 0), 0);
  const due = new Date(loan.due_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const wa = phone?.value_normalized && loan.kind === "TRY_ON"
    ? `https://wa.me/${((d) => (d.length <= 11 ? `55${d}` : d))(phone.value_normalized.replace(/\D/g, ""))}?text=${encodeURIComponent(`Oi, ${party?.display_name?.split(" ")[0] ?? ""}! Tudo bem? Passando para lembrar da malinha ${loan.number}: a devolução é até ${due}. Gostou de alguma peça? 💛`)}` : null;

  return (
    <>
      <PageHeader title={`${loan.kind === "TRY_ON" ? "Malinha" : "Peças em campanha"} ${loan.number}`}
        description={[party?.display_name, campaign?.name, loan.purpose].filter(Boolean).join(" · ")}
        actions={<>
          <LinkButton href={`/imprimir/malinha/${loan.id}`}>Imprimir termo</LinkButton>
          {wa && open && <a href={wa} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2">Lembrar pelo WhatsApp</a>}
          <LinkButton href={`/vender/malinhas?tipo=${loan.kind}`}>Voltar</LinkButton>
        </>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        {open ? <Badge tone={late ? "danger" : "warning"}>{late ? `vencida em ${due}` : `devolver até ${due}`}</Badge> : <Badge tone={loan.status === "CLOSED" ? "success" : "neutral"}>{loan.status === "CLOSED" ? "encerrada" : "cancelada"}</Badge>}
        <span className="text-muted">Valor ainda fora da loja: <b className="text-foreground">{formatBRL(pendingValue)}</b></span>
        {loan.order_id && <Link className="text-brand" href={`/vender/pedidos/${loan.order_id}`}>venda das peças</Link>}
        {loan.notes && <span className="text-muted">· {loan.notes}</span>}
      </div>

      <Card title={open ? "Acerto (o que voltou e o que ficou)" : "Peças"}>
        <SettleForm loanId={loan.id} kind={loan.kind as "TRY_ON" | "CAMPAIGN"} lines={lines} editable={open && can(session, "sales.write")} />
      </Card>

      {open && can(session, "sales.write") && (
        <Card className="mt-4" title="Mudar o prazo">
          <form action={extendLoanAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="loan_id" value={loan.id} />
            <Field label="Nova data de devolução"><input type="date" name="due" required className={inputClass} /></Field>
            <Button variant="secondary">Alterar prazo</Button>
          </form>
        </Card>
      )}
    </>
  );
}
