import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Table } from "./data-table";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const foot = (s: string) => /<tfoot[^>]*>(.*)<\/tfoot>/.exec(s)?.[1] ?? "";

describe("Table: total no rodapé", () => {
  it("soma as colunas em R$ e ignora preço/saldo marcados", () => {
    const s = html(
      <Table head={["Item", "Preço", "Total", "Situação"]}>
        <tr><td>A</td><td>R$ 10,00</td><td>R$ 1.000,50</td><td>ok</td></tr>
        <tr><td>B</td><td>R$ 20,00</td><td>R$ 99,50</td><td>ok</td></tr>
        <tr><td>C</td><td>R$ 30,00</td><td>—</td><td>ok</td></tr>
      </Table>,
    );
    const f = foot(s);
    expect(f).toContain("Total");
    expect(f).toContain("R$ 1.100,00");
    expect(f).not.toContain("R$ 60,00");   // preço unitário não soma
  });

  it("soma contagens só com cabeçalho de quantidade e respeita noTotal/totals={false}", () => {
    const rows = [<tr key="1"><td>A</td><td>2</td><td>7</td><td>R$ 5,00</td></tr>, <tr key="2"><td>B</td><td>3</td><td>9</td><td>R$ 5,00</td></tr>];
    const f = foot(html(<Table head={["Item", "Qtd", "Código", "Saldo"]} noTotal={[3]}>{rows}</Table>));
    expect(f).toContain(">5<");        // Qtd 2 + 3
    expect(f).not.toContain(">16<");   // "Código" não é contagem
    expect(f).not.toContain("R$ 10,00");
    expect(html(<Table head={["Item", "Qtd", "Código", "Saldo"]} totals={false}>{rows}</Table>)).not.toContain("<tfoot");
  });

  it("linha data-pin fica fora da soma", () => {
    const f = foot(html(
      <Table head={["Conta", "Valor"]}>
        <tr><td>A</td><td>R$ 1,00</td></tr>
        <tr><td>B</td><td>R$ 2,00</td></tr>
        <tr data-pin><td>Resultado</td><td>R$ 100,00</td></tr>
      </Table>,
    ));
    expect(f).toContain("R$ 3,00");
  });
});

describe("Table: seleção em lote", () => {
  it("só linhas com data-select ganham caixinha; sem bulk não há coluna de seleção", () => {
    const rows = [<tr key="1" data-select="a"><td>A</td><td>R$ 1,00</td></tr>, <tr key="2"><td>B</td><td>R$ 2,00</td></tr>];
    const withBulk = html(<Table head={["Nome", "Valor"]} bulk={[{ label: "Aprovar", href: "/x?ids={ids}" }]}>{rows}</Table>);
    expect(withBulk.match(/type="checkbox"/g)?.length).toBe(2);   // cabeçalho + linha A
    expect(withBulk).toContain('aria-label="Selecionar A"');
    expect(html(<Table head={["Nome", "Valor"]}>{rows}</Table>)).not.toContain('type="checkbox"');
  });
});
