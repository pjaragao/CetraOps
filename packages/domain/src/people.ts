/** Cadastro único: rótulos dos papéis e dos vínculos entre pessoas (a regra mora no banco: crm.add_relation). */
export const PARTY_ROLE_LABEL: Record<string, string> = {
  CUSTOMER: "Cliente", SUPPLIER: "Fornecedor", AFFILIATE_TRAINER: "Afiliada / trainer", PARTNER_GYM: "Academia parceira", INFLUENCER: "Influenciadora",
  CARRIER: "Transportadora", SERVICE_PROVIDER: "Prestador de serviço", SHAREHOLDER: "Sócio(a) da empresa", EMPLOYEE: "Colaboradora (RH)", ACQUIRER: "Adquirente", BANK: "Banco",
};

/** Papéis que se escolhem à mão (colaboradora vem do RH; adquirente e banco, das integrações). */
export const EDITABLE_ROLES = ["CUSTOMER", "SUPPLIER", "AFFILIATE_TRAINER", "PARTNER_GYM", "INFLUENCER", "CARRIER", "SERVICE_PROVIDER", "SHAREHOLDER"] as const;

/** "O que a OUTRA pessoa é para esta": o valor vai para crm.add_relation. */
export const RELATION_OPTIONS: { value: string; label: string }[] = [
  { value: "PARENT", label: "É mãe ou pai desta pessoa" }, { value: "CHILD", label: "É filha ou filho desta pessoa" },
  { value: "SPOUSE", label: "É esposa ou marido (casados)" }, { value: "PARTNER", label: "É companheira(o) / namorada(o) / união estável" },
  { value: "SIBLING", label: "É irmã ou irmão" }, { value: "GRANDPARENT", label: "É avó ou avô" }, { value: "GRANDCHILD", label: "É neta ou neto" },
  { value: "AUNT_UNCLE", label: "É tia ou tio" }, { value: "NIECE_NEPHEW", label: "É sobrinha ou sobrinho" }, { value: "FRIEND", label: "É amiga(o)" },
];

const LABELS: Record<string, [string, string, string]> = {   // [feminino, masculino, neutro]
  PARENT: ["mãe", "pai", "mãe ou pai"], CHILD: ["filha", "filho", "filho(a)"], SPOUSE: ["esposa", "marido", "cônjuge"], PARTNER: ["companheira", "companheiro", "parceiro(a)"],
  SIBLING: ["irmã", "irmão", "irmão(ã)"], GRANDPARENT: ["avó", "avô", "avô(ó)"], GRANDCHILD: ["neta", "neto", "neto(a)"], AUNT_UNCLE: ["tia", "tio", "tio(a)"],
  NIECE_NEPHEW: ["sobrinha", "sobrinho", "sobrinho(a)"], FRIEND: ["amiga", "amigo", "amigo(a)"],
};

/** O que o parente é para a pessoa, pelo gênero dele (F, M ou desconhecido). */
export function relativeLabel(role: string, gender?: string | null): string {
  const l = LABELS[role];
  return l ? (gender === "F" ? l[0] : gender === "M" ? l[1] : l[2]) : "pessoa próxima";
}
