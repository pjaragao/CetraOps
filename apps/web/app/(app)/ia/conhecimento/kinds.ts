/** Tipos de documento da base de conhecimento (rótulo e dica do que escrever). */
export const KINDS: Record<string, { label: string; hint: string }> = {
  POLICY: { label: "Política", hint: "Regras da loja: troca, pagamento, entrega, prazos." },
  FAQ: { label: "Pergunta frequente", hint: "Dúvidas que as clientes repetem, com a resposta que vocês dão." },
  PRODUCT_CARE: { label: "Cuidado com as peças", hint: "Lavagem, secagem, tecidos, tabela de medidas." },
  BRAND: { label: "Marca", hint: "História, valores, comunidade, como vocês gostam de ser apresentados." },
  EVENT: { label: "Evento", hint: "Drops, cafés da manhã, ensaios: quando, onde e como participar." },
  OTHER: { label: "Outro", hint: "Qualquer outra informação que a equipe costuma passar." },
};

export const STATUS: Record<string, { label: string; tone: "success" | "warning" | "neutral" }> = {
  PUBLISHED: { label: "publicado", tone: "success" },
  DRAFT: { label: "rascunho", tone: "warning" },
  ARCHIVED: { label: "arquivado", tone: "neutral" },
};
