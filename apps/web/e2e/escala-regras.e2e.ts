import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("escala: regras, horas e padrão semanal", () => {
  test("regras liga/desliga, intervalo mínimo no turno e total de horas ao vivo", async ({ page }) => {
    await login(page, "socio");
    await page.goto("/equipe/escalas/turnos");
    await expect(page.getByRole("heading", { name: "Regras de conferência da escala" })).toBeVisible({ timeout: 20_000 });

    // formulário de turno: intervalo já vem no mínimo e o total aparece ao vivo
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Criar turno" }) });
    await expect(form.locator("input[name=break_minutes]")).toHaveValue("60");
    // o formulário é controlado: repete até a hidratação terminar
    await expect(async () => {
      await form.locator("input[name=start_time]").fill("09:00");
      await form.locator("input[name=end_time]").fill("17:00");
      await expect(form.getByText(/Total trabalhado: 7h/)).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await form.locator("input[name=break_minutes]").fill("30");
    await expect(form.getByText(/Abaixo do intervalo mínimo/)).toBeVisible();

    // liga e desliga uma regra
    const rules = page.locator("form").filter({ has: page.getByRole("button", { name: "Salvar regras" }) });
    await rules.getByLabel("Conferir a cobertura dos picos").uncheck();
    await rules.getByRole("button", { name: "Salvar regras" }).click();
    await expect(page.getByText("Regras da escala salvas")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("conferência de cobertura desligada")).toBeVisible();
    await page.locator("form").filter({ has: page.getByRole("button", { name: "Salvar regras" }) }).getByLabel("Conferir a cobertura dos picos").check();
    await page.getByRole("button", { name: "Salvar regras" }).click();
    await expect(page.getByText("Regras da escala salvas")).toBeVisible({ timeout: 15_000 });
  });

  test("escala semanal padrão mostra o total semanal e aplica nos meses", async ({ page }) => {
    await login(page, "socio");
    await page.goto("/equipe/escalas/padrao");
    await expect(page.getByRole("heading", { name: "Escala semanal padrão" })).toBeVisible({ timeout: 20_000 });
    const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Salvar" }) }).first();
    const mon = row.getByRole("combobox").first();
    await mon.selectOption({ index: 2 });                                   // primeiro turno
    await expect(row.getByText(/dia\(s\) de trabalho/)).toContainText("1 dia");
    await row.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Padrão salvo e aplicado")).toBeVisible({ timeout: 20_000 });
  });
});
