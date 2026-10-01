import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("réguas", () => {
  test("régua padrão: adiciona passo, liga, desliga e remove o passo", async ({ page }) => {
    await login(page, "socio");
    await page.goto("/marketing/reguas");
    await expect(page.getByRole("heading", { name: "Réguas de relacionamento" })).toBeVisible();
    await page.getByRole("link", { name: "Segunda compra" }).click();
    await expect(page.getByText("Sem 2ª compra · 10% no grupo de controle")).toBeVisible({ timeout: 20_000 });

    const step = page.locator("form").filter({ has: page.getByRole("button", { name: "Salvar passo" }) });
    await step.locator("input[name=position]").fill("9");
    await step.locator("input[name=wait_days]").fill("7");
    await step.locator("input[name=title]").fill("E2E lembrete para {nome}");
    await step.locator("textarea[name=message]").fill("Oi, {nome}! Ainda dá tempo de provar as novidades.");
    await step.getByRole("button", { name: "Salvar passo" }).click();
    await expect(page.getByText("Passo salvo")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("row").filter({ hasText: "E2E lembrete" })).toContainText("7 dia(s) depois");

    await page.getByRole("button", { name: "Ligar" }).click();
    await expect(page.getByText("Régua ligada")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Desligar" }).click();
    await expect(page.getByText("Régua desligada")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("row").filter({ hasText: "E2E lembrete" }).getByRole("button", { name: "Remover" }).click();
    await expect(page.getByText("Passo removido")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("row").filter({ hasText: "E2E lembrete" })).toHaveCount(0);
  });
});
