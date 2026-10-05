import type { CnpjData } from "@centralops/domain";
import { formatBRL } from "@centralops/domain";
import { Badge, Button, Card } from "@/components/ui";
import { refreshRegistryAction } from "../actions";

const fmtDate = (d: string | null | undefined) => (d ? d.split("-").reverse().join("/") : "—");
const fmtCnae = (c: string) => c.replace(/^(\d{4})(\d)(\d{2})$/, "$1-$2/$3");
const yesNo = (v: boolean | null) => (v === null ? "—" : v ? "Sim" : "Não");

/** Dados da Receita (consulta de CNPJ) na ficha da empresa, com botão para consultar de novo. */
export function RegistryCard({ id, hasCnpj, registry, registryAt, canWrite }: { id: string; hasCnpj: boolean; registry: CnpjData | null; registryAt: string | null; canWrite: boolean }) {
  const r = registry;
  const ativa = !r || r.situation.toLowerCase() === "ativa";
  return (
    <Card title="Dados da Receita" className="lg:col-span-2">
      {!r ? (
        <p className="text-sm text-muted">{hasCnpj ? "Ainda não consultado. Consulte para trazer situação, CNAEs, Simples/MEI, inscrição estadual e sócios." : "Cadastre o CNPJ na identidade para consultar a Receita."}</p>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={ativa ? "success" : "danger"}>situação: {r.situation || "—"}</Badge>
            {!ativa && <span className="text-danger">Atenção antes de pagar ou faturar: a empresa não está ativa na Receita.</span>}
            {r.simples && <Badge tone="info">Simples Nacional</Badge>}
            {r.mei && <Badge tone="info">MEI</Badge>}
            <span className="text-xs text-muted">consultado em {registryAt ? new Date(registryAt).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—"} · fonte: {r.sources.join(", ")}</span>
          </div>
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-3">
            <div><dt className="text-xs text-muted">Razão social</dt><dd>{r.legal_name}</dd></div>
            <div><dt className="text-xs text-muted">Abertura</dt><dd>{fmtDate(r.opened_at)} · {r.branch || "—"}</dd></div>
            <div><dt className="text-xs text-muted">Natureza jurídica</dt><dd>{r.legal_nature || "—"}</dd></div>
            <div><dt className="text-xs text-muted">Porte</dt><dd>{r.size || "—"}</dd></div>
            <div><dt className="text-xs text-muted">Capital social</dt><dd>{r.share_capital != null ? formatBRL(r.share_capital) : "—"}</dd></div>
            <div><dt className="text-xs text-muted">Regime tributário</dt><dd>{r.tax_regime ?? (r.simples ? "Simples Nacional" : "—")}</dd></div>
            <div><dt className="text-xs text-muted">Optante Simples / MEI</dt><dd>{yesNo(r.simples)} / {yesNo(r.mei)}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-muted">Inscrição estadual</dt><dd>{r.state_registrations.length ? r.state_registrations.map((i) => `${i.ie} (${i.uf}${i.active ? "" : ", inativa"})`).join(" · ") : "não informada pelas fontes"}</dd></div>
          </dl>
          {r.cnae_main && (
            <div>
              <p className="text-xs text-muted">Atividade principal</p>
              <p>{fmtCnae(r.cnae_main.code)} {r.cnae_main.description}</p>
              {r.cnaes_secondary.length > 0 && (
                <details className="mt-1"><summary className="cursor-pointer text-xs text-brand">{r.cnaes_secondary.length} atividade(s) secundária(s)</summary>
                  <ul className="mt-1 list-disc pl-5 text-xs">{r.cnaes_secondary.map((c) => <li key={c.code}>{fmtCnae(c.code)} {c.description}</li>)}</ul>
                </details>
              )}
            </div>
          )}
          {r.partners.length > 0 && (
            <details><summary className="cursor-pointer text-xs text-brand">Quadro societário ({r.partners.length})</summary>
              <ul className="mt-1 list-disc pl-5 text-xs">{r.partners.map((p, i) => <li key={`${p.name}-${i}`}>{p.name} — {p.role || "sócio"}{p.since ? ` desde ${fmtDate(p.since)}` : ""}</li>)}</ul>
            </details>
          )}
        </div>
      )}
      {canWrite && hasCnpj && (
        <form action={refreshRegistryAction} className="mt-3">
          <input type="hidden" name="id" value={id} />
          <Button variant="secondary">{r ? "Atualizar pela Receita" : "Consultar a Receita"}</Button>
          <span className="ml-2 text-xs text-muted">Só preenche o que estiver vazio no cadastro; não apaga nada.</span>
        </form>
      )}
    </Card>
  );
}
