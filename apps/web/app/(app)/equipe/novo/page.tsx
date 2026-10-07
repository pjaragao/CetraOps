import { createClient } from "@/lib/supabase/server";
import { getSession, requirePerm } from "@/lib/session";
import { todayIsoSP } from "@/lib/context";
import Link from "next/link";
import { cn, LinkButton, PageHeader } from "@/components/ui";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { ROLE_LABEL, searchPeople } from "../../configuracoes/usuarios/data";
import { AdmissionForm, type KnownPerson } from "./admission-form";
import { FreelancerForm } from "./freelancer-form";

export const metadata = { title: "Admitir colaborador" };

export default async function NovoColaboradorPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const freelancer = str(sp.tipo) === "freelancer";
  const pessoa = str(sp.pessoa);
  const buscar = str(sp.buscar) ?? "";
  await requirePerm("hr.write");
  const session = await getSession();
  const supabase = await createClient();
  const { data: entities } = await supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia").order("razao_social");
  // Cadastro único: a pessoa pode já existir (cliente, sócia, usuária…). Admitir parte dela em vez de criar outra.
  let person: KnownPerson | null = null;
  if (pessoa && !freelancer) {
    const crm = supabase.schema("crm");
    const [{ data: p }, { data: phone }, { data: email }, { data: cpf }] = await Promise.all([
      crm.from("parties").select("id, display_name, birth_date").eq("id", pessoa).eq("kind", "PERSON").is("merged_into_id", null).maybeSingle(),
      crm.from("party_contact_points").select("value_display").eq("party_id", pessoa).in("type", ["WHATSAPP", "PHONE"]).order("is_primary", { ascending: false }).limit(1).maybeSingle(),
      crm.from("party_contact_points").select("value_display").eq("party_id", pessoa).eq("type", "EMAIL").order("is_primary", { ascending: false }).limit(1).maybeSingle(),
      crm.rpc("party_cpf_masked", { p_party: pessoa }),
    ]);
    if (p) person = { id: p.id, name: p.display_name, birth: p.birth_date ?? "", phone: phone?.value_display ?? "", email: email?.value_display ?? "", cpfMasked: (cpf as string | null) ?? null };
  }
  const hits = !freelancer && !person ? await searchPeople(buscar) : [];
  return (
    <>
      <PageHeader title={freelancer ? "Freelancer PJ/MEI" : "Admitir colaborador"}
        description={freelancer ? "Prestador sem vínculo para datas especiais: vira conta a pagar, sem folha nem encargos de CLT." : "Cria o cadastro único (pessoa), o vínculo, o salário inicial e os períodos de férias, e enfileira o evento S-2200 do eSocial."}
        actions={<LinkButton href="/equipe">Voltar</LinkButton>} />
      <div className="mb-4 flex gap-1.5" role="tablist" aria-label="Tipo de contratação">
        {[["", "Colaborador (CLT, intermitente, temporário, estágio, sócio)"], ["freelancer", "Freelancer PJ/MEI (sem vínculo)"]].map(([k, label]) => (
          <Link key={k} role="tab" aria-selected={(k === "freelancer") === freelancer} href={k ? `/equipe/novo?tipo=${k}` : "/equipe/novo"}
            className={cn("rounded-full border px-3 py-1 text-sm", (k === "freelancer") === freelancer ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2")}>{label}</Link>
        ))}
      </div>
      {!freelancer && !person && (
        <Card className="mb-4" title="A pessoa já está no Cadastro?">
          <form className="flex flex-wrap items-end gap-2">
            <Field label="Buscar pela pessoa"><input name="buscar" defaultValue={buscar} placeholder="Nome (ex.: Luisa)" className={`${inputClass} w-64`} /></Field>
            <Button variant="secondary">Buscar</Button>
          </form>
          {buscar.trim().length >= 2 && (hits.length === 0 ? <p className="mt-2 text-sm text-muted">Ninguém com esse nome: preencha abaixo e a pessoa é criada junto com a admissão.</p> : (
            <ul className="mt-2 space-y-1 text-sm">{hits.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{h.name}</span><span className="text-xs text-muted">{[h.city, ...h.roles.map((r) => ROLE_LABEL[r]).filter(Boolean)].filter(Boolean).join(" · ")}</span>
                {h.roles.includes("EMPLOYEE") ? <Badge tone="neutral">já é colaborador(a)</Badge> : <Link href={`/equipe/novo?pessoa=${h.id}`} className="text-brand">Admitir esta pessoa</Link>}
              </li>
            ))}</ul>
          ))}
        </Card>
      )}
      {person && <p className="mb-4 text-sm text-muted">Admitindo <b>{person.name}</b>, que já está no Cadastro. O CPF digitado precisa ser o do cadastro dela. <Link href="/equipe/novo" className="text-brand">Escolher outra pessoa</Link></p>}
      {freelancer
        ? <FreelancerForm entities={(entities ?? []).map((e) => ({ id: e.id, label: e.nome_fantasia ?? e.razao_social }))} stores={session.stores.map((s) => ({ id: s.id, label: s.name, legal_entity_id: s.legal_entity_id }))} />
        : <AdmissionForm today={todayIsoSP()}
            entities={(entities ?? []).map((e) => ({ id: e.id, label: e.nome_fantasia ?? e.razao_social }))}
            stores={session.stores.map((s) => ({ id: s.id, label: s.name, legal_entity_id: s.legal_entity_id }))} person={person} />}
    </>
  );
}
