import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { can, requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, Empty, inputClass, LinkButton, PageHeader, Table } from "@/components/ui";
import { Field, Flash } from "@/components/form";
import { archiveCostCenterAction, saveCostCenterAction } from "./actions";

export const metadata = { title: "Centros de custo" };

const KIND_LABEL: Record<string, string> = {
  CORPORATE: "Administrativo", LEGAL_ENTITY: "Empresa (CNPJ)", STORE: "Loja", CHANNEL: "Canal de venda", PROJECT_EVENT: "Evento / projeto", POOL: "Agrupador",
};

interface CC { id: string; parent_id: string | null; code: string; name: string; kind: string; store_id: string | null; legal_entity_id: string | null; channel: string | null; archived_at: string | null }

/** Ordena em árvore (pai antes dos filhos) e devolve a profundidade de cada um. */
function tree(rows: CC[]): { cc: CC; depth: number }[] {
  const kids = new Map<string | null, CC[]>();
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) { const k = r.parent_id && ids.has(r.parent_id) ? r.parent_id : null; kids.set(k, [...(kids.get(k) ?? []), r]); }
  const out: { cc: CC; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of (kids.get(parent) ?? []).sort((a, b) => a.code.localeCompare(b.code))) { out.push({ cc: c, depth }); walk(c.id, depth + 1); }
  };
  walk(null, 0);
  return out;
}

export default async function CentrosDeCustoPage({ searchParams }: { searchParams: SP }) {
  const session = await requirePerm("fin.read");
  const sp = await searchParams;
  const canWrite = can(session, "fin.write") || can(session, "core.admin");
  const showArchived = str(sp.arquivados) === "1";
  const supabase = await createClient();
  let q = supabase.schema("core").from("cost_centers").select("id, parent_id, code, name, kind, store_id, legal_entity_id, channel, archived_at");
  if (!showArchived) q = q.is("archived_at", null);
  const [{ data: rows }, { data: stores }, { data: entities }] = await Promise.all([
    q, supabase.schema("core").from("stores").select("id, name, cost_center_id").order("name"),
    supabase.schema("core").from("legal_entities").select("id, razao_social, nome_fantasia").order("razao_social"),
  ]);
  const list = tree((rows ?? []) as CC[]);
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));
  const storeOf = new Map((stores ?? []).filter((s) => s.cost_center_id).map((s) => [s.cost_center_id!, s.name]));
  const editing = list.find((x) => x.cc.id === str(sp.editar))?.cc;
  const showForm = canWrite && (Boolean(editing) || str(sp.novo) === "1");

  return (
    <>
      <PageHeader title="Centros de custo" description="Onde cada receita e despesa aparece no DRE: administrativo, cada loja, canais de venda, marketing, produto e logística. Toda loja nova já nasce com o seu centro de custo."
        actions={canWrite && !showForm ? <LinkButton href="/configuracoes/centros-de-custo?novo=1#form" variant="primary">+ Novo centro de custo</LinkButton> : undefined} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />

      {showForm && (
        <Card className="mb-4" title={editing ? `Editar ${editing.code} · ${editing.name}` : "Novo centro de custo"}>
          <form id="form" action={saveCostCenterAction} className="grid gap-3 sm:grid-cols-4">
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <Field label="Código" hint="Ex.: MKT-INFLUENCER"><input name="code" required defaultValue={editing?.code ?? ""} maxLength={30} className={`${inputClass} font-mono uppercase`} /></Field>
            <Field label="Nome" className="sm:col-span-2"><input name="name" required minLength={2} maxLength={80} defaultValue={editing?.name ?? ""} className={inputClass} /></Field>
            <Field label="Tipo"><select name="kind" defaultValue={editing?.kind ?? "POOL"} className={inputClass}>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Dentro de" className="sm:col-span-2">
              <select name="parent_id" defaultValue={editing?.parent_id ?? ""} className={inputClass}>
                <option value="">— (primeiro nível)</option>
                {list.filter((x) => x.cc.id !== editing?.id && !x.cc.archived_at).map((x) => <option key={x.cc.id} value={x.cc.id}>{"  ".repeat(x.depth)}{x.cc.code} · {x.cc.name}</option>)}
              </select>
            </Field>
            <Field label="Loja (opcional)"><select name="store_id" defaultValue={editing?.store_id ?? ""} className={inputClass}><option value="">—</option>{(stores ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="Empresa (opcional)"><select name="legal_entity_id" defaultValue={editing?.legal_entity_id ?? ""} className={inputClass}><option value="">—</option>{(entities ?? []).map((e) => <option key={e.id} value={e.id}>{e.nome_fantasia ?? e.razao_social}</option>)}</select></Field>
            <Field label="Canal (só para canal de venda)" hint="Ex.: ECOMMERCE, SOCIAL, B2B"><input name="channel" defaultValue={editing?.channel ?? ""} maxLength={30} className={inputClass} /></Field>
            <div className="flex items-end gap-3"><Button>{editing ? "Salvar" : "Criar"}</Button><Link href="/configuracoes/centros-de-custo" className="pb-2 text-sm text-muted">Cancelar</Link></div>
          </form>
        </Card>
      )}

      <div className="mb-2 flex justify-end">
        <Link href={showArchived ? "/configuracoes/centros-de-custo" : "/configuracoes/centros-de-custo?arquivados=1"} className="text-sm text-brand">{showArchived ? "Esconder arquivados" : "Mostrar arquivados"}</Link>
      </div>
      {list.length === 0 ? <Empty title="Nenhum centro de custo" /> : (
        <Table head={["Código", "Centro de custo", "Tipo", "Loja", ""]}>
          {list.map(({ cc, depth }) => (
            <tr key={cc.id} className={`${depth === 0 ? "bg-surface-2/60 font-medium" : ""} ${cc.archived_at ? "opacity-50" : ""}`}>
              <td className="px-3 py-1.5 font-mono text-xs">{cc.code}</td>
              <td className="px-3 py-1.5" style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}>{cc.name}{cc.archived_at && <span className="ml-2"><Badge>arquivado</Badge></span>}</td>
              <td className="px-3 py-1.5"><Badge tone={cc.kind === "STORE" ? "brand" : "neutral"}>{KIND_LABEL[cc.kind] ?? cc.kind}</Badge>{cc.channel && <span className="ml-1 text-xs text-muted">{cc.channel}</span>}</td>
              <td className="px-3 py-1.5 text-xs">{storeOf.get(cc.id) ? <span>centro de resultado de <b>{storeOf.get(cc.id)}</b></span> : cc.store_id ? storeName.get(cc.store_id) : "—"}</td>
              <td className="px-3 py-1.5 text-right whitespace-nowrap">
                {canWrite && (
                  <span className="flex items-center justify-end gap-2 text-xs">
                    {!cc.archived_at && <Link href={`/configuracoes/centros-de-custo?editar=${cc.id}#form`} className="text-brand">Editar</Link>}
                    <form action={archiveCostCenterAction}><input type="hidden" name="id" value={cc.id} /><input type="hidden" name="archive" value={cc.archived_at ? "0" : "1"} /><button className="text-muted hover:text-text">{cc.archived_at ? "Reativar" : "Arquivar"}</button></form>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
