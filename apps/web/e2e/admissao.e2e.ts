import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("admissão e freelancer", () => {
  test("intermitente é explicado como CLT e o CEP preenche o endereço", async ({ page }) => {
    await page.route("**/api/cep/*", (route) => route.fulfill({ json: { street: "Rua Esteves Júnior", district: "Centro", city: "Florianópolis", uf: "SC" } }));
    await login(page, "socio");
    await page.goto("/equipe/novo");
    await page.getByLabel("Vínculo").selectOption("INTERMITENTE");
    await expect(page.getByRole("note")).toContainText("Intermitente é CLT");
    await page.getByLabel("Vínculo").selectOption("TEMPORARIO");
    await expect(page.getByRole("note")).toContainText("Temporário é CLT");
    await page.getByLabel("Vínculo").selectOption("ESTAGIO");
    await expect(page.getByRole("note")).toContainText("não é CLT");

    await page.getByLabel("CEP").fill("88015-130");
    await expect(page.getByLabel("Logradouro")).toHaveValue("Rua Esteves Júnior", { timeout: 10_000 });
    await expect(page.getByLabel("Cidade")).toHaveValue("Florianópolis");
    await expect(page.getByLabel("UF", { exact: true })).toHaveValue("SC");
  });

  test("freelancer MEI vira conta a pagar em rascunho, sem colaborador", async ({ page }) => {
    await login(page, "socio");
    await page.goto("/equipe/novo?tipo=freelancer");
    const nome = `Foto E2E ${Date.now() % 100000}`;
    await page.getByLabel("Nome / razão social").fill(nome);
    await page.getByLabel("CNPJ").fill("11.222.333/0001-81");
    await page.getByLabel("Serviço", { exact: true }).fill("Fotos do Drop E2E");
    await page.getByLabel("Valor combinado (R$)").fill("450,00");
    await page.getByLabel("Dia 1").fill("2030-05-10");
    await page.getByRole("button", { name: "Cadastrar e gerar conta a pagar" }).click();
    await expect(page).toHaveURL(/\/financeiro\/pagar/, { timeout: 20_000 });
    await expect(page.getByText("Freelancer cadastrado e conta a pagar criada")).toBeVisible();
  });
});
