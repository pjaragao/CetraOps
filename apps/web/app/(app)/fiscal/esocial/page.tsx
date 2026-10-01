import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, LinkButton, PageHeader, Table } from "@/components/ui";
import { Flash, fmtMonth } from "@/components/form";
import { markEsocialExportedAction } from "../actions";

export const metadata = { title: "eSocial" };

const EVENT: Record<string, string> = {
  "S-1200": "Remuneração do trabalhador", "S-1210": "Pagamentos de rendimentos", "S-2200": "Admissão", "S-2206": "Alteração contratual (salário)",
  "S-2230": "Afastamento temporário / férias", "S-2299": "Desligamento",
};

/** Fila de eventos do eSocial gerada pelos atos do RH. A transmissão é feita pelo contador/integrador; aqui se exporta e se acompanha. */
export default async function EsocialPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fiscal.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: events } = await supabase.schema("fiscal").from("esocial_events").select("id, event, reference_type, competence, status, created_at, payload").order("created_at", { ascending: false }).limit(200);
  const pending = (events ?? []).filter((e) => e.status === "PENDING");

  return (
    <>
      <PageHeader title="eSocial — fila de eventos" description="Cada admissão, reajuste, afastamento, folha e desligamento gera um evento com os dados prontos. Exporte para o contador transmitir ao eSocial; a transmissão direta virá com o integrador."
        actions={<LinkButton href="/fiscal/esocial/export">Baixar pendentes (JSON)</LinkButton>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      {(events ?? []).length === 0 ? <Empty title="Nenhum evento ainda" /> : (
        <form action={markEsocialExportedAction}>
          <Table head={["", "Evento", "Competência", "Situação", "Dados"]}>
            {(events ?? []).map((e) => (
              <tr key={e.id}>
                <td className="px-3 py-2">{e.status === "PENDING" && can(session, "fiscal.write") && <input type="checkbox" name="ids" value={e.id} defaultChecked aria-label={`Selecionar ${e.event}`} />}</td>
                <td className="px-3 py-2"><b>{e.event}</b> <span className="text-muted">{EVENT[e.event] ?? ""}</span></td>
                <td className="px-3 py-2">{e.competence ? fmtMonth(e.competence) : "—"}</td>
                <td className="px-3 py-2"><Badge tone={e.status === "PENDING" ? "warning" : e.status === "EXPORTED" ? "info" : e.status === "SENT" ? "success" : "neutral"}>{e.status === "PENDING" ? "pendente" : e.status === "EXPORTED" ? "enviado ao contador" : e.status.toLowerCase()}</Badge></td>
                <td className="max-w-md truncate px-3 py-2 text-xs text-muted" title={JSON.stringify(e.payload)}>{JSON.stringify(e.payload).slice(0, 140)}</td>
              </tr>
            ))}
          </Table>
          {pending.length > 0 && can(session, "fiscal.write") && <div className="mt-3"><Button variant="secondary">Marcar selecionados como enviados ao contador</Button></div>}
        </form>
      )}
      <Card className="mt-4"><p className="text-xs text-muted">Eventos contêm dados pessoais: exporte só para o contador e apague o arquivo depois de transmitido (LGPD). A folha de pagamento oficial e os totalizadores continuam sob responsabilidade do contador.</p></Card>
    </>
  );
}
