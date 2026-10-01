import { expect, test } from "@playwright/test";
import { DEV_CONVERSATION, login } from "./helpers";

/** Canal de WhatsApp do seed (supabase/seed/90_dev_demo.sql). */
const CANAL = "00000000-0000-4000-8000-000000000601";

test.describe("horário e desfecho", () => {
  test("define o horário de atendimento do canal e volta para sempre aberto", async ({ page }) => {
    await login(page, "socio");
    await page.goto(`/configuracoes/integracoes/horario/${CANAL}`);
    await page.getByLabel("Segunda: abre").fill("09:00");
    await page.getByLabel("Segunda: fecha", { exact: true }).fill("18:00");
    await page.getByLabel("Responde sozinha o que é só informação").check();
    await page.getByRole("button", { name: "Salvar horário" }).click();
    await expect(page.getByText("Horário salvo")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("Segunda: abre")).toHaveValue("09:00");
    // faixa invertida é recusada
    await page.getByLabel("Terça: abre").fill("18:00");
    await page.getByLabel("Terça: fecha", { exact: true }).fill("09:00");
    await page.getByRole("button", { name: "Salvar horário" }).click();
    await expect(page.getByText(/Horário inválido/)).toBeVisible({ timeout: 15_000 });
    // limpeza: sem dias = sempre aberto (o resto dos testes depende disso)
    await page.goto(`/configuracoes/integracoes/horario/${CANAL}`);
    await page.getByLabel("Segunda: abre").fill("");
    await page.getByLabel("Segunda: fecha", { exact: true }).fill("");
    await page.getByLabel("Só prepara rascunho").check();
    await page.getByRole("button", { name: "Salvar horário" }).click();
    await expect(page.getByText("Horário salvo")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: /Dias e faixas \(hoje: sempre aberto\)/ })).toBeVisible();
  });

  test("a conversa mostra o encerramento com desfecho sugerido", async ({ page }) => {
    await login(page, "vendedora");
    await page.goto(`/atendimento?c=${DEV_CONVERSATION}`);
    await page.getByRole("button", { name: "Encerrar" }).click();
    await expect(page.getByLabel("Desfecho", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Desfecho", { exact: true }).locator("option", { hasText: "(sugerido)" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Encerrar conversa" })).toBeVisible();
  });
});
