import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("conta a pagar: favorecido padrão sugere a categoria e o recebedor diferente aparece na lista", async ({ page }) => {
  test.setTimeout(90_000);
  const desc = `Energia E2E ${Date.now() % 100000}`;
  await login(page, "socio");
  await page.goto("/financeiro/pagar");
  await page.getByText("+ Novo lançamento").click();
  const form = page.locator("form").filter({ has: page.getByText("Recebedor do pagamento (se diferente)") });
  await form.locator("select").nth(1).selectOption({ label: "CELESC — energia" });
  await expect(form.getByText(/usa a categoria padrão: 7\.2\.07/)).toBeVisible();
  await form.locator("select").nth(2).selectOption({ label: "Caixa — FGTS" });
  await form.getByPlaceholder("Ex.: Honorários contábeis out/26").fill(desc);
  await form.locator("input[inputmode=decimal]").first().fill("350,00");
  await form.getByRole("button", { name: /Lançar|Salvar|Criar/ }).click();
  await expect(page.getByText("Lançamento criado")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("row").filter({ hasText: desc })).toContainText("recebe: Caixa — FGTS");
});
