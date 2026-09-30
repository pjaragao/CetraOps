/**
 * Templates do WhatsApp (mensagens aprovadas pela Meta). As regras abaixo espelham as do banco (omni.save_template / omni.send_template):
 * a tela avisa na hora; o banco é quem decide.
 */
export interface TemplateComponent {
  type: string;
  text?: string;
  format?: string;
  buttons?: { type: string; text: string }[];
  example?: { body_text?: string[][] };
}

export interface TemplateParts {
  header: string | null;
  body: string;
  footer: string | null;
  buttons: string[];
}

export interface TemplateDraft {
  name: string;
  category: string;
  body: string;
  header?: string;
  footer?: string;
  buttons: string[];
  examples: string[];
}

/** {{1}}, {{2}}… usados no texto (únicos, em ordem). */
export function templatePlaceholders(text: string): number[] {
  return [...new Set([...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

/** Erros de preenchimento, em português, na mesma ordem de importância das regras do banco. Lista vazia = pode salvar. */
export function validateTemplateDraft(d: TemplateDraft): string[] {
  const errors: string[] = [];
  const body = d.body.trim();
  if (!/^[a-z][a-z0-9_]{0,99}$/.test(d.name.trim())) errors.push("O nome usa só letras minúsculas, números e _ (ex.: pedido_pronto).");
  if (!["MARKETING", "UTILITY"].includes(d.category)) errors.push("Escolha a categoria: utilidade ou marketing.");
  if (body.length < 1 || body.length > 1024) errors.push("O texto precisa ter de 1 a 1024 caracteres.");
  if ((d.header?.trim().length ?? 0) > 60 || (d.footer?.trim().length ?? 0) > 60) errors.push("Cabeçalho e rodapé têm no máximo 60 caracteres.");
  if (d.buttons.length > 3 || d.buttons.some((b) => b.trim().length < 1 || b.trim().length > 25)) errors.push("Até 3 botões, de 1 a 25 caracteres cada.");
  const ph = templatePlaceholders(body);
  if (ph.length > 0 && (ph[0] !== 1 || ph[ph.length - 1] !== ph.length)) errors.push("As variáveis precisam ser {{1}}, {{2}}… em sequência.");
  else if (d.examples.filter((e) => e.trim()).length !== ph.length) errors.push(`Informe um exemplo para cada variável (${ph.length}).`);
  if (body.startsWith("{{") || body.endsWith("}}")) errors.push("O texto não pode começar nem terminar com uma variável.");
  return errors;
}

/** Substitui {{n}} pelos valores (índice 0 = {{1}}). Variável sem valor fica como está. */
export function renderTemplate(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (m, n: string) => params[Number(n) - 1] ?? m);
}

/** Valor de variável aceito pelo envio: sem quebra de linha/tabulação e até 200 caracteres. */
export function isValidParam(v: string): boolean {
  const t = v.trim();
  return t.length > 0 && t.length <= 200 && !/[\r\n\t]/.test(t);
}

export function templateParts(components: TemplateComponent[] | null | undefined): TemplateParts {
  const list = components ?? [];
  const get = (type: string) => list.find((c) => c.type === type);
  return {
    header: get("HEADER")?.text ?? null,
    body: get("BODY")?.text ?? "",
    footer: get("FOOTER")?.text ?? null,
    buttons: (get("BUTTONS")?.buttons ?? []).map((b) => b.text),
  };
}

/** Exemplos cadastrados no corpo (primeira linha do `body_text`). */
export function templateExamples(components: TemplateComponent[] | null | undefined): string[] {
  return (components ?? []).find((c) => c.type === "BODY")?.example?.body_text?.[0] ?? [];
}

/** Primeiro nome para preencher {{1}}: "Ana Souza (teste)" → "Ana". */
export function firstName(displayName: string | null | undefined): string {
  return (displayName ?? "").trim().split(/\s+/)[0] ?? "";
}
