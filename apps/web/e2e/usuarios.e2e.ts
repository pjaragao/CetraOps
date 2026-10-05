import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("usuários e permissões", () => {
  test("sócio cria perfil e usuário; a pessoa troca a senha provisória e só vê o que o perfil permite", async ({ page }) => {
    test.setTimeout(150_000);
    const n = Date.now() % 100000;
    const email = `e2e-${n}@sie.test`;
    const perfil = `Atendimento E2E ${n}`;
    await login(page, "socio");

    // perfil só com atendimento e clientes
    await page.goto("/configuracoes/perfis");
    const novo = page.locator("form").filter({ has: page.getByRole("button", { name: "Criar perfil" }) });
    await novo.locator("input[name=name]").fill(perfil);
    await novo.locator("input[value='omni.read']").check();
    await novo.locator("input[value='crm.read']").check();
    await novo.getByRole("button", { name: "Criar perfil" }).click();
    await expect(page.getByText("Perfil criado.")).toBeVisible({ timeout: 20_000 });

    // usuário com esse perfil
    await page.goto("/configuracoes/usuarios");
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Criar usuário" }) });
    await form.locator("input[name=display_name]").fill(`Pessoa E2E ${n}`);
    await form.locator("input[name=email]").fill(email);
    await form.locator("input[name=password]").fill("provisoria123");
    await form.getByText(perfil, { exact: true }).click();
    await form.getByRole("button", { name: "Criar usuário" }).click();
    await expect(page.getByText(/Usuário criado/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("ainda com a senha provisória")).toBeVisible();

    // primeiro acesso
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha").fill("provisoria123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page).toHaveURL(/\/conta/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Crie sua senha" })).toBeVisible();
    await page.getByLabel("Senha provisória").fill("provisoria123");
    await page.getByLabel("Nova senha", { exact: true }).fill("minhaSenha2026");
    await page.getByLabel("Repita a nova senha").fill("minhaSenha2026");
    await page.getByRole("button", { name: "Salvar senha" }).click();
    await expect(page).toHaveURL(/\/inicio/, { timeout: 20_000 });

    // sem administração: configurações bloqueadas
    await page.goto("/configuracoes/usuarios");
    await expect(page).toHaveURL(/\/inicio\?erro=sem-permissao/);
  });
});
