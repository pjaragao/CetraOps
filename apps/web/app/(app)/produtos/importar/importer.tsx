"use client";
import { useState, useTransition } from "react";
import { Button, Card, inputClass, Table } from "@/components/ui";
import { importCatalog, type ImportRow } from "./actions";

const HEADER_MAP: Record<string, keyof ImportRow> = {
  referencia: "reference_code", "referência": "reference_code", ref: "reference_code",
  nome: "name", produto: "name", genero: "gender", "gênero": "gender", linha: "gender",
  categoria: "category", ncm: "ncm", cor: "color", tamanho: "size", tam: "size",
  ean: "gtin", gtin: "gtin", preco: "price", "preço": "price",
};

function parseCsv(text: string): ImportRow[] {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const header = lines[0].split(sep).map((h) => HEADER_MAP[h.trim().toLowerCase()]);
  return lines.slice(1).map((line) => {
    const cells = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
    const row: Partial<Record<keyof ImportRow, string>> = {};
    header.forEach((key, i) => { if (key) row[key] = cells[i] ?? ""; });
    const gender = (row.gender ?? "").toUpperCase();
    return {
      reference_code: row.reference_code ?? "", name: row.name ?? "",
      gender: gender.startsWith("M") ? "MASC" : gender.startsWith("U") ? "UNISSEX" : "FEM",
      category: row.category ?? "", ncm: row.ncm ?? "", color: row.color ?? "Única", size: row.size ?? "",
      gtin: row.gtin ?? "", price: (row.price ?? "").replace(/\./g, "").replace(",", "."),
    };
  });
}

export function CatalogImporter() {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [result, setResult] = useState<Awaited<ReturnType<typeof importCatalog>> | null>(null);
  const [pending, start] = useTransition();

  const onFile = async (f: File | undefined) => { if (f) { const t = await f.text(); setText(t); setRows(parseCsv(t)); } };

  return (
    <div className="space-y-4">
      <Card>
        <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="mb-3 text-sm" aria-label="Arquivo CSV" />
        <textarea value={text} onChange={(e) => { setText(e.target.value); setRows(parseCsv(e.target.value)); }} rows={8}
          placeholder="…ou cole aqui o conteúdo da planilha" className={`${inputClass} font-mono text-xs`} aria-label="Conteúdo CSV" />
      </Card>
      {rows.length > 0 && (
        <Card title={`Prévia: ${rows.length} linhas`} action={<Button disabled={pending} onClick={() => start(async () => setResult(await importCatalog(rows)))}>{pending ? "Importando…" : "Importar"}</Button>}>
          <Table head={["Ref.", "Nome", "Linha", "Cor", "Tam.", "EAN", "Preço"]}>
            {rows.slice(0, 50).map((r, i) => (
              <tr key={i}><td className="px-3 py-1.5">{r.reference_code}</td><td className="px-3 py-1.5">{r.name}</td><td className="px-3 py-1.5">{r.gender}</td>
                <td className="px-3 py-1.5">{r.color}</td><td className="px-3 py-1.5">{r.size}</td><td className="px-3 py-1.5">{r.gtin}</td><td className="px-3 py-1.5">{r.price}</td></tr>
            ))}
          </Table>
          {rows.length > 50 && <p className="mt-2 text-xs text-muted">Mostrando 50 de {rows.length}.</p>}
        </Card>
      )}
      {result && (
        <Card title="Resultado">
          {"error" in result ? <p className="text-sm text-danger">{result.error}</p> : (
            <>
              <p className="text-sm">{result.linhas} linhas · {result.variantes} variantes gravadas · {result.precos} preços novos.</p>
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
