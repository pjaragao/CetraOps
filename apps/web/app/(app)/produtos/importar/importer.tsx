"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Button, Card, inputClass, Table } from "@/components/ui";
import { parseBRNumber, parseDelimited, suggestPrice } from "@centralops/domain";
import { importCatalog, type ImportRow } from "./actions";

const HEADER_MAP: Record<string, keyof ImportRow> = {
  referencia: "reference_code", "referência": "reference_code", ref: "reference_code", codigo: "reference_code", "código": "reference_code",
  nome: "name", produto: "name", descricao: "name", "descrição": "name", genero: "gender", "gênero": "gender", linha: "gender",
  categoria: "category", ncm: "ncm", cor: "color", tamanho: "size", tam: "size",
  ean: "gtin", gtin: "gtin", "codigo de barras": "gtin", "código de barras": "gtin", preco: "price", "preço": "price", "preco venda": "price", "preço venda": "price",
  quantidade: "qty", qtd: "qty", estoque: "qty", saldo: "qty", custo: "cost", "preco custo": "cost", "preço custo": "cost",
  marca: "brand", colecao: "collection", "coleção": "collection", drop: "collection",
};

/** Planilha → linhas. Números no formato brasileiro viram ponto decimal; vazio continua vazio (não mexe no que já existe). */
function parseCsv(text: string): ImportRow[] {
  const rows = parseDelimited(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => HEADER_MAP[h.trim().toLowerCase()]);
  const num = (v: string | undefined) => { const n = parseBRNumber(v); return n === null ? "" : String(n); };
  return rows.slice(1).map((cells) => {
    const row: Partial<Record<keyof ImportRow, string>> = {};
    header.forEach((key, i) => { if (key) row[key] = cells[i] ?? ""; });
    const gender = (row.gender ?? "").toUpperCase();
    return {
      reference_code: row.reference_code ?? "", name: row.name ?? "",
      gender: gender.startsWith("M") ? "MASC" : gender.startsWith("U") ? "UNISSEX" : "FEM",
      category: row.category ?? "", ncm: row.ncm ?? "", color: row.color || "Única", size: row.size ?? "",
      gtin: (row.gtin ?? "").replace(/\D/g, ""), price: num(row.price), qty: num(row.qty), cost: num(row.cost),
      brand: row.brand ?? "", collection: row.collection ?? "",
    };
  });
}

export function CatalogImporter({ locations, canStock }: { locations: { id: string; name: string }[]; canStock: boolean }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [result, setResult] = useState<Awaited<ReturnType<typeof importCatalog>> | null>(null);
  const [pending, start] = useTransition();
  const [location, setLocation] = useState(locations[0]?.id ?? "");
  const [markup, setMarkup] = useState("2,40");
  const hasStock = rows.some((r) => r.qty !== "" || r.cost !== "");
  const missingPrice = rows.filter((r) => r.price === "" && r.cost !== "").length;
  const fillPrices = () => {
    const m = parseBRNumber(markup) ?? 0;
    setRows((p) => p.map((r) => (r.price === "" && r.cost !== "" ? { ...r, price: String(suggestPrice(Number(r.cost), m)) } : r)));
  };

  const onFile = async (f: File | undefined) => { if (f) { const t = await f.text(); setFileName(f.name); setText(t); setRows(parseCsv(t)); } };

  return (
    <div className="space-y-4">
      <Card>
        <input type="file" accept=".csv,.txt,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="mb-3 text-sm" aria-label="Arquivo CSV" />
        <textarea value={text} onChange={(e) => { setText(e.target.value); setFileName(""); setRows(parseCsv(e.target.value)); }} rows={8}
          placeholder="…ou cole aqui o conteúdo da planilha" className={`${inputClass} font-mono text-xs`} aria-label="Conteúdo CSV" />
      </Card>
      {rows.length > 0 && (
        <Card title={`Prévia: ${rows.length} linhas`} action={<Button disabled={pending || (hasStock && (!canStock || !location))} onClick={() => start(async () => setResult(await importCatalog(rows, hasStock ? location : undefined, fileName || "planilha colada")))}>{pending ? "Importando…" : "Importar"}</Button>}>
          {hasStock && (
            <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
              {canStock ? (
                <label className="text-xs text-muted">A quantidade da planilha vira o saldo em
                  <select value={location} onChange={(e) => setLocation(e.target.value)} className={`${inputClass} mt-1`}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
                </label>
              ) : <p className="text-danger">A planilha tem quantidade/custo: só quem pode movimentar estoque importa assim.</p>}
              {missingPrice > 0 && (
                <span className="flex items-end gap-2"><label className="text-xs text-muted">Markup<input value={markup} onChange={(e) => setMarkup(e.target.value)} className={`${inputClass} mt-1 w-20`} /></label>
                  <Button type="button" variant="secondary" onClick={fillPrices}>Sugerir preço em {missingPrice} linha(s) sem preço</Button></span>
              )}
            </div>
          )}
          <Table head={["Ref.", "Nome", "Linha", "Cor", "Tam.", "EAN", "Preço", "Qtd", "Custo"]} noTotal={[8]}>
            {rows.slice(0, 50).map((r, i) => (
              <tr key={i}><td className="px-3 py-1.5">{r.reference_code}</td><td className="px-3 py-1.5">{r.name}</td><td className="px-3 py-1.5">{r.gender}</td>
                <td className="px-3 py-1.5">{r.color}</td><td className="px-3 py-1.5">{r.size}</td><td className="px-3 py-1.5">{r.gtin}</td><td className="px-3 py-1.5">{r.price}</td><td className="px-3 py-1.5">{r.qty}</td><td className="px-3 py-1.5">{r.cost}</td></tr>
            ))}
          </Table>
          {rows.length > 50 && <p className="mt-2 text-xs text-muted">Mostrando 50 de {rows.length}.</p>}
        </Card>
      )}
      {result && (
        <Card title="Resultado">
          {"error" in result ? <p className="text-sm text-danger">{result.error}</p> : (
            <>
              <p className="text-sm">{result.linhas} linhas · {result.variantes} variantes gravadas · {result.precos} preços novos · {result.estoque ?? 0} saldos ajustados.</p>
              <p className="mt-1 text-sm"><Link className="text-brand" href="/produtos/etiquetas">Imprimir as etiquetas</Link></p>
              {result.erros.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm text-danger">{result.erros.map((e) => <li key={e.linha}>Linha {e.linha + 1}: {e.erro}</li>)}</ul>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
}
