import { expect, type Page } from "@playwright/test";

/** Usuários do seed de desenvolvimento (supabase/seed/90_dev_demo.sql): sócio e vendedora. A senha é a de teste do próprio seed. */
export const USERS = { socio: "socio@centralops.test", vendedora: "vendedora@centralops.test" } as const;
const DEV_PASSWORD = "centralops-dev-2026";

export async function login(page: Page, who: keyof typeof USERS = "socio") {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(USERS[who]);
  await page.getByLabel("Senha").fill(DEV_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/inicio/);
}

/** Conversa do seed (cliente de teste, WhatsApp). */
export const DEV_CONVERSATION = "00000000-0000-4000-8000-000000000621";
