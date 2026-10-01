import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("cadastros", () => {
  test("cria pessoa com CEP automático, vincula mãe e filha e a duplicada é mesclada", async ({ page }) => {
    test.setTimeout(90_000);
    await page.route("**/api/cep/*", (route) => route.fulfill({ json: { street: "Rua Esteves Júnior", district: "Centro", city: "Florianópolis", uf: "SC" } }));
    await login(page, "socio");
    const n = String(Date.now()).slice(-6);

    // mãe, com CEP preenchendo o endereço
    await page.goto("/cadastros/novo?tipo=pessoa");
    await page.getByLabel("Nome completo").fill(`Mãe E2E ${n}`);
    await page.getByLabel("Gênero").selectOption("F");
    await page.getByLabel("WhatsApp / telefone").fill(`(48) 9${n.slice(0, 4)}-${n.slice(2, 6)}`);
    await page.getByLabel("CEP").fill("88015-130");
    await expect(page.getByLabel("Logradouro")).toHaveValue("Rua Esteves Júnior", { timeout: 10_000 });
    await page.getByRole("button", { name: "Cadastrar pessoa" }).click();
    await expect(page).toHaveURL(/\/cadastros\/[0-9a-f-]{36}/, { timeout: 20_000 });
    await expect(page.getByText("Rua Esteves Júnior")).toBeVisible();
    const maeUrl = page.url().split("?")[0];

    // filha, vinculada à mãe
    await page.goto("/cadastros/novo?tipo=pessoa");
    await page.getByLabel("Nome completo").fill(`Filha E2E ${n}`);
    await page.getByLabel("Gênero").selectOption("F");
    await page.getByRole("button", { name: "Cadastrar pessoa" }).click();
    await expect(page).toHaveURL(/\/cadastros\/[0-9a-f-]{36}/, { timeout: 20_000 });
    await page.getByLabel("Pessoa (nome ou telefone)").fill(`Mãe E2E ${n}`);
    await page.getByLabel("Ela…").selectOption("PARENT");
    await page.getByRole("button", { name: "Vincular" }).click();
    await expect(page.getByText("Vínculo registrado")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/é mãe desta pessoa/)).toBeVisible();

    // do lado da mãe aparece a filha
    await page.goto(maeUrl);
    await expect(page.getByText(/é filha desta pessoa/)).toBeVisible({ timeout: 15_000 });

    // telefone repetido é recusado dizendo de quem é
    await page.goto("/cadastros/novo?tipo=pessoa");
    await page.getByLabel("Nome completo").fill(`Repetida ${n}`);
    await page.getByLabel("WhatsApp / telefone").fill(`(48) 9${n.slice(0, 4)}-${n.slice(2, 6)}`);
    await page.getByRole("button", { name: "Cadastrar pessoa" }).click();
    await expect(page.getByText(`Este contato já está no cadastro de Mãe E2E ${n}`)).toBeVisible({ timeout: 15_000 });
  });

  test("lista de empresas e busca por nome", async ({ page }) => {
    await login(page, "socio");
    await page.goto("/cadastros/empresas");
    await expect(page.getByRole("heading", { name: "Empresas" })).toBeVisible({ timeout: 20_000 });
    await page.goto("/cadastros/pessoas?q=Cliente+Teste");
    await expect(page.getByRole("link", { name: "Cliente Teste" })).toBeVisible();
  });
});
