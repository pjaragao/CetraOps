import { expect, test } from "@playwright/test";
import { DEV_CONVERSATION, login } from "./helpers";

test.describe("para ela agora e benefícios", () => {
  test("painel da conversa e ficha mostram o que oferecer; sócio vê os benefícios por nível", async ({ page }) => {
    await login(page, "socio");
    await page.goto(`/atendimento?c=${DEV_CONVERSATION}`);
    await expect(page.getByText("Para ela agora")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Novidades no tamanho dela/).first()).toBeVisible();

    await page.goto("/clientes/ciclo-de-vida");
    await expect(page.getByText("Benefícios por nível")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("VIP", { exact: true })).toHaveValue(/Pré-venda/);
  });
});
