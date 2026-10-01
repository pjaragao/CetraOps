import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Button, Card, inputClass, PageHeader } from "@/components/ui";
import { Flash } from "@/components/form";
import { saveBusinessHoursAction } from "../actions";

export const metadata = { title: "Horário de atendimento" };

const DAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const ORDER = [1, 2, 3, 4, 5, 6, 0];

export default async function HorarioPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  await requirePerm("core.admin");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: ch } = await supabase.schema("omni").from("channel_accounts").select("id, channel, display_name, business_hours").eq("id", id).maybeSingle();
  if (!ch) notFound();
  const bh = (ch.business_hours ?? {}) as { days?: Record<string, [string, string][]>; after_hours_ai?: string };
  const days = bh.days ?? {};
  const configured = Object.keys(days).length > 0;

  return (
    <>
      <PageHeader title={`Horário de atendimento: ${ch.display_name}`}
        description="Fora deste horário a cliente recebe a resposta de quando a equipe volta, o prazo de atendimento (SLA) para de correr e fica uma tarefa para a abertura. Sem nenhum dia preenchido, o canal é tratado como sempre aberto."
        actions={<Link href="/configuracoes/integracoes" className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Integrações</Link>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <form action={saveBusinessHoursAction} className="space-y-4">
        <input type="hidden" name="id" value={ch.id} />
        <Card title={configured ? "Dias e faixas" : "Dias e faixas (hoje: sempre aberto)"}>
          <div className="space-y-2">
            {ORDER.map((d) => {
              const iv = days[String(d)] ?? [];
              return (
                <div key={d} className="grid items-center gap-2 sm:grid-cols-[7rem_auto_auto_auto]">
                  <span className="text-sm font-medium">{DAYS[d]}</span>
                  <span className="flex items-center gap-1 text-xs text-muted">
                    <input type="time" name={`s1_${d}`} defaultValue={iv[0]?.[0] ?? ""} aria-label={`${DAYS[d]}: abre`} className={`${inputClass} w-28`} />–
                    <input type="time" name={`e1_${d}`} defaultValue={iv[0]?.[1] ?? ""} aria-label={`${DAYS[d]}: fecha`} className={`${inputClass} w-28`} />
                  </span>
                  <span className="flex items-center gap-1 text-xs text-muted">e
                    <input type="time" name={`s2_${d}`} defaultValue={iv[1]?.[0] ?? ""} aria-label={`${DAYS[d]}: reabre`} className={`${inputClass} w-28`} />–
                    <input type="time" name={`e2_${d}`} defaultValue={iv[1]?.[1] ?? ""} aria-label={`${DAYS[d]}: fecha de novo`} className={`${inputClass} w-28`} />
                  </span>
                  <span className="text-xs text-muted">{configured && iv.length === 0 ? "fechado" : ""}</span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted">Dia em branco = loja fechada. A segunda faixa é opcional (ex.: fecha no almoço). Faixas no mesmo dia, sem passar da meia-noite.</p>
        </Card>
        <Card title="Fora do horário, a IA…">
          <div className="space-y-2 text-sm">
            <label className="flex items-start gap-2"><input type="radio" name="after_hours_ai" value="DRAFT_ONLY" defaultChecked={bh.after_hours_ai !== "SAFE_AUTOPILOT"} className="mt-1" />
              <span><b>Só prepara rascunho</b><span className="block text-xs text-muted">Nada sai sozinho; a cliente recebe só o aviso de quando a equipe volta quando pedir uma pessoa.</span></span></label>
            <label className="flex items-start gap-2"><input type="radio" name="after_hours_ai" value="SAFE_AUTOPILOT" defaultChecked={bh.after_hours_ai === "SAFE_AUTOPILOT"} className="mt-1" />
              <span><b>Responde sozinha o que é só informação</b><span className="block text-xs text-muted">Saudação, estoque, produto, medidas, endereço e status de pedido. Reserva, pedido, link de pagamento e qualquer dúvida sensível esperam a equipe (com tarefa para a abertura).</span></span></label>
          </div>
        </Card>
        <Button>Salvar horário</Button>
      </form>
    </>
  );
}
