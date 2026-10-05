import { describe, expect, it } from "vitest";
import { firstName, isValidParam, renderTemplate, templateExamples, templateParts, templatePlaceholders, validateTemplateDraft, type TemplateDraft } from "./index";

const ok: TemplateDraft = { name: "pedido_pronto", category: "UTILITY", body: "Oi {{1}}! Seu pedido {{2}} está pronto.", buttons: [], examples: ["Ana", "VEN-1"] };

describe("templates do WhatsApp", () => {
  it("acha as variáveis, sem repetir e em ordem", () => {
    expect(templatePlaceholders("Oi {{2}}, {{1}} e {{2}} de novo")).toEqual([1, 2]);
    expect(templatePlaceholders("sem variáveis")).toEqual([]);
  });

  it("aceita um rascunho correto", () => expect(validateTemplateDraft(ok)).toEqual([]));

  it("aponta cada problema na língua da equipe", () => {
    expect(validateTemplateDraft({ ...ok, name: "Pedido Pronto" })[0]).toMatch(/letras minúsculas/);
    expect(validateTemplateDraft({ ...ok, category: "AUTHENTICATION" })).toContain("Escolha a categoria: utilidade ou marketing.");
    expect(validateTemplateDraft({ ...ok, body: "" })[0]).toMatch(/1 a 1024/);
    expect(validateTemplateDraft({ ...ok, body: "a".repeat(1025), examples: [] })[0]).toMatch(/1 a 1024/);
    expect(validateTemplateDraft({ ...ok, buttons: ["a", "b", "c", "d"] })).toContain("Até 3 botões, de 1 a 25 caracteres cada.");
    expect(validateTemplateDraft({ ...ok, body: "Oi {{2}}, tudo bem?", examples: ["x"] })).toContain("As variáveis precisam ser {{1}}, {{2}}… em sequência.");
    expect(validateTemplateDraft({ ...ok, examples: ["Ana"] })).toContain("Informe um exemplo para cada variável (2).");
    expect(validateTemplateDraft({ ...ok, body: "{{1}}, tudo bem?", examples: ["Ana"] })).toContain("O texto não pode começar nem terminar com uma variável.");
    expect(validateTemplateDraft({ ...ok, header: "x".repeat(61) })[0]).toMatch(/60 caracteres/);
  });

  it("renderiza o texto e deixa variável sem valor visível", () => {
    expect(renderTemplate("Oi {{1}}! Pedido {{2}}.", ["Ana", "VEN-1"])).toBe("Oi Ana! Pedido VEN-1.");
    expect(renderTemplate("Oi {{1}}! Pedido {{2}}.", ["Ana"])).toBe("Oi Ana! Pedido {{2}}.");
  });

  it("valida o valor da variável como o banco", () => {
    expect(isValidParam("VEN-2026-000123")).toBe(true);
    expect(isValidParam("  ")).toBe(false);
    expect(isValidParam("linha1\nlinha2")).toBe(false);
    expect(isValidParam("x".repeat(201))).toBe(false);
  });

  it("lê as partes do template e os exemplos", () => {
    const comps = [
      { type: "HEADER", format: "TEXT", text: "Seu pedido" },
      { type: "BODY", text: "Oi {{1}}!", example: { body_text: [["Ana"]] } },
      { type: "FOOTER", text: "Loja Demo" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Retirar hoje" }] },
    ];
    expect(templateParts(comps)).toEqual({ header: "Seu pedido", body: "Oi {{1}}!", footer: "Loja Demo", buttons: ["Retirar hoje"] });
    expect(templateExamples(comps)).toEqual(["Ana"]);
    expect(templateParts(null)).toEqual({ header: null, body: "", footer: null, buttons: [] });
    expect(templateExamples(undefined)).toEqual([]);
  });

  it("primeiro nome", () => {
    expect(firstName("Ana Souza (teste)")).toBe("Ana");
    expect(firstName("  ")).toBe("");
    expect(firstName(null)).toBe("");
  });
});
