import http from "node:http";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Relatórios: lista, construtor (à mão e com IA), relatório salvo, CSV, edição, exclusão e permissões.
 * A IA é um MODELO FALSO compatível com o OpenRouter em 127.0.0.1:4010 (o app sobe com CENTRALOPS_OPENROUTER_BASE apontando para ele):
 * ele devolve o roteiro do relatório e guarda o pedido recebido, para conferir que só o catálogo permitido vai para a IA.
 */

let server: http.Server;
const prompts: string[] = [];

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      const system = String(parsed.messages?.[0]?.content ?? "");
      const user = String(parsed.messages?.[1]?.content ?? "");
      prompts.push(`${system}\n---\n${user}`);
      const adjust = user.includes("Relatório atual");
      const draft = {
        title: "Receita por canal", description: "Quanto cada canal vendeu.", explanation: adjust ? "Separei também por mês." : "Usei os pedidos pagos, agrupados por canal.",
        dataset: "pedidos", dimensions: adjust ? ["canal", "mes"] : ["canal"], measures: ["receita", "pedidos", "lucro_inventado"],
        filters: [], sort_field: "receita", sort_dir: "desc", limit: 100, use_period: true, period_from: null, period_to: null,
      };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ model: "falso/relatorio", usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0 }, choices: [{ message: { role: "assistant", content: JSON.stringify(draft) } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(4010, "127.0.0.1", r));
});
test.afterAll(async () => { await new Promise((r) => server.close(r)); });

test("Relatórios abre direto na lista, sem o subitem repetido", async ({ page }) => {
  await login(page, "socio");
  const menu = page.getByRole("navigation", { name: "Menu principal" });
  await menu.getByRole("link", { name: "Relatórios", exact: true }).click();
  await expect(page).toHaveURL(/\/relatorios$/);
  await expect(menu.getByRole("link", { name: "Todos os relatórios" })).toHaveCount(0);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Vendas", exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: /Curva ABC/ })).toBeVisible();
  await page.getByLabel("Buscar relatório").fill("coorte");
  await expect(main.getByRole("link", { name: /Recompra por coorte/ })).toBeVisible();
  await expect(main.getByRole("link", { name: /Curva ABC/ })).toHaveCount(0);
});

test("o sócio monta um relatório com a IA, ajusta, salva, baixa o CSV, edita e exclui", async ({ page }) => {
  const nome = `Receita por canal ${Date.now().toString().slice(-6)}`;
  await login(page, "socio");
  await page.goto("/relatorios");
  await page.getByRole("link", { name: "Novo relatório" }).click();
  await expect(page).toHaveURL(/\/relatorios\/novo$/);

  await page.getByLabel("Pedido para a IA").fill("receita por canal");
  await page.getByRole("button", { name: "Montar com IA" }).click();
  await expect(page.getByText("Usei os pedidos pagos, agrupados por canal.")).toBeVisible();
  await expect(page.getByText(/lucro_inventado/)).toBeVisible();                       // o campo inventado sai e a tela explica
  await expect(page.getByRole("button", { name: /Canal/, pressed: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /Receita/ })).toBeVisible();     // prévia rodou no banco
  expect(prompts.at(-1)).toContain("## pedidos");
  expect(prompts.at(-1)).not.toMatch(/sum\(|from sales/i);                          // a IA não vê SQL

  await page.getByLabel("Pedido para a IA").fill("separe por mês");
  await page.getByRole("button", { name: "Ajustar com IA" }).click();
  await expect(page.getByText("Separei também por mês.")).toBeVisible();
  expect(prompts.at(-1)).toContain("Relatório atual");
  await expect(page.getByRole("columnheader", { name: /Mês/ })).toBeVisible();

  await page.getByLabel("Nome do relatório").fill(nome);
  await page.getByRole("button", { name: "Salvar relatório" }).click();
  await expect(page).toHaveURL(/\/relatorios\/[0-9a-f-]{36}\?ok=/);
  await expect(page.getByRole("heading", { name: nome })).toBeVisible();
  await expect(page.getByText("Pedido feito à IA")).toBeVisible();

  const csv = await page.request.get(`${page.url().split("?")[0]}/csv?de=2026-01-01&ate=2026-12-31`);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain("Canal;Mês;Receita;Pedidos");

  await page.getByRole("link", { name: "Editar" }).click();
  await page.getByRole("button", { name: /Mês/, pressed: true }).click();             // tira o mês à mão
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByText("Relatório atualizado.")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /Mês/ })).toHaveCount(0);

  await page.goto("/relatorios");
  await expect(page.getByRole("link", { name: new RegExp(nome) })).toContainText("Da equipe");
  await page.getByRole("link", { name: new RegExp(nome) }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Excluir relatório" }).click();
  await expect(page.getByText("Relatório excluído.")).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(nome) })).toHaveCount(0);
});

test("montagem à mão com filtro e a vendedora não vê o financeiro nem edita o relatório dos outros", async ({ page, browser }) => {
  const nome = `Peças por categoria ${Date.now().toString().slice(-6)}`;
  await login(page, "socio");
  await page.goto("/relatorios/novo");
  await page.getByLabel("Fonte de dados").selectOption({ label: "Itens vendidos" });
  await page.getByRole("button", { name: "Categoria", exact: true }).click();
  await page.getByRole("button", { name: "Quantidade vendida" }).click();
  await page.getByRole("button", { name: "Adicionar filtro" }).click();
  await page.getByLabel("Campo do filtro").selectOption({ label: "Quantidade vendida" });
  await page.getByLabel("Condição").selectOption({ label: "maior ou igual a" });
  await page.getByLabel("Valor do filtro").fill("1");
  await expect(page.getByRole("columnheader", { name: /Categoria/ })).toBeVisible();
  await page.getByLabel("Nome do relatório").fill(nome);
  await page.getByRole("button", { name: "Salvar relatório" }).click();
  await expect(page.getByRole("heading", { name: nome })).toBeVisible();
  const url = page.url().split("?")[0];

  const ctx = await browser.newContext();
  const seller = await ctx.newPage();
  await login(seller, "vendedora");
  await seller.goto(url);
  await expect(seller.getByRole("heading", { name: nome })).toBeVisible();
  await expect(seller.getByRole("link", { name: "Editar" })).toHaveCount(0);
  await seller.goto("/relatorios/novo");
  await expect(seller.getByLabel("Fonte de dados").locator("option", { hasText: "Contas a pagar e a receber" })).toHaveCount(0);
  await ctx.close();

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Excluir relatório" }).click();
  await expect(page.getByText("Relatório excluído.")).toBeVisible();
});
