import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("escala", () => {
  test("cria um turno, lança horário livre num dia da grade e limpa tudo depois", async ({ page }) => {
    await login(page, "socio");
    const code = `Z${Date.now() % 1000}`;

    // turno novo
    await page.goto("/equipe/escalas/turnos");
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Criar turno" }) });
    await form.locator("input[name=code]").fill(code);
    await form.locator("input[name=name]").fill("Turno E2E");
    await form.locator("input[name=start_time]").fill("10:00");
    await form.locator("input[name=end_time]").fill("16:00");
    await form.locator("input[name=break_minutes]").fill("15");
    await form.getByRole("button", { name: "Criar turno" }).click();
    await expect(page.getByText("Turno criado")).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: code });
    await expect(row).toContainText("10:00–16:00");
    await expect(row).toContainText("5h45");

    // horário livre num dia (mês distante para não mexer na escala real)
    await page.goto("/equipe/escalas?mes=2030-03");
    const cell = page.getByRole("button", { name: /, dia 12$/ }).first();
    await cell.click();
    const dialog = page.getByRole("dialog", { name: "Editar dia da escala" });
    await expect(dialog.getByRole("button", { name: new RegExp(`^${code} Turno E2E`) })).toBeVisible();   // o turno novo já aparece
    await dialog.getByLabel("Início").fill("10:15");
    await dialog.getByLabel("Fim").fill("16:45");
    await dialog.getByLabel("Intervalo em minutos").fill("60");
    await dialog.getByLabel("Observação (opcional)").fill("cobre inventário");
    await dialog.getByRole("button", { name: "Usar este horário" }).click();
    const filled = page.getByRole("button", { name: /, dia 12: 10:15–16:45 \(intervalo 60 min\) · cobre inventário/ }).first();
    await expect(filled).toBeVisible();

    // limpeza: limpa o dia e exclui o turno (nunca usado na escala)
    await filled.click();
    await page.getByRole("dialog", { name: "Editar dia da escala" }).getByRole("button", { name: "Limpar" }).click();
    await expect(page.getByRole("button", { name: /, dia 12$/ }).first()).toBeVisible();
    await page.goto("/equipe/escalas/turnos");
    await page.getByRole("row").filter({ hasText: code }).getByRole("button", { name: "Excluir" }).click();
    await expect(page.getByText("Turno excluído")).toBeVisible();
  });
});
