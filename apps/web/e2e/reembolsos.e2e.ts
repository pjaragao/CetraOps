import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

async function newReimbursement(page: Page, purpose: string, opts: { reason?: string }) {
  await page.goto("/financeiro/reembolsos/novo");
  await page.getByLabel("Do que é o reembolso").fill(purpose);
  await page.getByLabel("O que foi comprado").fill("Almoço com fornecedor");
  await page.getByLabel("Valor (R$)").fill("82,50");
  await page.getByLabel("Fornecedor (onde comprou)").fill("Restaurante E2E");
  if (opts.reason) await page.getByLabel("Sem comprovante? Explique por quê").fill(opts.reason);
  await page.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(page.getByText(/Reembolso salvo/)).toBeVisible({ timeout: 20_000 });
  return page.url().split("?")[0];
}

test.describe("reembolsos", () => {
  test("vendedora pede (sem comprovante, com justificativa), envia; sócio aprova e vira conta a pagar", async ({ page }) => {
    test.setTimeout(120_000);
    const purpose = `Reembolso E2E ${Date.now() % 100000}`;
    await login(page, "vendedora");
    // a vendedora vê Financeiro só com Reembolsos
    await page.goto("/financeiro/reembolsos");
    await expect(page.getByRole("heading", { name: "Reembolsos" })).toBeVisible();
    const url = await newReimbursement(page, purpose, {});
    await page.getByRole("button", { name: "Enviar para aprovação" }).click();
    await expect(page.getByText(/sem comprovante: anexe/)).toBeVisible({ timeout: 20_000 });   // falta o comprovante
    await page.getByLabel("Sem comprovante? Explique por quê").fill("Pagamento no balcão, o restaurante não emitiu nota");
    await page.getByRole("button", { name: "Salvar rascunho" }).click();
    await expect(page.getByText(/Reembolso salvo/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Enviar para aprovação" }).click();
    await expect(page.getByText(/Enviado para aprovação/)).toBeVisible({ timeout: 20_000 });

    await page.context().clearCookies();
    await login(page, "socio");
    await page.goto(url);
    await page.getByLabel("Categoria da despesa 1").selectOption({ label: "7.2.99 · Despesas a classificar" });
    await page.getByRole("button", { name: "Classificar" }).click();
    await expect(page.getByText("Classificação salva")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Aprovar e gerar conta a pagar" }).click();
    await expect(page.getByText(/Aprovado: virou conta a pagar/)).toBeVisible({ timeout: 20_000 });
    await page.goto("/financeiro/pagar");
    await expect(page.getByText(new RegExp(`Reembolso REE-\\d{4}-\\d+ — ${purpose}`))).toBeVisible({ timeout: 20_000 });
  });

  test("comprovante: foto anexada fica no Storage e abre pelo link", async ({ page }) => {
    test.skip(!!process.env.CI, "O Storage do Supabase não sobe no CI");
    test.setTimeout(90_000);
    await login(page, "vendedora");
    await newReimbursement(page, `Comprovante E2E ${Date.now() % 100000}`, {});
    // PNG de 1x1 pixel
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    await page.getByLabel("Comprovante da despesa 1").setInputFiles({ name: "nota.png", mimeType: "image/png", buffer: png });
    await page.getByRole("button", { name: "Anexar comprovante" }).click();
    await expect(page.getByText("Comprovante anexado")).toBeVisible({ timeout: 20_000 });
    const link = page.getByRole("link", { name: /Ver comprovante \(nota\.png\)/ });
    await expect(link).toBeVisible();
    const res = await page.request.get((await link.getAttribute("href"))!);
    expect(res.status()).toBe(200);
    await page.getByRole("button", { name: "Enviar para aprovação" }).click();
    await expect(page.getByText(/Enviado para aprovação/)).toBeVisible({ timeout: 20_000 });
  });
});
