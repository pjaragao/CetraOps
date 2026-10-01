import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("avisos automáticos", () => {
  test("liga e desliga o aviso de pronto para retirar; relatório de vendas recuperadas abre", async ({ page }) => {
    await login(page, "socio");
    await page.goto("/atendimento/avisos?editar=READY_FOR_PICKUP");
    await expect(page.getByText("Configurar: Pronto para retirar")).toBeVisible();
    await page.getByLabel("Ligado").check();
    await page.getByRole("button", { name: "Salvar aviso" }).click();
    await expect(page.getByText("Aviso salvo")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("row").filter({ hasText: "Pronto para retirar" })).toContainText("ligado");
    // limpeza
    await page.goto("/atendimento/avisos?editar=READY_FOR_PICKUP");
    await page.getByLabel("Ligado").uncheck();
    await page.getByRole("button", { name: "Salvar aviso" }).click();
    await expect(page.getByRole("row").filter({ hasText: "Pronto para retirar" })).toContainText("desligado", { timeout: 15_000 });

    await page.goto("/relatorios/vendas-recuperadas");
    await expect(page.getByRole("heading", { name: "Vendas recuperadas" })).toBeVisible();
    const csv = await page.request.get("/relatorios/vendas-recuperadas/csv?de=2026-01-01&ate=2026-12-31");
    expect(csv.status()).toBe(200);
    expect((await csv.text()).replace(/^﻿/, "").split("\r\n")[0]).toBe("Tipo;Tentativas;Recuperadas;Receita");
  });
});
