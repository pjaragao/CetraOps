import { expect, test } from "@playwright/test";
import { DEV_CONVERSATION, login } from "./helpers";

test.describe("acesso e menu", () => {
  test("quem não entrou é levado ao login e o login mostra o cockpit", async ({ page }) => {
    await page.goto("/inicio");
    await expect(page).toHaveURL(/\/login/);
    await login(page);
    await expect(page.getByRole("navigation", { name: "Menu principal" })).toBeVisible();
  });

  test("a barra lateral recolhe para só ícones, lembra a escolha e o grupo aberto recolhe de novo", async ({ page }) => {
    await login(page);
    await page.goto("/equipe");
    const nav = page.getByRole("navigation", { name: "Menu principal" });
    // grupo da área atual começa aberto e recolhe pela seta
    await expect(nav.getByRole("link", { name: "Metas & comissões" })).toBeVisible();
    await nav.getByRole("button", { name: /Recolher Equipe/ }).click();
    await expect(nav.getByRole("link", { name: "Metas & comissões" })).toBeHidden();
    await nav.getByRole("button", { name: /Expandir Equipe/ }).click();
    await expect(nav.getByRole("link", { name: "Metas & comissões" })).toBeVisible();
    // barra só com ícones
    await nav.getByRole("button", { name: "Recolher a barra lateral" }).click();
    await expect(page.locator("aside").first()).toHaveCSS("width", "64px");
    await page.reload();
    await expect(page.locator("aside").first()).toHaveCSS("width", "64px");                  // lembrado entre visitas
    await page.getByRole("navigation", { name: "Menu principal" }).getByRole("button", { name: "Expandir a barra lateral" }).click();
    await expect(page.locator("aside").first()).toHaveCSS("width", "256px");
  });
});

test.describe("atendimento", () => {
  test("pausar a IA, anotar com @menção, atribuir e devolver para a IA com instrução", async ({ page }) => {
    await login(page, "vendedora");
    await page.goto(`/atendimento?c=${DEV_CONVERSATION}`);
    const nota = `Nota E2E ${Date.now()}`;

    await page.getByRole("button", { name: "Pausar IA 2 h" }).click();
    await expect(page.getByRole("button", { name: /IA pausada até/ })).toBeVisible();
    await page.getByRole("button", { name: /IA pausada até/ }).click();
    await expect(page.getByRole("button", { name: "Pausar IA 2 h" })).toBeVisible();

    await page.getByRole("button", { name: "Nota interna" }).click();
    await page.getByRole("button", { name: /^@Sócio/ }).click();
    await page.getByLabel("Nota interna", { exact: true }).fill(`@Sócio (teste) ${nota}`);
    await page.getByRole("button", { name: "Salvar nota" }).click();
    await expect(page.getByText(nota)).toBeVisible();
    await expect(page.getByText("Nota interna (a cliente não vê)").first()).toBeVisible();

    await page.getByLabel("Responsável").selectOption({ label: "Vendedora (teste) (eu)" });
    await page.getByRole("radio", { name: "Humano" }).click();
    await page.getByRole("button", { name: "Devolver para a IA" }).click();
    await page.getByPlaceholder(/confirme o endereço/).fill("confirme o endereço e envie o link");
    await page.getByRole("button", { name: "Devolver em Copiloto" }).click();
    await expect(page.getByText("Instrução para a IA: confirme o endereço e envie o link")).toBeVisible();
    await expect(page.getByRole("radio", { name: "IA Copiloto" })).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("inteligência", () => {
  test("base de conhecimento: cria, publica e a busca acha pelo que a cliente perguntaria", async ({ page }) => {
    await login(page, "socio");
    const titulo = `Lavagem E2E ${Date.now()}`;
    await page.goto("/ia/conhecimento/novo");
    await page.locator("input[name=title]").fill(titulo);
    await page.locator("textarea[name=body]").fill("# Lavagem\n\nLave à mão com água fria e sem alvejante. Seque à sombra.");
    await page.getByRole("button", { name: "Salvar e publicar" }).click();
    await expect(page.getByText("Publicado. A IA já usa este texto")).toBeVisible();
    await page.goto("/ia/conhecimento?q=posso+lavar+sem+alvejante");
    await expect(page.getByText(`${titulo} › Lavagem`)).toBeVisible();
    // limpeza: arquivar tira da busca da IA e deixa o banco de desenvolvimento limpo para os próximos testes
    await page.getByRole("link", { name: titulo }).first().click();
    await page.getByRole("button", { name: /Arquivar/ }).click();
    await expect(page.getByText("Arquivado: a IA não usa mais")).toBeVisible();
  });

  test("avaliações: os casos de teste do seed aparecem e o modelo de atendimento mostra o portão", async ({ page }) => {
    await login(page, "socio");
    await page.goto("/ia/avaliacoes");
    await expect(page.getByRole("heading", { name: "Avaliações da IA" })).toBeVisible();
    await expect(page.getByText("Pressão por desconto: a IA não concede")).toBeVisible();
    await page.goto("/ia/modelos");
    await expect(page.getByText("Atendimento ao cliente")).toBeVisible();
  });
});

test.describe("fiscal e financeiro", () => {
  test("exportação para o contador devolve CSV do mês e recusa mês inválido", async ({ page }) => {
    await login(page, "socio");
    const ok = await page.request.get("/fiscal/exportacao/plano-de-contas?mes=2026-09");
    expect(ok.status()).toBe(200);
    expect(ok.headers()["content-type"]).toContain("text/csv");
    expect((await ok.text()).split("\r\n")[0]).toContain("Código do contador");
    expect((await page.request.get("/fiscal/exportacao/plano-de-contas?mes=2026-13")).status()).toBe(400);
  });

  test("adquirente: página carrega com o modelo de planilha para baixar", async ({ page }) => {
    await login(page, "socio");
    await page.goto("/financeiro/adquirente");
    await expect(page.getByRole("heading", { name: "Adquirente" })).toBeVisible();
    const modelo = await page.request.get("/financeiro/adquirente/modelo");
    expect(modelo.status()).toBe(200);
    expect(await modelo.text()).toContain("codigo;nsu;autorizacao");
  });
});
