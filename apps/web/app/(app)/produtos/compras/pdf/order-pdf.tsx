"use client";
import { useMemo, useState, useTransition } from "react";
import { formatBRL, parseOrderPdf, sameName, type OrderPdf } from "@centralops/domain";
import { readPdf } from "@/lib/pdf-reader";
import { Badge, Button, Card, inputClass } from "@/components/ui";
import { PoEditor, type PoInitial } from "../po-editor";
import { checkOrderLines, prepareOrderItems, type LineCheck, type LineStatus } from "./actions";

type Opts = Omit<Parameters<typeof PoEditor>[0], "initial">;

const STATUS: Record<LineStatus, { label: string; tone: "success" | "info" | "warning" | "danger" }> = {
  OK: { label: "no catálogo", tone: "success" },
  NEW_VARIANT: { label: "tamanho novo", tone: "info" },
  NEW_COLOR: { label: "cor nova", tone: "info" },
  NEW_PRODUCT: { label: "produto novo", tone: "warning" },
  UNKNOWN: { label: "não reconhecido", tone: "danger" },
};

/** Pedido da marca em PDF → conferência das linhas → cadastro do que falta → editor do pedido de compra já preenchido. */
export function OrderPdfImport({ opts, canCatalog }: { opts: Opts; canCatalog: boolean }) {
  const [order, setOrder] = useState<OrderPdf | null>(null);
  const [checks, setChecks] = useState<LineCheck[]>([]);
  const [names, setNames] = useState<Record<string, { name: string; gender: "FEM" | "MASC" | "UNISSEX" }>>({});
  const [initial, setInitial] = useState<PoInitial | null>(null);
  const [notice, setNotice] = useState<{ ok?: string; errors: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const onFile = (f: File | undefined) => {
    if (!f) return;
    setOrder(null); setChecks([]); setInitial(null); setNotice(null); setError(null);
    start(async () => {
      try {
        setProgress("Lendo o PDF…");
        const { pages } = await readPdf(f, { onProgress: (d, t) => setProgress(`Lendo página ${d} de ${t}…`) });
        const o = parseOrderPdf(pages);
        setProgress(null);
        if (o.lines.length === 0) { setError("Nenhum item encontrado. O PDF precisa ter uma tabela com código, quantidade e preço (PDF escaneado, como foto, não dá para ler)."); return; }
        const c = await checkOrderLines(o.lines.map(({ code, model, colorCode, size, color, description }) => ({ code, model, colorCode, size, color, description })));
        if ("error" in c) { setError(c.error); return; }
        setOrder(o); setChecks(c);
        // nome sugerido para cada modelo novo: a descrição do PDF
        const n: typeof names = {};
        o.lines.forEach((l, i) => { if (c[i].status === "NEW_PRODUCT" && l.model && !n[l.model]) n[l.model] = { name: l.description, gender: "FEM" }; });
        setNames(n);
      } catch (e) {
        setProgress(null);
        setError(`Não foi possível ler o PDF: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  };

  const counts = useMemo(() => {
    const m = new Map<LineStatus, number>();
    for (const c of checks) m.set(c.status, (m.get(c.status) ?? 0) + 1);
    return m;
  }, [checks]);
  const toCreate = checks.filter((c) => c.status !== "OK" && c.status !== "UNKNOWN").length;

  const prepare = () => order && start(async () => {
    setError(null);
    const res = await prepareOrderItems({ lines: order.lines.map(({ code, model, colorCode, size, color, description, qty, unitCost }) => ({ code, model, colorCode, size, color, description, qty, unitCost })), newProducts: names });
    if ("error" in res) { setError(res.error); return; }
    const created = [res.created.produtos && `${res.created.produtos} produto(s)`, res.created.cores && `${res.created.cores} cor(es)`, res.created.variantes && `${res.created.variantes} variação(ões)`].filter(Boolean).join(", ");
    setNotice({ ok: `${res.items.length} item(ns) no pedido${created ? ` · cadastrado(s): ${created}` : ""}. Escolha o fornecedor e confira antes de salvar.`, errors: res.errors });
    const who = order.supplierName ?? order.representative ?? "";
    const supplier = who ? opts.suppliers.find((s) => sameName(s.name, who) || s.name.toLowerCase().includes(who.toLowerCase())) : undefined;
    setInitial({
      items: res.items, supplier_party_id: supplier?.id,
      notes: [order.number && `Pedido/orçamento ${order.number}`, who && `${who}`, order.date && `de ${order.date.split("-").reverse().join("/")}`, "(importado do PDF)"].filter(Boolean).join(" "),
    });
  });

  return (
    <div className="space-y-4">
      <Card title="1. Arquivo do pedido">
        <input type="file" accept="application/pdf,.pdf" disabled={pending} onChange={(e) => onFile(e.target.files?.[0])} className="text-sm" aria-label="PDF do pedido" />
        <p className="mt-2 text-xs text-muted">O PDF é lido aqui no navegador. Precisa ter a tabela com código da peça, quantidade e preço (como o pedido do showroom).
          O código no padrão da etiqueta (modelo + cor + tamanho, ex.: 17046390P) liga a linha ao catálogo; cor e tamanho que faltam são cadastrados.</p>
        {progress && <p className="mt-2 text-sm text-muted">{progress}</p>}
        {error && <p role="alert" className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      </Card>

      {order && !initial && (
        <Card title={`2. Conferência · ${order.lines.length} linha(s) · ${order.totalQty} peça(s) · ${formatBRL(order.total)}`}
          action={<Button disabled={pending || (toCreate > 0 && !canCatalog)} onClick={prepare}>{pending ? "Preparando…" : toCreate ? `Cadastrar ${toCreate} peça(s) e montar o pedido` : "Montar o pedido"}</Button>}>
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            {order.number && <span>Nº <b>{order.number}</b></span>}
            {order.date && <span>· {order.date.split("-").reverse().join("/")}</span>}
            {(order.supplierName ?? order.representative) && <span>· {order.supplierName ?? order.representative}</span>}
            <span className="ml-auto flex flex-wrap gap-1">{[...counts].map(([s, n]) => <Badge key={s} tone={STATUS[s].tone}>{n} {STATUS[s].label}</Badge>)}</span>
          </div>
          {order.warnings.length > 0 && <ul className="mb-3 list-disc pl-5 text-sm text-warning">{order.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          {toCreate > 0 && !canCatalog && <p className="mb-3 text-sm text-danger">Há peças fora do catálogo e você não tem permissão para cadastrá-las.</p>}
          {Object.keys(names).length > 0 && (
            <div className="mb-3 space-y-2 rounded-lg bg-surface-2 p-3">
              <p className="text-sm font-medium">Modelos novos: confira o nome que vai para o catálogo</p>
              {Object.entries(names).map(([model, v]) => (
                <div key={model} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-16 font-mono">{model}</span>
                  <input value={v.name} onChange={(e) => setNames((p) => ({ ...p, [model]: { ...v, name: e.target.value } }))} className={`${inputClass} max-w-xs`} aria-label={`Nome do modelo ${model}`} />
                  <select value={v.gender} onChange={(e) => setNames((p) => ({ ...p, [model]: { ...v, gender: e.target.value as typeof v.gender } }))} className={`${inputClass} w-32`} aria-label={`Linha do modelo ${model}`}>
                    <option value="FEM">Feminino</option><option value="MASC">Masculino</option><option value="UNISSEX">Unissex</option>
                  </select>
                </div>
              ))}
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-xs text-muted"><tr><th className="px-3 py-2">Código</th><th className="px-3 py-2">Descrição (PDF)</th><th className="px-3 py-2">Cor</th><th className="px-3 py-2">Tam.</th><th className="px-3 py-2 text-right">Qtd</th><th className="px-3 py-2 text-right">Custo</th><th className="px-3 py-2">Catálogo</th></tr></thead>
              <tbody className="divide-y divide-border">
                {order.lines.map((l, i) => {
                  const c = checks[i];
                  return (
                    <tr key={`${l.code}-${i}`}>
                      <td className="px-3 py-1.5 font-mono text-xs">{l.code}</td>
                      <td className="px-3 py-1.5">{l.description}{c?.product && c.product !== l.description && <span className="block text-xs text-muted">{c.product}</span>}</td>
                      <td className="px-3 py-1.5">{l.color}{l.colorCode && <span className="text-xs text-muted"> ({l.colorCode}{c?.color && !sameName(c.color, l.color) ? ` = ${c.color}` : ""})</span>}</td>
                      <td className="px-3 py-1.5">{l.size}</td>
                      <td className="px-3 py-1.5 text-right">{l.qty}</td>
                      <td className="px-3 py-1.5 text-right">{formatBRL(l.unitCost)}</td>
                      <td className="px-3 py-1.5">{c && <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {initial && (
        <>
          {notice && (
            <div className="space-y-1 rounded-lg bg-success/10 px-3 py-2 text-sm">
              {notice.ok && <p className="text-success">{notice.ok}</p>}
              {notice.errors.length > 0 && <ul className="list-disc pl-5 text-danger">{notice.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
            </div>
          )}
          <PoEditor {...opts} initial={initial} />
        </>
      )}
    </div>
  );
}
