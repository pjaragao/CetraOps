import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const CLIENTE_NOME = "Cliente Teste";

test.describe("indicação, check-in e relatórios", () => {
  test("liga as regras de indicação e gera o link pessoal de uma cliente", async ({ page }) => {
    test.setTimeout(90_000);
    await login(page, "socio");
    await page.goto("/clientes/indicacoes");
    await page.locator("input[name=reward_amount]").fill("40");
    await page.getByRole("button", { name: "Salvar regras" }).click();
    await expect(page.getByText("Regras de indicação salvas")).toBeVisible({ timeout: 20_000 });
    await page.locator("input[name=party]").fill(CLIENTE_NOME);
    await page.getByRole("button", { name: "Gerar / mostrar link" }).click();
    await expect(page.getByText("Link pessoal pronto")).toBeVisible({ timeout: 20_000 });
  });

  test("check-in: cadastra quem chegou sem convite", async ({ page }) => {
    test.setTimeout(90_000);
    await login(page, "socio");
    await page.goto("/marketing/eventos");
    const evento = page.getByRole("link").filter({ hasText: /./ }).first();
    await expect(evento).toBeVisible();
    await page.goto("/marketing/eventos/checkin");
    if (await page.locator("select[name=event_id]").count()) {
      const nome = `Convidada E2E ${Date.now() % 100000}`;
      await page.locator("input[name=name]").fill(nome);
      await page.locator("input[name=phone]").fill("(48) 98888-7777");
      await page.getByRole("button", { name: "Cadastrar e confirmar presença" }).click();
      await expect(page.getByText("Cadastrada e presença confirmada.")).toBeVisible({ timeout: 20_000 });
    } else {
      await expect(page.getByText("Nenhum evento em andamento ou próximo.")).toBeVisible();
    }
  });

  test("os relatórios novos abrem sem erro", async ({ page }) => {
    await login(page, "socio");
    for (const key of ["aquisicao", "coortes", "reguas", "satisfacao", "perdas"]) {
      await page.goto(`/relatorios/${key}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText(/Application error|permission denied|does not exist/i)).toHaveCount(0);
    }
  });
});
