import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Button, Card, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { saveCsatAction, saveNpsAction, saveRoutingAction } from "./actions";

export const metadata = { title: "Distribuição e satisfação" };

interface Routing { enabled: boolean; max_open_per_member: number; on_call_member_id: string | null; use_roster: boolean }
interface Csat { enabled: boolean; question: string; thanks: string }

export default async function RegrasPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("omni.read");
  const sp = await searchParams;
  const supabase = await createClient();
  const [{ data: settings }, { data: npsRule }, { data: members }] = await Promise.all([
    supabase.schema("core").from("settings").select("key, value").in("key", ["routing", "csat", "nps"]),
    supabase.schema("omni").from("notice_rules").select("active").eq("event", "NPS_ASK").maybeSingle(),
    supabase.schema("core").from("members").select("id, display_name").eq("status", "ACTIVE").order("display_name"),
  ]);
  const get = (k: string) => (settings ?? []).find((s) => s.key === k)?.value as Record<string, unknown> | undefined;
  const routing: Routing = { enabled: false, max_open_per_member: 15, on_call_member_id: null, use_roster: true, ...(get("routing") as Partial<Routing>) };
  const csat: Csat = { enabled: false, question: "Antes de ir: de 1 a 5, como foi o seu atendimento? (5 = ótimo) Responda só com o número.", thanks: "Obrigada pela nota! 💛", ...(get("csat") as Partial<Csat>) };
  const nps = { delay_days: 10, thanks: "Obrigada pela resposta! 💛", ...(get("nps") as { delay_days?: number; thanks?: string } | undefined) };
  const isAdmin = can(session, "core.admin");
  const canWrite = can(session, "omni.write");

  return (
    <>
      <PageHeader title="Distribuição e satisfação" description="Quem recebe a conversa quando a cliente pede uma pessoa e a pesquisa de nota ao encerrar o atendimento." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      <Card title="Distribuição automática">
        <p className="mb-3 text-sm text-muted">Quando a conversa passa a <b>Aguardando humano</b> sem responsável, ela vai para: 1) a dona do relacionamento da cliente; 2) se for VIP, a pessoa de plantão; 3) quem está na escala agora (Equipe › Escalas) com menos conversas abertas, respeitando o limite; 4) a pessoa de plantão.</p>
        <form action={saveRoutingAction} className="space-y-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={routing.enabled} disabled={!isAdmin} /> Ligada</label>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Plantão (VIP e sobra)"><select name="on_call_member_id" defaultValue={routing.on_call_member_id ?? ""} disabled={!isAdmin} className={inputClass}><option value="">Ninguém</option>{(members ?? []).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>
            <Field label="Máximo de conversas abertas por pessoa"><input name="max_open_per_member" type="number" min={1} max={100} defaultValue={routing.max_open_per_member} disabled={!isAdmin} className={inputClass} /></Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="use_roster" defaultChecked={routing.use_roster} disabled={!isAdmin} /> Só quem está na escala agora</label>
          </div>
          {isAdmin ? <Button>Salvar distribuição</Button> : <p className="text-xs text-muted">Só sócios e administração alteram.</p>}
        </form>
      </Card>

      <Card className="mt-4" title="Pesquisa de satisfação (CSAT)">
        <p className="mb-3 text-sm text-muted">Ao encerrar uma conversa com a janela de 24 h aberta, a cliente recebe a pergunta (no máximo uma vez por semana). Se ela responder só com um número de 1 a 5, a nota é gravada sem acordar a IA; nota até 3 vira tarefa para a dona do relacionamento e aviso para a equipe.</p>
        <form action={saveCsatAction} className="space-y-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={csat.enabled} disabled={!canWrite} /> Ligada</label>
          <Field label="Pergunta"><input name="question" maxLength={300} defaultValue={csat.question} disabled={!canWrite} className={inputClass} /></Field>
          <Field label="Agradecimento"><input name="thanks" maxLength={200} defaultValue={csat.thanks} disabled={!canWrite} className={inputClass} /></Field>
          {canWrite && <Button>Salvar pesquisa</Button>}
        </form>
      </Card>
      <Card className="mt-4" title="NPS (indicaria a SIÉ para uma amiga?)">
        <p className="mb-3 text-sm text-muted">Alguns dias depois da compra a cliente recebe a pergunta de 0 a 10 (texto se a janela estiver aberta; senão, o template de utilidade escolhido em Avisos automáticos; sem template, vira tarefa). Responder só com o número grava a nota. Nota até 6 abre um caso; 9 ou 10 vira convite para indicar uma amiga.</p>
        <form action={saveNpsAction} className="space-y-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={Boolean(npsRule?.active)} disabled={!canWrite} /> Ligado</label>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Field label="Perguntar após (dias)"><input name="delay_days" type="number" min={3} max={60} defaultValue={nps.delay_days} disabled={!canWrite} className={inputClass} /></Field>
            <Field label="Agradecimento"><input name="thanks" maxLength={200} defaultValue={nps.thanks} disabled={!canWrite} className={inputClass} /></Field>
          </div>
          {canWrite && <Button>Salvar NPS</Button>}
        </form>
      </Card>
    </>
  );
}
