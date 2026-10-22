import { redirect } from "next/navigation";
import { can, getSession } from "@/lib/session";
import { isoFromNow } from "@/lib/context";
import { Card, Narrow, PageHeader } from "@/components/ui";
import { ReimbursementForm } from "../reimbursement-form";

export const metadata = { title: "Novo reembolso" };

export default async function NovoReembolsoPage() {
  const session = await getSession();
  if (!can(session, "fin.reimburse") && !can(session, "fin.write")) redirect("/inicio?erro=sem-permissao");
  const today = isoFromNow(-3).slice(0, 10);   // data de hoje em São Paulo (UTC-3)
  return (
    <Narrow>
      <PageHeader title="Novo reembolso" description="Lance cada despesa com a data, o valor, o documento e a foto ou o PDF da nota/recibo. Envie direto para aprovação ou salve como rascunho para terminar depois." />
      <Card><ReimbursementForm today={today} /></Card>
    </Narrow>
  );
}
