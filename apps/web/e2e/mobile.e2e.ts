import { expect, test } from "@playwright/test";
import { DEV_CONVERSATION, login } from "./helpers";

// Projeto "celular" (Pixel 7, 412 px): o menu some e só o botão fica; as telas principais não rolam na horizontal.
test("no celular o menu fica atrás do botão e abre em gaveta", async ({ page }) => {
  await login(page, "vendedora");
  await expect(page.locator("aside").first()).toBeHidden();
  await page.getByRole("button", { name: "Abrir menu" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("link", { name: "Atendimento" })).toBeVisible();
  await drawer.getByRole("button", { name: "Fechar menu" }).click();
  await expect(drawer).toBeHidden();
});

for (const path of ["/inicio", "/atendimento", `/atendimento?c=${DEV_CONVERSATION}`, "/vender", "/clientes"]) {
  test(`sem rolagem horizontal em ${path}`, async ({ page }) => {
    await login(page, "vendedora");
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}
