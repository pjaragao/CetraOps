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
  if (/whatsapp dela/i.test(user)) {
    if (!called.length) {
      const history = messages.map((m) => textOf(m)).join("\n");
      const acao = [...history.matchAll(/Cadastrar [^[]*\[acao_id=([0-9a-f-]{36})\]/g)].pop()?.[1];
      const tel = user.match(/whatsapp dela é ([\d ()-]+)/i)?.[1]?.trim();
      return { tool_calls: [call("propor_cadastro", { complementar_acao_id: acao, telefone: tel, aceita_marketing: true })] };
    }
    return { content: "Completei o cartão: confira e confirme." };
  }
  if (/^ferramenta /.test(user)) {
    const [, name, args] = user.match(/^ferramenta (\w+)\s*(.*)$/) ?? [];
    if (!called.length) return { tool_calls: [call(name, args ? JSON.parse(args) : {})] };
    return { content: results[0]?.erro ? `ERRO: ${results[0].erro}` : `ok ${name}` };
  }
  if (/inventa/i.test(user)) return { content: "Você vai economizar R$ 77,77 com isso." };
  return { content: "Não entendi." };
}

let server: http.Server;
/** Próxima "leitura" de documento que o modelo falso devolve, e tudo o que a conversa (sem ser leitura) mandou ao modelo. */
let nextDocument: unknown = null;
const chatRequests: string[] = [];
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Msg[]; response_format?: { json_schema?: { name?: string } } };
      if (parsed.response_format?.json_schema?.name === "documento") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ model: "falso/visao", usage: {}, choices: [{ message: { role: "assistant", content: JSON.stringify(nextDocument) } }] }));
        return;
      }
      chatRequests.push(body);
      const { messages } = parsed;
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

/** Boleto bancário válido (dígitos verificadores calculados), em linha digitável. */
function boletoLine(cents: number, dueIso: string): string {
  const days = Math.round((Date.parse(`${dueIso}T00:00:00Z`) - Date.UTC(2025, 1, 22)) / 86_400_000);
  const factor = String(1000 + days).padStart(4, "0");
  const free = "1790010104351004791020150";
  const mod10 = (n: string) => { let t = 0; n.split("").reverse().forEach((c, i) => { let x = Number(c) * (i % 2 === 0 ? 2 : 1); if (x > 9) x = Math.floor(x / 10) + (x % 10); t += x; }); return (10 - (t % 10)) % 10; };
  const mod11 = (n: string) => { let t = 0; n.split("").reverse().forEach((c, i) => { t += Number(c) * (2 + (i % 8)); }); const r = 11 - (t % 11); return r === 0 || r === 10 || r === 11 ? 1 : r; };
  const head = `3419`;
  const tail = `${factor}${String(cents).padStart(10, "0")}${free}`;
  const bar = `${head}${mod11(head + tail)}${tail}`;
  const f1 = bar.slice(0, 4) + bar.slice(19, 24), f2 = bar.slice(24, 34), f3 = bar.slice(34, 44);
  return `${f1}${mod10(f1)}${f2}${mod10(f2)}${f3}${mod10(f3)}${bar[4]}${bar.slice(5, 19)}`;
}

const empty = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, null]));
const blank = {
  identidade: empty(["nome", "cpf", "data_nascimento", "documento_tipo", "documento_numero", "orgao_uf"]),
  boleto: empty(["linha_digitavel", "beneficiario", "beneficiario_cnpj", "valor", "vencimento", "descricao"]),
  pix_copia_e_cola: null,
  comprovante: empty(["emitente", "emitente_cnpj", "valor_total", "data", "chave_acesso", "descricao"]),
  endereco: empty(["cep", "logradouro", "numero", "complemento", "bairro", "cidade", "uf"]),
  etiqueta: empty(["referencia", "nome", "cor", "tamanho", "codigo_barras"]),
  observacoes: null,
};
const png = { name: "foto.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex") };

test("foto da CNH vira cadastro (o CPF não passa pelo modelo da conversa) e foto de boleto vira conta a pagar", async ({ page }) => {
  const nome = `Maria Documento ${Date.now().toString().slice(-6)}`;
  const cpf = randomCpf();
  await login(page, "socio");
  await page.getByRole("button", { name: /Abrir a Central/ }).first().click();
  const file = page.getByLabel("Arquivo para a Central");

  nextDocument = { ...blank, tipo: "identidade", confianca: 0.95, identidade: { nome, cpf, data_nascimento: "1990-05-10", documento_tipo: "CNH", documento_numero: "01234567890", orgao_uf: "DETRAN/SC" } };
  const before = chatRequests.length;
  await file.setInputFiles(png);
  await expect(page.getByText(`Cadastrar ${nome}`)).toBeVisible();
  await expect(page.getByText(`***.***.*${cpf.slice(7, 9)}-${cpf.slice(9)}`)).toBeVisible();
  await expect(page.getByText(/Li o CNH: confira o cadastro/)).toBeVisible();

  const tel = `48 9${cpf.slice(0, 4)}-${cpf.slice(4, 8)}`;
  await ask(page, `o whatsapp dela é ${tel} e ela aceita novidades`);
  await expect(page.getByText("Completei o cartão")).toBeVisible();
  await expect(page.getByText(tel, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Confirmar: Cadastrar ${nome}` }).last().click();
  await expect(page.getByText("Feito.").last()).toBeVisible();
  expect(chatRequests.slice(before).some((b) => b.includes(cpf))).toBe(false);          // o CPF lido nunca foi para a IA da conversa

  // valor impresso errado (999,00): vale o do código de barras (320,50), com aviso
  nextDocument = { ...blank, tipo: "boleto", confianca: 0.9, boleto: { linha_digitavel: boletoLine(32050, "2026-12-10"), beneficiario: "Energia Teste SA", beneficiario_cnpj: null, valor: 999, vencimento: "2026-12-10", descricao: "Conta de luz" } };
  await file.setInputFiles({ ...png, name: "boleto.png" });
  await expect(page.getByText("Conta a pagar — R$ 320,50")).toBeVisible();
  await expect(page.getByText(/vale o do código/)).toBeVisible();
  await page.getByRole("button", { name: "Confirmar: Conta a pagar — R$ 320,50" }).click();
  await expect(page.getByText(/Feito: PAG-/)).toBeVisible();
});

test("Nova pessoa: a foto da CNH preenche nome, CPF e nascimento; o mesmo CPF não entra duas vezes", async ({ page }) => {
  const nome = `Joana Foto ${Date.now().toString().slice(-6)}`;
  const cpf = randomCpf();
  nextDocument = { ...blank, tipo: "identidade", confianca: 0.93, identidade: { nome, cpf, data_nascimento: "1988-03-21", documento_tipo: "CIN", documento_numero: cpf, orgao_uf: "SSP/SC" } };
  await login(page, "socio");
  for (const attempt of [1, 2]) {
    await page.goto("/cadastros/novo");
    await page.getByLabel("Foto do documento").setInputFiles(png);
    await expect(page.getByText(/Preenchido pela leitura do CIN/)).toBeVisible();
    await expect(page.getByLabel("Nome completo")).toHaveValue(nome);
    await expect(page.getByLabel("CPF")).toHaveValue(`${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`);
    await expect(page.getByLabel("Nascimento")).toHaveValue("1988-03-21");
    await page.getByRole("button", { name: "Cadastrar pessoa" }).click();
    if (attempt === 1) await expect(page.getByText("Cadastro criado")).toBeVisible({ timeout: 15_000 });
    else await expect(page.getByText(`Este CPF já está no cadastro de ${nome}`)).toBeVisible({ timeout: 15_000 });
  }
});

test("perguntas de gestão: cada ferramenta consulta o banco e mostra o cartão", async ({ page }) => {
  await login(page, "socio");
  await expect(page.getByText("Resumo do dia")).toBeVisible();                 // o resumo do dia no Início, sem IA
  await expect(page.getByText(/^Ontem: \d+ venda/)).toBeVisible();
  await page.getByRole("button", { name: /Abrir a Central/ }).first().click();
  const casos: [string, string, RegExp][] = [
    ["resumo_do_dia", "{}", /^Resumo do dia$/],
    ["dre", '{"periodo":"mes"}', /DRE — mês atual/],
    ["fluxo_caixa", '{"dias":30}', /Fluxo de caixa — próximos 30 dias/],
    ["fechamento_mes", "{}", /Fechamento de/],
    ["simples_das", "{}", /Simples Nacional —/],
    ["obrigacoes_fiscais", '{"dias":30}', /Obrigações até/],
    ["reposicao", "{}", /Repor em/],
    ["curva_abc", '{"periodo":"ano","por":"tamanho"}', /Curva ABC por tamanho/],
    ["escala", '{"dia":"hoje"}', /Escala de/],
    ["ferias", "{}", /^Férias$/],
    ["conversas_aguardando", "{}", /conversa\(s\) esperando a equipe/],
    ["sugestoes_abertas", "{}", /alerta\(s\) aberto\(s\)/],
  ];
  for (const [name, args, title] of casos) {
    await ask(page, `ferramenta ${name} ${args}`);
    await expect(page.getByText(`ok ${name}`)).toBeVisible();
    await expect(page.getByText(title).last()).toBeVisible();
  }
});
