import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** CNPJ válido (dígitos verificadores) a partir de 12 dígitos. */
function cnpjFrom(base12: string) {
  const dv = (b: string) => {
    const w = b.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = b.split("").reduce((s, d, i) => s + Number(d) * w[i], 0) % 11;
    return r < 2 ? "0" : String(11 - r);
  };
  const d1 = dv(base12);
  return base12 + d1 + dv(base12 + d1);
}

test("empresa nova: o CNPJ preenche o cadastro e a ficha mostra os dados da Receita", async ({ page }) => {
  test.setTimeout(90_000);
  const cnpj = cnpjFrom(`9${String(Date.now()).slice(-7)}0001`);
  const data = {
    cnpj, legal_name: `FORNECEDOR E2E ${cnpj.slice(0, 6)} LTDA`, trade_name: `Fornecedor E2E ${cnpj.slice(0, 6)}`, situation: "Ativa", situation_date: "2020-01-01",
    opened_at: "2015-03-10", branch: "Matriz", legal_nature: "Sociedade Empresária Limitada", size: "Micro Empresa", share_capital: 50000, simples: true, mei: false, tax_regime: null,
    cnae_main: { code: "4781400", description: "Comércio varejista de artigos do vestuário e acessórios" }, cnaes_secondary: [{ code: "4782201", description: "Comércio varejista de calçados" }],
    address: { cep: "88015130", street: "Rua Esteves Júnior", number: "100", complement: "", district: "Centro", city: "Florianópolis", uf: "SC", ibge: "4205407" },
    phones: [], email: "", state_registrations: [{ ie: "261234567", uf: "SC", active: true }],
    partners: [{ name: "SÓCIA E2E", role: "Sócio-Administrador", since: "2015-03-10", kind: "Pessoa Física" }], sources: ["BrasilAPI", "CNPJ.ws"], fetched_at: new Date().toISOString(),
  };
  await page.route(`**/api/cnpj/${cnpj}`, (route) => route.fulfill({ json: {
    data, legal_name: data.legal_name, trade_name: data.trade_name, cep: data.address.cep, street: data.address.street, number: data.address.number, complement: "",
    district: data.address.district, city: data.address.city, uf: "SC", situation: "Ativa", phone: "", phone2: "", email: "", ie: "261234567", cnae: "4781400", cnaes_secondary: ["4782201"],
  } }));
  await login(page, "socio");
  await page.goto("/cadastros/novo?tipo=empresa");
  await page.getByPlaceholder("00.000.000/0000-00").fill(cnpj);
  await expect(page.getByText(/Preenchido pela Receita/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Simples Nacional/).first()).toBeVisible();
  await page.getByRole("button", { name: "Cadastrar empresa" }).click();
  await expect(page).toHaveURL(/\/cadastros\/[0-9a-f-]{36}/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Dados da Receita" })).toBeVisible();
  await expect(page.getByText("situação: Ativa")).toBeVisible();
  await expect(page.getByText(/261234567 \(SC\)/)).toBeVisible();
  await expect(page.getByLabel("Logradouro").first()).toHaveValue("Rua Esteves Júnior");   // a ficha abre no formulário, já preenchido
});
