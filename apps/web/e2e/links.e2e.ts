import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("links rastreados", () => {
  test("cria um link com QR, copia o endereço e pausa depois", async ({ page }) => {
    await login(page, "socio");
    await page.goto("/marketing/links");
    // o canal do seed precisa do número público para montar o link
    const address = page.getByPlaceholder("55 48 99999-0000");
    if (await address.isVisible()) {
      await address.fill("55 48 99999-0000");
      await page.getByRole("button", { name: "Salvar" }).first().click();
      await expect(page.getByText("Endereço do canal salvo")).toBeVisible();
    }
    const code = `e2e-${Date.now() % 100000}`;
    await page.locator("input[name=name]").fill("QR E2E");
    await page.locator("input[name=code]").fill(code);
    await page.locator("input[name=prefill_text]").fill("Oi! Vim pelo QR de teste.");
    await page.getByRole("button", { name: "Criar link" }).click();
    await expect(page.getByText("Link criado")).toBeVisible({ timeout: 20_000 });
    const row = page.getByRole("row").filter({ hasText: code });
    await expect(row.getByRole("button", { name: "Copiar link" })).toBeVisible();

    const href = await row.getByRole("link", { name: "QR (PNG)" }).getAttribute("href");
    const qr = await page.request.get(href!);
    expect(qr.status()).toBe(200);
    expect(qr.headers()["content-type"]).toBe("image/png");
    const svg = await page.request.get(`${href}?formato=svg`);
    expect(svg.status()).toBe(200);
    expect(svg.headers()["content-type"]).toBe("image/svg+xml");

    await row.getByRole("button", { name: "Pausar" }).click();
    await expect(page.getByRole("row").filter({ hasText: code })).toContainText("pausado");
  });
});
