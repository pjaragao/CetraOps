import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("distribuição e satisfação", () => {
  test("liga a distribuição e a pesquisa, confere no desempenho e desliga", async ({ page }) => {
    await login(page, "socio");
    await page.goto("/atendimento/regras");
    const routing = page.locator("form").filter({ has: page.getByRole("button", { name: "Salvar distribuição" }) });
    await routing.getByLabel("Ligada").check();
    await routing.getByLabel("Máximo de conversas abertas por pessoa").fill("12");
    await routing.getByRole("button", { name: "Salvar distribuição" }).click();
    await expect(page.getByText("Distribuição salva")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("Máximo de conversas abertas por pessoa")).toHaveValue("12");

    const csat = page.locator("form").filter({ has: page.getByRole("button", { name: "Salvar pesquisa" }) });
    await csat.getByLabel("Ligada").check();
    await csat.getByRole("button", { name: "Salvar pesquisa" }).click();
    await expect(page.getByText("Pesquisa salva")).toBeVisible({ timeout: 15_000 });

    await page.goto("/atendimento/desempenho?periodo=ano");
    await expect(page.getByText("Satisfação (nota de 1 a 5)").or(page.getByText("Sem conversas neste período"))).toBeVisible();

    // limpeza: tudo desligado como no seed
    await page.goto("/atendimento/regras");
    await page.locator("form").filter({ has: page.getByRole("button", { name: "Salvar distribuição" }) }).getByLabel("Ligada").uncheck();
    await page.getByRole("button", { name: "Salvar distribuição" }).click();
    await expect(page.getByText("Distribuição salva")).toBeVisible({ timeout: 15_000 });
    await page.locator("form").filter({ has: page.getByRole("button", { name: "Salvar pesquisa" }) }).getByLabel("Ligada").uncheck();
    await page.getByRole("button", { name: "Salvar pesquisa" }).click();
    await expect(page.getByText("Pesquisa salva")).toBeVisible({ timeout: 15_000 });
  });
});
