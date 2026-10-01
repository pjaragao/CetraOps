import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { isoFromNow, str, type SP } from "@/lib/context";
import { Button, Card, inputClass, PageHeader } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { checkinAction, walkinAction } from "./actions";

export const metadata = { title: "Check-in de evento" };

interface Guest { guest_id: string; event_id: string; event: string; name: string; party_id: string; rsvp: string; plus_ones: number; checked_in_at: string | null }

export default async function CheckinPage({ searchParams }: { searchParams: SP }) {
  await requirePerm("crm.write");
  const sp = await searchParams;
  const token = str(sp.t);
  const supabase = await createClient();
  let guest: Guest | null = null;
  let tokenError: string | undefined;
  if (token) {
    const { data, error } = await supabase.schema("mkt").rpc("guest_by_token", { p_token: token });
    if (error) tokenError = error.message.replace(/^ERROR:\s*/, ""); else guest = data as unknown as Guest;
  }
  const since = isoFromNow(-24 * 3600 * 1000);
  const { data: events } = await supabase.schema("mkt").from("events").select("id, name, starts_at").in("status", ["PLANNED", "CONFIRMED", "DONE"]).gte("starts_at", since).order("starts_at").limit(20);
  const selected = str(sp.evento) || events?.[0]?.id || "";

  return (
    <>
      <PageHeader title="Check-in de evento" description="Aponte a câmera do celular para o QR da convidada: este endereço abre já com ela identificada. Confirme a presença e, se ela trouxe acompanhante, informe quantas." />
      <Flash ok={str(sp.ok)} erro={str(sp.erro) ?? tokenError} />
      {guest && (
        <Card title={guest.name}>
          <p className="mb-3 text-sm text-muted">{guest.event} · situação: {guest.rsvp === "ATTENDED" ? "já presente" : guest.rsvp.toLowerCase()}{guest.checked_in_at ? "" : ""}</p>
          <form action={checkinAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="token" value={token} />
            <Field label="Acompanhantes"><input name="plus_ones" type="number" min={0} max={5} defaultValue={guest.plus_ones} className={`${inputClass} w-24`} /></Field>
            <Button>{guest.rsvp === "ATTENDED" ? "Já está presente" : "Confirmar presença"}</Button>
            <Link href={`/clientes/${guest.party_id}`} className="text-sm text-brand">Abrir a ficha</Link>
          </form>
        </Card>
      )}
      <Card className="mt-4" title="Chegou sem convite">
        {(events ?? []).length === 0 ? <p className="text-sm text-muted">Nenhum evento em andamento ou próximo.</p> : (
          <form action={walkinAction} className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <Field label="Evento"><select name="event_id" defaultValue={selected} className={inputClass}>{(events ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
            <Field label="Nome"><input name="name" required minLength={2} className={inputClass} /></Field>
            <Field label="WhatsApp"><input name="phone" inputMode="tel" placeholder="(48) 90000-0000" className={inputClass} /></Field>
            <Field label="Acompanhantes"><input name="plus_ones" type="number" min={0} max={5} defaultValue={0} className={inputClass} /></Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" name="accept_marketing" /> Ela aceitou receber novidades e convites da SIÉ pelo WhatsApp</label>
            <Button>Cadastrar e confirmar presença</Button>
          </form>
        )}
      </Card>
    </>
  );
}
