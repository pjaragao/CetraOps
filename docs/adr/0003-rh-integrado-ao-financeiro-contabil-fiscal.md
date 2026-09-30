# ADR-0003 — RH completo, integrado ao financeiro, contábil e fiscal

**Contexto.** A primeira versão tratava RH como "leve" (folha oficial do contador). Faltavam escalas, férias, benefícios, rescisão e a integração com caixa, razão e obrigações.

**Decisão.** Módulo `hr` com: admissão (CLT/PJ/estágio/intermitente), escalas e cobertura de picos, ponto e banco de horas, férias (períodos aquisitivos, fracionamento, 1/3, abono), benefícios e descontos,
folha com INSS/IRRF/FGTS (tabelas parametrizadas e versionadas), provisões (férias e 13º), rescisões (todas as modalidades) e eventos do eSocial.
Cada fechamento gera **títulos a pagar** (salários, guias, FGTS, DAS) e **lançamentos no razão** pelas contas configuradas; as obrigações entram no calendário fiscal.

**Consequências.** O custo de pessoal aparece no DRE por loja; a folha estimada é conferida com a do contador (importação); as tabelas legais são dados, não código.
