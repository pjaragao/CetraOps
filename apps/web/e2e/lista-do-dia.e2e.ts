import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Cliente do seed (supabase/seed/90_dev_demo.sql), com conversa de WhatsApp aberta. */
const CLIENTE = "00000000-0000-4000-8000-000000000501";

test.describe("lista do dia e avise-me", () => {
  test("tarefa de hoje aparece na lista, abre a conversa com a mensagem pronta e é concluída", async ({ page }) => {
    await login(page, "vendedora");
    const msg = `Oi! Separei o look E2E ${Date.now() % 100000} 💛`;
    await page.goto("/clientes/tarefas");
    // o formulário de criação é o mesmo da edição (que fica dentro de cada tarefa): mira o de "Criar tarefa"
    const form = page.locator("form", { has: page.getByRole("button", { name: "Criar tarefa" }) });
    await form.locator("[name=title]").fill("Mandar o look E2E");
    await form.locator("[name=party]").fill("Cliente Teste");
    await form.locator("[name=suggested_message]").fill(msg);
    await form.getByRole("button", { name: "Criar tarefa" }).click();
    await expect(page.getByText("Tarefa criada.")).toBeVisible({ timeout: 15_000 });

    await page.goto("/inicio");
    const item = page.getByRole("listitem").filter({ hasText: msg });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.getByRole("button", { name: "Enviar pela conversa" }).click();
    await expect(page).toHaveURL(/\/atendimento\?c=/, { timeout: 15_000 });
    await expect(page.locator("textarea").filter({ hasText: msg }).or(page.locator(`textarea:text-is("${msg}")`)).first()).toBeVisible();

    await page.goto("/inicio");
    await page.getByRole("listitem").filter({ hasText: msg }).getByRole("button", { name: "Feito" }).click();
    await expect(page.getByText("Feito", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("listitem").filter({ hasText: msg })).toHaveCount(0);
  });

  test("registra e cancela um avise-me na ficha", async ({ page }) => {
    await login(page, "vendedora");
    await page.goto(`/clientes/${CLIENTE}`);
    await page.getByLabel("Produto", { exact: true }).selectOption({ label: "Legging Demo Sculpt" });
    await page.getByLabel("Tamanho", { exact: true }).fill("g");
    const note = `E2E cor preta ${Date.now() % 100000}`;
    await page.getByLabel("Observação", { exact: true }).fill(note);
    await page.getByLabel("Observação", { exact: true }).locator("xpath=ancestor::form").getByRole("button", { name: "Registrar" }).click();   // a ficha também tem o "Registrar" do NPS
    await expect(page.getByText("Avise-me registrado")).toBeVisible({ timeout: 15_000 });
    const row = page.getByRole("listitem").filter({ hasText: note });
    await expect(row).toContainText("aguardando");
    await row.getByRole("button", { name: "Cancelar" }).click();
    await expect(page.getByText("Avise-me cancelado")).toBeVisible({ timeout: 15_000 });
  });
});
