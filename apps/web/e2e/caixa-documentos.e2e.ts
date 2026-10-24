import http from "node:http";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Caixa de documentos com o MODELO FALSO (127.0.0.1:4010, como em central.e2e.ts): a "leitura" da foto devolve um boleto; a tela mostra a
 * linha com o destino sugerido, lança a conta a pagar e reconhece o mesmo arquivo quando ele volta.
 */
const nulls = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, null]));
let reading: unknown = null;
let server: http.Server;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ model: "falso/visao", usage: {}, choices: [{ message: { role: "assistant", content: JSON.stringify(reading) } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(4010, "127.0.0.1", r));
});
test.afterAll(async () => { await new Promise((r) => server.close(r)); });

/** PNG mínimo com bytes aleatórios no fim: cada execução manda um arquivo diferente (outro sha256). */
function png(): Buffer {
  const head = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b20000000049454e44ae426082", "hex");
  return Buffer.concat([head, Buffer.from(String(Math.random()))]);
}

test("boleto por foto: entra na fila como conta a pagar, é lançado e não entra de novo", async ({ page }) => {
  test.setTimeout(120_000);
  const cents = 1000 + Math.floor(Math.random() * 90000);
  const valor = cents / 100;
  const who = `Energia E2E ${cents}`;
  reading = {
    tipo: "boleto", confianca: 0.95,
    identidade: nulls(["nome", "cpf", "data_nascimento", "documento_tipo", "documento_numero", "orgao_uf"]),
    boleto: { linha_digitavel: null, beneficiario: who, beneficiario_cnpj: null, valor, vencimento: "2026-12-10", descricao: `Conta de luz ${cents}` },
    pix_copia_e_cola: null,
    comprovante: nulls(["emitente", "emitente_cnpj", "valor_total", "data", "chave_acesso", "descricao"]),
    endereco: nulls(["cep", "logradouro", "numero", "complemento", "bairro", "cidade", "uf"]),
    etiqueta: nulls(["referencia", "nome", "cor", "tamanho", "codigo_barras"]),
    observacoes: null,
  };
  const file = { name: `boleto-${cents}.png`, mimeType: "image/png", buffer: png() };

  await login(page, "socio");
  await page.goto("/financeiro/documentos");
  await expect(page.getByRole("heading", { name: "Caixa de documentos" })).toBeVisible();
  await page.getByLabel("Escolher documentos").setInputFiles(file);
  await expect(page.getByRole("list", { name: "Envios" }).getByText(`Boleto de ${who}`)).toBeVisible({ timeout: 30_000 });

  const row = page.locator(`li[data-doc="Boleto de ${who}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByLabel(`Destino de Boleto de ${who}`)).toHaveValue("PAYABLE");         // destino sugerido: conta a pagar
  await expect(row.getByLabel(`Valor de Boleto de ${who}`)).toHaveValue(valor.toFixed(2).replace(".", ","));
  await row.getByRole("button", { name: "Lançar" }).click();
  await expect(page.getByText(/Lançado: Conta a pagar PAG-\d{4}-\d+/)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`li[data-doc="Boleto de ${who}"]`)).toHaveCount(0);

  // o mesmo arquivo de novo: não lê outra vez nem duplica
  await page.getByLabel("Escolher documentos").setInputFiles(file);
  await expect(page.getByRole("list", { name: "Envios" }).getByText("já estava na caixa (lançado)")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`li[data-doc="Boleto de ${who}"]`)).toHaveCount(0);

  await page.goto("/financeiro/pagar");
  await expect(page.getByText(`Conta de luz ${cents}`).first()).toBeVisible({ timeout: 20_000 });
});
