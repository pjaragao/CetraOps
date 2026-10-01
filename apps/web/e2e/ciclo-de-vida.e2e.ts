import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Cliente do seed (supabase/seed/90_dev_demo.sql). */
const CLIENTE = "00000000-0000-4000-8000-000000000501";

test.describe("ciclo de vida", () => {
  test("painel do ciclo de vida e regras editáveis aparecem para o sócio", async ({ page }) => {
    await login(page, "socio");
    await page.goto("/clientes/ciclo-de-vida");
    await expect(page.getByRole("heading", { name: "Ciclo de vida", exact: true })).toBeVisible();
    await expect(page.getByText("Segmentos (quem já comprou)")).toBeVisible();
    await expect(page.getByLabel("Inativa a partir de (dias)")).toHaveValue("120");
  });

  test("a vendedora completa a ficha e o score explica o novo sinal", async ({ page }) => {
    await login(page, "vendedora");
    await page.goto(`/clientes/${CLIENTE}`);
    await page.getByRole("link", { name: "Editar ficha" }).click();
    await page.getByLabel("Atividades").fill("pilates, corrida");
    await page.getByLabel("Top", { exact: true }).fill("m");
    await expect(page.getByLabel("Nível")).toBeDisabled();            // só sócios mudam o nível à mão
    await page.getByRole("button", { name: "Salvar ficha" }).click();
    await expect(page.getByText("Ficha atualizada")).toBeVisible();
    await expect(page.getByText("Pratica pilates")).toBeVisible();
    await expect(page.getByText("Top M")).toBeVisible();
    await expect(page.getByText(/Por que o score é \d+/)).toBeVisible();
  });
});
