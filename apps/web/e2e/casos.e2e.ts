import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Cliente do seed (supabase/seed/90_dev_demo.sql). */
const CLIENTE = "00000000-0000-4000-8000-000000000501";

test.describe("casos e NPS", () => {
  test("abre um caso, responde, resolve com solução e o NPS baixo abre outro caso", async ({ page }) => {
    test.setTimeout(90_000);
    await login(page, "socio");
    const titulo = `Costura aberta E2E ${Date.now() % 100000}`;
    await page.goto(`/clientes/${CLIENTE}`);
    await page.getByLabel("O que aconteceu").fill(titulo);
    await page.getByRole("button", { name: "Abrir caso" }).click();
    await expect(page.getByText(/Caso CAS-\d{4}-\d{6} aberto/)).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/clientes\/casos|\/clientes\//);

    await page.goto("/clientes/casos");
    const caso = page.getByRole("listitem").filter({ hasText: titulo });
    await expect(caso).toBeVisible({ timeout: 20_000 });
    await caso.getByRole("button", { name: "Já respondi" }).click();
    await expect(page.getByText("Primeira resposta registrada")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("listitem").filter({ hasText: titulo }).getByLabel(/Solução do/).fill("Troca pela peça nova na loja");
    await page.getByRole("listitem").filter({ hasText: titulo }).getByRole("button", { name: "Resolver" }).click();
    await expect(page.getByText("Caso resolvido e retorno agendado")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("link", { name: "Resolvidos" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: titulo })).toContainText("Troca pela peça nova na loja");

    // NPS baixo abre caso de detratora
    await page.goto(`/clientes/${CLIENTE}`);
    await page.getByLabel("Nota NPS").fill("4");
    await page.getByRole("button", { name: "Registrar" }).last().click();
    await expect(page.getByText("NPS registrado")).toBeVisible({ timeout: 15_000 });
    await page.goto("/clientes/casos");
    await expect(page.getByText(/NPS 4: detratora/).first()).toBeVisible({ timeout: 15_000 });
  });
});
