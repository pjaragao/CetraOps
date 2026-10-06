import http from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * A Central de ponta a ponta com um MODELO FALSO (servidor compatível com o OpenRouter em 127.0.0.1:4010): ele devolve chamadas de
 * ferramenta roteirizadas, então o teste exercita o laço de verdade (ferramentas, banco, cartões, confirmação e permissões) sem custo
 * e sem depender de uma IA externa. O app precisa subir com CENTRALOPS_OPENROUTER_BASE=http://127.0.0.1:4010 e uma chave qualquer.
 */

type Msg = { role: string; content?: unknown; tool_calls?: { function: { name: string; arguments: string } }[] };

function textOf(m: Msg | undefined): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return ((m.content as { type: string; text?: string }[]) ?? []).map((p) => p.text ?? "").join(" ");
}

function call(name: string, args: unknown, n = 0) {
  return { id: `call_${name}_${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** O roteiro: olha a última mensagem da pessoa e o que já foi chamado depois dela. */
function script(messages: Msg[]): { content?: string; tool_calls?: ReturnType<typeof call>[] } {
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const user = textOf(messages[lastUser]);
  const after = messages.slice(lastUser + 1);
  const called = after.flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name);
  const results = after.filter((m) => m.role === "tool").map((m) => JSON.parse(String(m.content)));
  const lastSystem = messages[messages.length - 1];
  if (lastSystem?.role === "system" && textOf(lastSystem).includes("não vieram das ferramentas")) return { content: "Não tenho esse valor no sistema." };

  if (/^cadastrar/i.test(user)) {
    if (!called.length) {
      const nome = user.match(/cadastrar a (.+?),/i)?.[1] ?? "Sem Nome";
      const cpf = user.match(/cpf ([\d.-]+)/i)?.[1];
      const tel = user.match(/whatsapp ([\d ()-]+)/i)?.[1]?.trim();
      return { tool_calls: [call("propor_cadastro", { nome, cpf, telefone: tel, aceita_marketing: true })] };
    }
    return { content: "O cadastro está pronto: confira e confirme no cartão." };
  }
  if (/legging/i.test(user)) {
    const nome = user.match(/para a (.+?) no pix/i)?.[1] ?? "";
    if (!called.length) return { tool_calls: [call("buscar_cliente", { consulta: nome }), call("buscar_produto", { consulta: "legging", cor: "preta", tamanho: "G" }, 1)] };
    if (!called.includes("propor_venda")) {
      const party = results.find((r) => r.pessoas)?.pessoas?.[0]?.party_id;
      const variant = results.find((r) => r.produtos)?.produtos?.[0]?.variantes?.[0]?.variant_id;
      return { tool_calls: [call("propor_venda", { party_id: party, itens: [{ variant_id: variant, qtd: 1 }], pagamento: { forma: "pix" }, cpf_na_nota: true })] };
    }
    const total = results.find((r) => r.total !== undefined)?.total;
    return { content: `A venda de R$ ${String(total).replace(".", ",")} no Pix está pronta: confira e confirme.` };
  }
  if (/contas a pagar/i.test(user)) {
    if (!called.length) return { tool_calls: [call("contas", { tipo: "pagar", periodo: "hoje" })] };
    return { content: results[0]?.erro ? "Seu perfil não tem acesso ao financeiro." : "Essas são as contas de hoje." };
  }
  if (/inventa/i.test(user)) return { content: "Você vai economizar R$ 77,77 com isso." };
  return { content: "Não entendi." };
}

let server: http.Server;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { messages } = JSON.parse(body) as { messages: Msg[] };
      const out = script(messages);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ model: "falso/roteiro", usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
                               choices: [{ message: { role: "assistant", content: out.content ?? null, tool_calls: out.tool_calls } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(4010, "127.0.0.1", r));
});
test.afterAll(async () => { await new Promise((r) => server.close(r)); });

/** CPF válido aleatório (dígitos verificadores calculados), para o teste poder rodar várias vezes. */
function randomCpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  for (const len of [9, 10]) {
    const s = d.slice(0, len).reduce((a, x, i) => a + x * (len + 1 - i), 0);
    d.push((s * 10) % 11 % 10);
  }
  return d.join("");
}

async function ask(page: Page, text: string) {
  const box = page.getByLabel("Mensagem para a Central");
  await box.fill(text);
  await box.press("Enter");
}

test("a vendedora cadastra uma cliente nova com CPF e vende falando, confirmando nos cartões", async ({ page }) => {
  const nome = `Cliente Central ${Date.now().toString().slice(-6)}`;
  const cpf = randomCpf();
  await login(page, "vendedora");
  await page.getByRole("button", { name: /Abrir a Central/ }).first().click();

  await ask(page, `cadastrar a ${nome}, cpf ${cpf}, whatsapp 48 9${cpf.slice(0, 8)}`);
  await expect(page.getByText(`Cadastrar ${nome}`)).toBeVisible();
  await expect(page.getByText(`***.***.*${cpf.slice(7, 9)}-${cpf.slice(9)}`)).toBeVisible();     // o CPF aparece mascarado
  await expect(page.getByText("O cadastro está pronto")).toBeVisible();
  await page.getByRole("button", { name: `Confirmar: Cadastrar ${nome}` }).click();
  await expect(page.getByText("Feito.").first()).toBeVisible();

  await ask(page, `uma legging preta G para a ${nome} no pix com cpf na nota`);
  await expect(page.getByText("Venda — R$ 429,00")).toBeVisible();
  // o roteiro escolhe a primeira pessoa da busca sem perguntar: se houver homônimas, o cartão avisa
  if (await page.getByText(/pessoas encontradas/).count()) await expect(page.getByText("Confira a cliente").last()).toBeVisible();
  await expect(page.getByText("A venda de R$ 429 no Pix está pronta")).toBeVisible();
  await page.getByRole("button", { name: "Confirmar: Venda — R$ 429,00" }).click();
  await expect(page.getByText(/Feito: VEN-/)).toBeVisible();

  // A vendedora não tem o financeiro: a ferramenta nem chega a rodar, e nenhum cartão de contas aparece
  await ask(page, "quais as contas a pagar hoje?");
  await expect(page.getByText("Seu perfil não tem acesso ao financeiro.")).toBeVisible();
  await expect(page.getByText(/Contas a pagar hoje/)).toHaveCount(0);
});

test("o sócio vê as contas do dia, e um valor inventado pela IA não chega à tela", async ({ page }) => {
  await login(page, "socio");
  await page.getByRole("button", { name: /Abrir a Central/ }).first().click();
  await ask(page, "quais as contas a pagar hoje?");
  await expect(page.getByText(/Contas a pagar hoje/)).toBeVisible();
  await expect(page.getByText("Essas são as contas de hoje.")).toBeVisible();

  await ask(page, "inventa um número");
  await expect(page.getByText("Não tenho esse valor no sistema.")).toBeVisible();
  await expect(page.getByText("R$ 77,77")).toHaveCount(0);
});
