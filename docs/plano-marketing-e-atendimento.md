# Plano de marketing e atendimento: aquisição, atendimento, retenção e recuperação de clientes

> **Versão 1.0 · 01/10/2026 · documento de planejamento. Nada da Parte 3 em diante foi implementado.**
> A Parte 1 descreve o sistema como ele está hoje (branch `claude/erp-omnichannel-analysis-c3b135`, commit `eb54625`).
>
> **Para quem:**
> - sócios: decisões, metas e rotina de gestão;
> - vendedora: rotina do dia a dia;
> - quem desenvolve: Parte 5 e anexos.

**Conteúdo**
- Resumo executivo
- Parte 1: como operar hoje
- Parte 2: diagnóstico (o que falta em cada etapa)
- Parte 3: proposta
- Parte 4: como fica a operação com a proposta
- Parte 5: plano de implantação
- Anexos: glossário, automações recomendadas, modelos de mensagem, quem pode receber o quê

---

## Resumo executivo

### O desafio
A loja fica dentro da academia parceira, e a base de alunas é finita: 400 no 1º mês e cerca de 1.100 na maturidade (doc 04 do plano de negócios).

A projeção pede que **15 a 16% dos alunos comprem todo mês**: 150 a 176 vendas por mês, com ticket de R$ 430 a R$ 450. Essa conta só fecha com recompra:

| Se viram clientes… | Compras por cliente por mês (exemplo: mês 6, 150 vendas) | Cada cliente compra a cada… |
|---|---|---|
| 40% dos alunos (400) | 150 ÷ 400 = 0,375 | ~2,7 meses |
| 60% dos alunos (600) | 150 ÷ 600 = 0,25 | 4 meses |

**Retenção e recuperação não são um complemento da aquisição: são a maior parte da receita projetada.**

### Onde estamos
O sistema já tem as peças certas:
- **Atendimento:** caixa de entrada única com IA (piloto, copiloto e humano), templates e automações.
- **Clientes:** ficha 360°, funis, tarefas, afiliados e prospecção assistida.
- **Marketing:** campanhas com consentimento, eventos com RSVP, anúncios com retorno real e cupons.

Mas a operação é **reativa e não mede o ciclo da cliente**:
- **Origem:** não se sabe de onde vêm as alunas da academia parceira. Só o anúncio de WhatsApp registra origem.
- **Score:** aparece nas telas, mas nada o calcula (fica zero).
- **Estágios:** ninguém vira VIP, inativa ou perdida sozinha.
- **Pós-compra:** não existe régua depois da compra.
- **Inatividade:** a cliente parada vira uma tarefa genérica, e ninguém mede se ela voltou.
- **Fora do horário:** em modo copiloto, a cliente que escreve à noite espera até a manhã.

### O que propomos
Um **motor de ciclo de vida** com quatro frentes e uma base comum:

1. **Aquisição** com origem registrada em todo contato: QR na academia parceira, links rastreados, anúncios, indicação, eventos e trainers.
2. **Atendimento que converte:**
   - horário de atendimento real e distribuição automática das conversas;
   - avisos transacionais automáticos e retomada de vendas paradas;
   - desfecho registrado e pesquisa de satisfação.
3. **Retenção:**
   - estágios e níveis calculados, régua pós-compra e foco na **2ª compra**;
   - lista diária da vendedora, avise-me;
   - níveis com benefícios e pré-venda VIP de drops.
4. **Recuperação:** reativação em 3 faixas com grupo de controle, retomada de oportunidades perdidas pelo motivo da perda e reclamação tratada como caso.
5. **Base comum:** painel do ciclo de vida, coortes, resultado de cada régua e regras de contato (consentimento, frequência, horário e prioridade).

### Como implantar
- **Fase 0, sem código (1 a 2 semanas):** configurar melhor o que já existe — automações, templates, base de conhecimento, QR com etiqueta de origem e aceite no PDV.
- **Cinco fases de desenvolvimento (cerca de 11 a 12 semanas no total).** Começam pelos dados (estágios, score e origem), porque todo o resto depende deles.

### O que não muda
- A IA redige e organiza; a mensagem pessoal sai de uma pessoa.
- Disparo automático só para aviso transacional e campanha aprovada, sempre com consentimento e limite de frequência.

---

# Parte 1 — Como operar hoje

## 1.1 O caminho da cliente no sistema atual

```
 ENTRADA                        ATENDIMENTO                           VENDA                    DEPOIS DA VENDA
 Anúncio WhatsApp (CTWA) ─┐
 Instagram: DM, comentário,├─▶ Caixa de entrada ─▶ IA Piloto · IA Copiloto ─▶ PDV, pedido, link ─▶ Tarefas manuais
   menção em story        │    única + automações   · Humano · Aguardando      reserva, armário     (aniversário, parada)
 Telegram                 │                                                    VIP, troca           Campanha pontual
 Balcão (PDV)             │                                                                         Eventos & Drops
 Prospecção (app oficial) ┘
        ▲                                                                                               │
        └──────────── não existe volta automática: nada traz a cliente de novo de forma planejada ◀─────┘
```

## 1.2 Configuração inicial (uma vez, pelos sócios)

| Passo | Onde | O que fazer | Observação |
|---|---|---|---|
| 1 | Configurações › Integrações | Conectar WhatsApp (Meta), Instagram, Telegram e Meta Ads. Cadastrar cada canal com o modo padrão da IA (padrão: **IA Copiloto**) e a persona | O canal **ainda não tem horário de atendimento**: o campo existe no banco, mas não há tela, e a IA e o SLA não o usam |
| 2 | Inteligência › Personas | Enviar os históricos (WhatsApp .txt, Instagram .json), revisar o que é conversa comercial, gerar e aprovar o perfil de estilo | O arquivo bruto é apagado depois do processamento |
| 3 | Inteligência › Base de conhecimento | Escrever e **publicar**: trocas, cuidados com as peças, medidas, pagamento, retirada e armário, eventos | A IA só usa o que foi publicado; sem resposta, transfere para uma pessoa |
| 4 | Inteligência › Avaliações da IA e Modelos & custos | Rodar as avaliações e escolher o modelo de atendimento | O modelo de atendimento só troca se passar no portão de avaliação |
| 5 | Atendimento › Templates | Criar templates (Marketing ou Utilidade) e enviar para aprovação da Meta. Criar respostas rápidas (`/atalho`) | Fora da janela de 24 h, o WhatsApp só aceita template aprovado |
| 6 | Atendimento › Automações | Criar e **ligar** as regras (todas nascem desligadas) | Configuração sugerida no Anexo B |
| 7 | Marketing › Cupons e Clientes › Afiliados | Cupons de campanha; uma afiliada por trainer (desconto da aluna padrão 10%, comissão padrão 8%) | Comissão paga em vale-troca ou Pix |

## 1.3 Aquisição hoje

| Porta de entrada | O que o sistema faz sozinho | O que a equipe faz | Onde acompanhar |
|---|---|---|---|
| Anúncio que abre o WhatsApp (CTWA) | Cria a lead com o anúncio de origem; roda a automação "Chegou por anúncio" (se ligada); a IA atende conforme o modo; a venda é informada à Meta (CAPI) | Assumir quando a IA chama; cumprir a tarefa | Marketing › Anúncios Meta: gasto, leads e receita **do sistema** por anúncio |
| Instagram: DM, comentário, menção em story | Cria a lead; automações respondem comentário em privado (uma vez, em até 7 dias) e agradecem a menção | Responder as DMs | Atendimento › Automações (últimas execuções) |
| Prospecção assistida | Monta a lista do dia (até 15 leads com @ e sem recusa), na cadência story → curtir → seguir → DM; a IA redige a DM | Executar **pelo app oficial** do Instagram e marcar Feito ou Pulado (com motivo) | Clientes › Prospecção assistida |
| Trainers (afiliados) | Cupom com desconto para a aluna; extrato mensal de comissão | Divulgar o cupom; aprovar o extrato | Clientes › Afiliados |
| Eventos & Drops | Convites (um a um ou por público, até 200), RSVP com lista de espera e funil "Convidados de eventos"; a IA confirma presença pela conversa | Convidar, fazer check-in e fechar o evento | Marketing › Eventos & Drops: vendas das convidadas (de 1 dia antes a 7 dias depois) × custo real |
| Balcão (PDV) | Cadastro rápido por telefone e nome, com caixa de aceite de marketing no WhatsApp | **Perguntar** se ela aceita receber novidades | Clientes › Clientes & Leads |
| Telegram | Atende depois do `/start` | — | Atendimento |

> **Limite importante:** fora do anúncio de WhatsApp, a origem não é registrada. Uma aluna que viu a loja na academia parceira e mandou mensagem aparece apenas como "WhatsApp".

## 1.4 Atendimento hoje: a caixa de entrada

**Filtros:** Todas · Minhas · Não atribuídas · Aguardando humano · IA atendendo · Janela expirando (fecha em até 2 h).

**Os quatro modos** (controle no topo da conversa):

| Modo | O que acontece |
|---|---|
| IA Piloto | A IA envia sozinha **somente** quando todas as condições abaixo valem. Caso contrário, vira rascunho |
| IA Copiloto | A IA deixa um **rascunho**: Enviar, Editar ou Descartar (com motivo). Não cria pedido, link nem reserva sozinha |
| Humano | Só pessoas respondem. Responder pelo celular (app oficial) também muda a conversa para Humano |
| Aguardando humano | A IA mandou uma mensagem de espera e chamou alguém. Prazo (SLA): **5 min** para VIP, VIP Black e casos que a IA marca como urgentes; **15 min** para os demais |

**Condições para a IA Piloto enviar sozinha:**
1. A intenção é segura: saudação, estoque, informação de produto, guia de medidas, informações da loja, status do pedido, reserva, link de pagamento, armário ou confirmação de evento.
2. A confiança é de pelo menos 0,75.
3. O validador não encontrou problema.
4. A janela do canal permite o envio.
5. A cliente não é VIP Black.

**Regras que valem antes da IA** (não custam IA):
- **Descadastro:** "parar", "sair" ou "não quero mais receber" retira os aceites de marketing (WhatsApp, e-mail e Instagram) e envia uma confirmação.
- **Pedido de pessoa:** "atendente" ou "falar com a Luisa" → Aguardando humano.
- **Temas formais:** Procon, advogado, chargeback ou "golpe" → Aguardando humano.
- **Saúde:** lesão, gestação ou cirurgia → a IA não envia sozinha; vira rascunho para uma pessoa revisar.
- **Sempre com pessoa:** reclamação, troca ou defeito, negociação de preço, B2B, parceria e problema de pagamento.

**Na conversa:**
1. **Pausar IA 2 h** quando você for conduzir pessoalmente.
2. **Responsável:** atribua a conversa a alguém, que recebe um aviso.
3. **Nota interna** com @menção: a cliente não vê, e quem foi mencionada é avisada.
4. **Devolver para a IA** (Copiloto ou Piloto), com uma instrução opcional. Exemplo: "confirme o endereço e envie o link". A instrução vale até a conversa voltar para uma pessoa.
5. **Janela fechada:** escolha um template aprovado. Template de marketing exige aceite; o de utilidade vale sempre.
6. **Respostas rápidas:** digite `/atalho`.
7. **Painel lateral:** estágio, nível, score, tamanhos, últimas compras e LTV, com link para a ficha 360°.

**O que a IA consegue fazer na conversa:**

| Tipo | O que faz |
|---|---|
| Consultas | Catálogo, estoque por tamanho, ficha da cliente (sem CPF e sem endereço completo), status do pedido, políticas, base de conhecimento e próximos eventos |
| Vendas | Aplicar cupom (ela não cria desconto); reservar até 48 h; agendar Armário VIP; montar e confirmar pedido; gerar link de pagamento. Pedido, link, reserva, armário e confirmação de presença **só no modo Piloto** |
| Cadastro | Registrar aceite; atualizar perfil (tamanhos, preferências); guardar fatos (por exemplo, "prefere cintura alta") |
| Controle | Chamar uma pessoa |

**Alertas (sino):**
- SLA estourado (verificado a cada minuto);
- janela fechando, 2 h antes, quando a cliente espera uma pessoa;
- menções e atribuições.

**Atendimento › Desempenho** (muda com o período escolhido no topo):

| Grupo | Indicadores |
|---|---|
| Volume e tempo | Conversas novas; tempo até a 1ª resposta (mediana e 9 em 10); mensagens sem resposta; SLA estourado |
| IA | Respostas da IA (%); resolvidas só pela IA; transferências automáticas; custo da IA por conversa; rascunhos enviados como vieram × editados × descartados (com motivos) |
| Vendas | Vendas saídas de conversa e quantas tiveram ajuda da IA |
| Quem e quando | Quem respondeu primeiro; conversas por canal; horários em que a cliente escreve; respostas por pessoa |

## 1.5 Retenção hoje

- **Ficha 360°** (Clientes › nome da cliente). Mostra:
  - números: LTV, ticket médio, dias desde a última compra (alerta acima de 60) e vale-troca disponível;
  - perfil: pagamento preferido, parcelamento médio, tamanhos, se é aluna da academia parceira e origem;
  - contatos e aceites (LGPD);
  - histórico: conversas, compras e linha do tempo.

  **A ficha é só leitura:** tamanhos, aniversário e preferências só entram pela IA. Se a IA não registrar, não entram.
- **Tarefas & próximas ações:** criadas pelas automações (aniversário, cliente parada, lead de anúncio), pela prospecção ou à mão. Cada tarefa tem prazo, responsável e mensagem pronta.
- **Funis:**
  - Vendas varejo: Novo contato → Qualificado → Em atendimento → Reserva/Armário VIP → Ganho ou Perdido (com motivo);
  - Corporativo;
  - Recrutamento de afiliados;
  - Convidados de eventos.
- **Campanhas (WhatsApp):**
  1. Com um template de marketing aprovado, clique em **Criar rascunho**.
  2. Defina o público por estágio, nível, score mínimo, dias sem comprar, mês de aniversário, cidade, etiqueta ou convidadas de um evento (pelo RSVP).
  3. Confira a **prévia**: quem fica de fora e por quê (sem aceite, recusou, sem telefone ou recebeu há pouco).
  4. Agende o envio. O sistema respeita:
     - o limite diário do número (padrão 250);
     - o intervalo mínimo por pessoa (padrão 7 dias);
     - a recusa feita no meio do disparo, que vale na hora.
  5. Acompanhe o resultado: entregues, lidas, responderam, **compraram em até 7 dias** e receita.
- **Vender:**
  - reservas e Armário VIP, com o resultado da retirada (levou tudo, parte ou nada);
  - trocas com vale-troca;
  - entregas.
- **Aniversário:** a automação cria uma **tarefa** (não envia mensagem), e só para quem tem data de nascimento cadastrada.

## 1.6 Recuperação hoje

- **Cliente parada:** automação diária às 08:00. Cria tarefa para quem é cliente ou VIP e não compra há N a N+30 dias. São até 200 tarefas por dia por regra, sem repetir a mesma pessoa antes de 60 dias.
- **Campanha para inativas:** público "dias sem comprar", somente quem deu aceite de marketing.
- **Oportunidade perdida:** exige motivo, mas não existe retomada.
- **Reclamação:** vira "Aguardando humano"; a solução não fica registrada.
- **Descadastro:** é respeitado em campanhas, automações e prospecção.

## 1.7 Rotina possível hoje (sem mudar o sistema)

**Vendedora, todo dia:**
1. **Abertura:**
   - Início → "Aguardando humano";
   - Caixa de entrada › Minhas e Não atribuídas;
   - rascunhos pendentes.
2. Clientes › Tarefas: vencidas e de hoje (aniversários, paradas, leads de anúncio).
3. Clientes › Prospecção assistida: gerar a lista e executar os passos pelo app.
4. Vender › Reservas: armários e reservas vencendo.
5. **Fechamento:** zerar "Aguardando humano" e não deixar conversa com janela fechando sem resposta.

**Sócios:**
- **Diário (10 min):** Início, Central de sugestões e conversas de VIP.
- **Semanal (30 min):**
  - Atendimento › Desempenho e Marketing › Anúncios Meta;
  - resultado da campanha da semana;
  - motivos de descarte dos rascunhos, para ajustar a persona e a base de conhecimento.
- **Por evento:** Marketing › Eventos & Drops — convites, RSVP, check-in e, ao final, fechar o evento e ver o resultado.

## 1.8 O que existe e o que não existe (resumo)

| Frente | Já existe | Não existe |
|---|---|---|
| Aquisição | Origem de anúncio CTWA; automações de Instagram; prospecção assistida; afiliados; eventos; cadastro no PDV com aceite; ROAS real por anúncio; CAPI | Origem de QR, bio e links; score calculado; indicação de clientes; públicos Meta; nutrição de leads |
| Atendimento | Inbox única; 4 modos; regras sem IA; SLA por nível; alertas; notas, atribuição, pausa e devolução; templates; respostas rápidas; Desempenho | Horário de atendimento aplicado; distribuição automática; desfecho; resumo e classificação; avisos transacionais automáticos; retomada de vendas paradas; CSAT/NPS |
| Retenção | Ficha 360° (leitura); tarefas com mensagem pronta; campanhas com aceite e limites; aniversário (tarefa); vale-troca; Armário VIP | Estágios e níveis automáticos; RFM; régua pós-compra; foco na 2ª compra; lista diária priorizada; avise-me; níveis com benefícios; pré-venda VIP |
| Recuperação | Tarefa de cliente parada; campanha para inativas; motivo de perda obrigatório | Faixas de reativação; grupo de controle; retomada por motivo de perda; caso de reclamação |
| Medição | Desempenho do atendimento; resultado de campanha (7 dias); resultado de evento; Relatórios (vendas, curva ABC, cruzamento) | Painel do ciclo de vida; coortes; resultado de régua; satisfação; conversão por origem |

---

# Parte 2 — Diagnóstico: o que falta em cada etapa

| # | Etapa | O que falta | Efeito no negócio | Onde se vê no sistema |
|---|---|---|---|---|
| 1 | Aquisição | Origem das alunas da academia parceira (QR, bio, links, trainers) | Não se sabe qual ação traz cliente; o investimento em eventos e materiais não tem retorno medido | Só o anúncio CTWA grava origem; não há links rastreados |
| 2 | Aquisição | Score de lead calculado | Prospecção e públicos ordenados por um número que fica zero | Regras v1 estão no seed (`crm.lead_scoring_rules`), mas nenhuma rotina as aplica |
| 3 | Aquisição | Cadastro completo | Aniversário, tamanho e preferências faltam, e as automações e a recomendação ficam cegas | Ficha 360° só leitura; o PDV grava só nome, telefone e aceite |
| 4 | Aquisição | Indicação de clientes ("indique uma amiga") | O canal mais barato, numa base de alto padrão, fica parado | Só trainers têm cupom |
| 5 | Aquisição | Nutrição de leads que conversaram e não compraram | A lead esfria depois da janela de 24 h | Nada além do funil manual |
| 6 | Aquisição | Públicos Meta (clientes com aceite, semelhantes, exclusões) | Anúncio de aquisição gasta com quem já é cliente | Não construído de propósito, aguardando validação da API |
| 7 | Atendimento | Horário de atendimento aplicado | À noite, em copiloto, a cliente fica sem resposta; o SLA conta 24 h e gera alerta de madrugada | O campo `business_hours` do canal existe no banco, sem tela e sem uso |
| 8 | Atendimento | Distribuição automática | Conversas "Não atribuídas" dependem de alguém olhar | Atribuição apenas manual |
| 9 | Atendimento | Desfecho da conversa | Não dá para medir conversão por motivo, canal ou pessoa | Encerrar não pede resultado |
| 10 | Atendimento | Resumo ao encerrar e classificação (tema, intenção, sentimento) | Não se sabe o que mais se pergunta; lacunas da base ficam invisíveis | Só há resumo quando a IA transfere a conversa; a rota `classify` só é usada nas personas, e a `summarize` não é usada |
| 11 | Atendimento | Avisos transacionais automáticos | Cliente pergunta "já está pronto?"; armários e reservas vencem sem aviso | Template pode ser enviado à mão; nada dispara sozinho |
| 12 | Atendimento | Retomada de venda parada | Link não pago, reserva vencida e armário devolvido viram perda silenciosa | Rotinas só expiram reservas e pedidos |
| 13 | Atendimento | Satisfação (CSAT e NPS) | Sem termômetro de qualidade e sem alerta de detratora | Não existe |
| 14 | Retenção | Estágios e níveis automáticos | Ninguém vira VIP, inativa ou perdida; os públicos ficam errados | Estágio só muda na compra (vira Cliente); o nível é manual |
| 15 | Retenção | Régua pós-compra | A 2ª compra, que define a recorrência, fica por conta da sorte | Não existe |
| 16 | Retenção | Lista diária priorizada (próxima melhor ação) | A vendedora não sabe com quem falar primeiro | Tarefas sem prioridade de valor |
| 17 | Retenção | Avise-me e lista de desejos | Venda perdida quando falta o tamanho | A reserva tem o motivo "lista de espera", mas sem fluxo |
| 18 | Retenção | Níveis com benefícios e pré-venda VIP | Nada diferencia a cliente fiel | Nível existe só como rótulo |
| 19 | Retenção | Sugestões sobre clientes | A Central de sugestões só olha a operação (estoque, caixa, desconto, cancelamentos, queda de vendas, margem) | Nenhum detector de cliente |
| 20 | Recuperação | Reativação em faixas, com mensagem por perfil | A tarefa genérica não diz o que oferecer | A automação de cliente parada cria uma tarefa igual para todas |
| 21 | Recuperação | Grupo de controle | Não se separa o que aconteceria de qualquer jeito | Resultado de campanha = compras em 7 dias, sem comparação |
| 22 | Recuperação | Retomada de oportunidades perdidas por motivo | A perda "tamanho indisponível" não volta quando o tamanho chega | Motivo gravado e nunca usado |
| 23 | Recuperação | Reclamação como caso (dono, prazo, solução, retorno) | Cliente insatisfeita some sem registro | Só o modo "Aguardando humano" |
| 24 | Medição | Painel do ciclo de vida e coortes | Os sócios não veem quantas viraram clientes, quantas voltaram e quantas sumiram no mês | Os relatórios atuais são de vendas, curva ABC e cruzamento fiscal |

---

# Parte 3 — Proposta

## 3.1 Princípios

1. **Consentimento primeiro.**
   - Pedir no primeiro contato e no PDV, com texto padronizado e versionado.
   - Marketing só com aceite; a recusa vale na hora.
2. **A pessoa fica com o que é pessoal.**
   - Automação cria a tarefa com mensagem pronta e a IA redige.
   - Contato de relacionamento é enviado por uma pessoa.
   - Envio automático só para aviso transacional e para campanha ou régua aprovada.
3. **Toda régua tem objetivo e saída.** A cliente sai quando compra, responde, recusa ou abre uma reclamação.
4. **Orçamento de contato por cliente:** limite de mensagens proativas por período, com prioridade entre os tipos de mensagem (§3.7).
5. **Medir o incremento.** Réguas de marketing têm um grupo de controle de 10%, que não recebe nada.
6. **Dados nascem certos:** origem em todo contato; tamanho, aniversário e aceite no cadastro.
7. **Regras da Meta respeitadas no servidor** (Anexo D):
   - janela de 24 h e categorias de template;
   - Instagram sem DM fria;
   - tag de agente humano só para pessoas.
8. **Tudo configurável sem deploy e auditado:** limiares, textos, prazos e limites.

## 3.2 Base comum: o motor do ciclo de vida

### Estágios (recalculados toda noite e a cada compra)

Os limiares abaixo são proposta inicial; os sócios decidem os valores (§5.5).

| Estágio | Entra quando | Objetivo | Quem cuida |
|---|---|---|---|
| Lead | Primeiro contato, sem compra | Qualificar e pedir o aceite | IA + vendedora |
| Prospect (qualificada) | Score ≥ 40, interesse em produto ou tamanho, ou RSVP de evento | Levar ao provador ou à 1ª compra | Vendedora |
| Cliente nova | 1ª compra (até a 2ª compra ou 90 dias) | **2ª compra** | Vendedora (régua pós-compra) |
| Cliente recorrente | 2 ou mais compras nos últimos 12 meses | Frequência e ticket | Vendedora |
| VIP | ≥ R$ 2.000 ou ≥ 4 compras em 12 meses | Exclusividade | Dona do relacionamento |
| VIP Black | Top 5% da receita de 12 meses (mínimo R$ 5.000), por convite dos sócios | Relação direta com os sócios | Sócia |
| Em risco (sinal, não estágio) | Sem compra há mais de 1,5 vez o intervalo habitual dela (ou 60 dias, se comprou uma vez só) | Contato pessoal antes de esfriar | Dona do relacionamento |
| Inativa | 120 dias sem compra | Reativação | Régua de recuperação |
| Perdida | 365 dias sem compra, ou pediu para não receber nada | Não insistir; só se ela voltar | — |

**Como funciona:**
- Os estágios atuais do cadastro já cobrem isso: Lead, Prospect, Cliente, VIP, Inativo e Perdido.
- "Nova" e "recorrente" viram atributos de Cliente; "VIP" e "VIP Black" usam o nível que já existe.
- Toda mudança vai para a linha do tempo da cliente.
- Duas mudanças avisam a dona do relacionamento: VIP que entra em risco e cliente nova que chega a 30 dias sem a 2ª compra.

### Segmentos RFM simples (para o painel e para públicos)

RFM combina **Recência** (dias desde a última compra), **Frequência** (compras em 12 meses) e **Valor** (gasto em 12 meses). Com uma base pequena, faixas fixas funcionam melhor que quintis.

| Segmento | Regra (exemplo) | Ação típica |
|---|---|---|
| Campeãs | Até 60 dias · 4+ compras · valor alto | Pré-venda, eventos fechados e indicação |
| Fiéis | Até 90 dias · 2 a 3 compras | Complemento do look e convite VIP |
| Novas promissoras | Até 45 dias · 1 compra | Régua pós-compra e 2ª compra |
| Precisam de atenção | 61 a 120 dias · 2+ compras | Contato pessoal (em risco) |
| Hibernando | 121 a 365 dias | Reativação |
| Perdidas | Mais de 365 dias | Nada proativo |

### Score de lead com explicação

1. **Regras v1 (já no seed).** Pontos:
   - profissão-alvo: 20;
   - esporte-alvo: 20;
   - contato completo: 10;
   - cidade-alvo: 10;
   - conversa engajada: 20;
   - comprou: 20.

   Faixas: quente a partir de 70 e morna a partir de 40.
2. **Sinais novos propostos:**
   - aluna da academia parceira confirmada: +15;
   - veio por indicação: +10;
   - compareceu a evento: +10;
   - respondeu nos últimos 7 dias: +10;
   - perguntou tamanho ou preço: +10.
3. **Explicação visível.** Exemplo: "72 = esporte (pilates) 20 + academia parceira 15 + conversa 20 + indicação 10 + contato 7". Isso atende à transparência exigida pela LGPD para perfilamento.
4. **Uso:** recalculado toda noite e a cada evento relevante. Ordena a prospecção, a lista do dia e os públicos.

## 3.3 Aquisição

**A1. QR e links rastreados (captura dentro da academia parceira)**
- **Onde entram os QR:** recepção, vestiários, estúdio de pilates/reformer, araras, sacolas, cartão de agradecimento e materiais de evento.
- **Links rastreados:** bio do Instagram, stories, TikTok, um por trainer e um por campanha.
- **Como funciona:** cada QR ou link abre o WhatsApp com um texto pronto e um código. O sistema grava a origem no **primeiro e no último toque**.
- **Na tela:** Marketing › Links rastreados. Cria o link, baixa o QR e mostra leads, clientes e receita por link.
- **Já dá para começar hoje (Fase 0):**
  - o texto pronto do QR ("Oi! Vim pelo QR da recepção da academia parceira") dispara uma automação de palavra-chave;
  - a automação só coloca a etiqueta `origem-qr-recepcao` e não responde, para a IA atender normalmente.
- **Atenção:** colocar QR nas áreas da academia parceira depende da autorização dela (contrato).

**A2. Boas-vindas e qualificação no primeiro contato**
- **Roteiro curto da IA** (no máximo 3 perguntas, ao longo da conversa e não em formulário):
  - atividade principal;
  - tamanho habitual;
  - para quando ela precisa.
- **Oferta de valor:** provador reservado ou Armário VIP para provar no horário do treino.
- **Pedido de aceite** com texto padronizado e versionado (Anexo C).
- **Ferramentas:** registrar aceite e atualizar perfil já existem; falta o roteiro e o texto padrão na persona e na base de conhecimento.

**A3. Velocidade no lead de anúncio**
- **Resposta em segundos:** IA Piloto para as intenções seguras, quando liberada pelas avaliações. Até lá: boas-vindas automáticas + tarefa com prazo de 15 min.
- **Janela gratuita:** conversa iniciada por anúncio tem janela gratuita de 72 h na regra atual da Meta (conferir na hora de configurar). A régua de lead de anúncio usa essa janela.
- **Sem compra em 48 h:** tarefa de acompanhamento, com resumo da conversa.
- **No painel:** CAC por anúncio (gasto ÷ novas clientes do anúncio) e tempo até a 1ª compra.

**A4. Indique uma amiga**
- **Mecânica:**
  - cada cliente tem um código ou link pessoal;
  - a amiga ganha um benefício de boas-vindas na 1ª compra (por exemplo, um mimo ou 10%);
  - quem indicou ganha vale-troca (por exemplo, R$ 50) quando a amiga compra e passa o prazo de troca.
- **Reaproveita o que existe:** cupom, extrato de afiliados e livro de vale-troca.
- **Contra abuso:**
  - vale só para amiga nova (sem cadastro de cliente);
  - não vale para a própria pessoa;
  - teto mensal por cliente.
- **Divulgação:** cartão na sacola, mensagem pós-compra no D+10 e pós-NPS para promotoras.

**A5. Eventos que trazem gente nova**
- **Acompanhantes:** cada convidada pode levar alguém (o campo de acompanhantes já existe).
- **Check-in por QR** com cadastro rápido e aceite.
- **Resultado do evento:** passa a mostrar também **novas clientes trazidas** e o custo por nova cliente, além das vendas das convidadas.
- **Pós-evento:** agradecimento e looks do evento (tarefa ou template, conforme o aceite).

**A6. Trainers 2.0**
- **Portal do parceiro** (acesso por link mágico): cupom, link e QR rastreados, vendas, comissão e materiais.
- Ranking mensal e kit de conteúdo.
- **Antes de ampliar:** validar a cláusula do contrato com a academia parceira que trata da relação com os funcionários dela.

**A7. Prospecção com prioridade**
- Lista do dia ordenada pelo **score real**.
- **Novas fontes:**
  - quem comentou ou marcou a marca;
  - convidadas de evento sem compra;
  - indicações.
- Resultado por fonte: passos feitos → resposta → 1ª compra.

**A8. Públicos Meta** (depende de validar a chamada da API, que envia telefone com hash)
- Público personalizado só de quem deu aceite.
- Semelhantes a partir das clientes recorrentes.
- **Exclusão** de clientes recentes nos anúncios de aquisição.

**A9. Nutrição de leads**
- **D+2:** lead qualificada sem compra recebe uma tarefa (texto livre, se ela respondeu e a janela está aberta).
- **D+7:** convite para provador ou evento.
- **Depois de 30 dias:** só campanha com aceite, no máximo uma vez por mês.

## 3.4 Atendimento

**B1. Horário de atendimento de verdade**

O roteador passa a ler o horário de cada canal. Fora do horário, a IA:
- responde o que é seguro;
- diz quando a equipe volta;
- deixa uma tarefa com o resumo para a abertura.

O SLA só corre dentro do horário, então não há alerta de madrugada. O campo de horário já existe no banco; falta a tela no cadastro do canal (Configurações › Integrações).

**B2. Distribuição automática**
- **Ordem de quem recebe a conversa:**
  1. a dona do relacionamento, se estiver online;
  2. rodízio entre quem está online, com limite de conversas simultâneas;
  3. a sócia de plantão.
- **VIP e VIP Black** vão direto para a sócia.
- Regra configurável.

**B3. Desfecho ao encerrar**
- **Encerrar** pede o motivo:
  - comprou;
  - reservou ou armário;
  - dúvida resolvida;
  - troca ou devolução;
  - reclamação;
  - sem retorno;
  - não é cliente (fornecedor, spam).
- A IA sugere o desfecho, e uma pessoa confirma.
- Alimenta a conversão por motivo, canal e pessoa.

**B4. Resumo e etiquetas automáticas**
- **Quando:** ao encerrar a conversa ou a cada 24 h.
- **Resumo:** duas linhas na linha do tempo e na memória da cliente.
- **Classificação:** tema, intenção e sentimento.
- **Novas visões:**
  - relatório "o que as clientes perguntam";
  - Central de sugestões ganha o tipo **"lacuna na base"**: perguntas que levaram a uma transferência por falta de resposta publicada.

**B5. Avisos transacionais automáticos** (templates de **utilidade**)

| Momento | Aviso |
|---|---|
| Pagamento | Pagamento confirmado |
| Retirada e entrega | Pronto para retirada; Armário VIP pronto (com prazo); pedido enviado, com rastreio |
| Prazos | Reserva vence em 6 h; link de pagamento vencendo |
| Pós-venda | Vale-troca gerado |
| Evento | Lembrete na véspera para quem confirmou presença |

**Regras:**
- O texto é só transacional, sem oferta, para a Meta não reclassificar o template como marketing.
- Um aviso por fato, sem duplicar.

**B6. Retomada de venda parada**

| Situação | O que acontece |
|---|---|
| Link não pago em 2 h | Lembrete gentil: texto livre se a janela estiver aberta; senão, template de utilidade do link |
| Reserva da IA vencendo | "Quer que eu segure mais 24 h?" |
| Armário devolvido sem compra | Tarefa com o motivo (não serviu, preço, cor) e sugestão de alternativa no tamanho dela |
| Pedido pendente que expirou | Tarefa "retomar venda" |
| Resultado | Relatório "vendas recuperadas" |

**B7. Satisfação**
- **CSAT ao encerrar:** pergunta de 1 toque, com botões de 1 a 5, enviada dentro da janela.
- **NPS 10 dias após a compra:** por template. A categoria é decidida pela Meta na aprovação; se virar marketing, só vai para quem deu aceite.
- **Nota baixa** (CSAT ≤ 3 ou NPS ≤ 6) abre um **caso de recuperação** (D3).

**B8. Clienteling no painel lateral**

Bloco "Para ela agora", com botão para enviar o card:
- novidades no tamanho dela;
- peças que combinam com a última compra;
- reserva e vale-troca disponíveis;
- aniversário próximo;
- próximo evento.

**B9. Qualidade contínua**
- **Revisão semanal** de 10 conversas (IA e pessoas) pelos sócios.
- **Motivos de descarte** dos rascunhos viram ajustes de persona e base.
- **Falhas reais** viram casos novos nas Avaliações da IA.

## 3.5 Retenção

**C1. Motor de ciclo de vida e RFM** (§3.2), com os avisos de "VIP em risco" e de "cliente nova sem 2ª compra".

**C2. Régua pós-compra (primeiras semanas)**

| Quando | Objetivo | Como | Quem |
|---|---|---|---|
| D0 | Encantar e combinar o próximo contato | Na loja: cartão de cuidados com QR + pedido de aceite. Compra remota: mensagem na janela | Vendedora |
| D0 a D+2 | Tranquilizar | Avisos transacionais (B5), quando houver entrega ou retirada | Automático |
| D+4 | Caimento e uso | Tarefa com mensagem pessoal ("como ficou no treino?"). Se ela responde, a janela abre e a IA ajuda com troca ou tamanho | Vendedora |
| D+10 | Ouvir e multiplicar | NPS + convite "indique uma amiga" para quem dá 9 ou 10 | Automático |
| D+21 | Completar o look | Peça que combina, no tamanho dela e com estoque: tarefa (pessoal) ou campanha (com aceite) | Vendedora |
| D+30 a D+45 | 2ª compra | Entra na régua C3 se ainda não voltou | Automático → vendedora |

**C3. Régua da 2ª compra** (a mais importante para a recorrência)
- **Quem entra:** cliente nova sem 2ª compra entre 30 e 45 dias.
- **O que recebe:** convite personalizado — novidade no tamanho dela, provador reservado ou o próximo evento.
- **Mede:** taxa de 2ª compra em 90 dias.

**C4. "Minha lista de hoje" (próxima melhor ação)**

No Início da vendedora, até 10 contatos de relacionamento por dia, ordenados por valor e urgência:
- aniversário;
- pós-compra;
- chegou o tamanho que ela queria;
- VIP em risco;
- convite de evento.

Cada item traz o motivo, a mensagem pronta e os botões **Enviar pela conversa**, **Feito**, **Pular (motivo)** e **Reagendar**.

O botão "Enviar pela conversa" escolhe sozinho a forma de envio:
- texto livre, se a janela estiver aberta;
- template, se a janela estiver fechada e houver aceite;
- se nada disso for possível, o item vira contato presencial ou ligação.

Os sócios veem o placar do dia.

**C5. Avise-me e lista de desejos**
- **Onde é registrado:** na conversa (nova ferramenta da IA) ou no PDV — "quero quando chegar o M".
- **Quando o tamanho chega:** o recebimento entra no estoque e dispara o aviso (template ou tarefa). Uma reserva automática de 24 h é opcional.
- **Drops:** a lista de espera usa o motivo de reserva "lista de espera", que já existe.

**C6. Níveis com benefícios** (sem pontos no começo)

| Nível | Benefícios (proposta) |
|---|---|
| Cliente | Avise-me, convite para eventos abertos, presente de aniversário |
| VIP | Pré-venda de drops 48 h antes; provador ou armário reservado; eventos fechados |
| VIP Black | Tudo do VIP + atendimento direto da sócia; peças separadas antes do lançamento |

- **Cashback em vale-troca** fica para uma segunda etapa: é um passivo e precisa de análise de margem com o contador.
- O livro de vale-troca já suporta **validade** (o motivo "expiração" existe).

**C7. Drops com acesso antecipado**
- VIPs recebem a prévia e reservam antes.
- A lista de espera vira pedido quando a peça chega.
- Mede: venda da pré-venda e participação das VIPs.

**C8. Conteúdo útil, não só oferta**
- A base de conhecimento vira conteúdo: cuidados, guia de tamanhos e looks por atividade.
- A IA usa esse conteúdo nas respostas, e os posts reaproveitam.

**C9. Aniversário com presente**
- **D-3:** tarefa com mensagem pronta + mimo individual válido por 30 dias.
- **Template de marketing** só com aceite.
- **Pré-requisito:** a data de aniversário precisa entrar no cadastro (Fase 1: ficha editável e pergunta no PDV).

## 3.6 Recuperação

**D1. Reativação em 3 faixas, com grupo de controle de 10%**

| Faixa | Quando | Abordagem | Forma |
|---|---|---|---|
| Em risco | 60 a 90 dias, ou 1,5 vez o intervalo dela | Novidade no tamanho dela, sem desconto | Tarefa pessoal (dona do relacionamento) |
| Inativa | 120 dias | Convite para provador ou evento + mimo na próxima visita | Campanha com aceite, ou tarefa |
| Inativa longa | 180 a 365 dias | Última tentativa, com benefício de retorno | Campanha com aceite; sem resposta → Perdida |

- **A cliente sai da régua quando:** compra, responde, recusa ou abre uma reclamação.
- **Medição:** reativadas em 30 dias, comparadas ao grupo de controle.
- **Atenção:** com base pequena, o resultado é **indicativo**. Acumule alguns meses antes de concluir.

**D2. Retomada de oportunidades perdidas, pelo motivo**

| Motivo da perda | Retomada |
|---|---|
| Tamanho indisponível | Volta automaticamente quando o tamanho chega (C5) |
| Preço | Novidades da linha essencial e convites de evento, sem prometer desconto fora da política |
| Sem retorno | Uma tentativa após 7 dias |

Os motivos viram relatório.

**D3. Recuperação de serviço (reclamação)**
1. **Abertura:** o caso abre com dona e prazos — primeira resposta em 1 h útil e solução em 48 h.
2. **Solução registrada:** troca, ajuste ou vale-troca de cortesia (o livro de vale-troca já tem o motivo "cortesia").
3. **Retorno:** contato 7 dias depois, com CSAT.
4. **Durante o caso:** a cliente fica fora de toda régua de marketing.

Detratoras de NPS e CSAT entram no mesmo fluxo. Há um painel de casos abertos.

**D4. Vendas paradas:** link, reserva, armário e pedido (B6).

**D5. Leads frias**
- Lead sem resposta há 60 dias sai da prospecção.
- Ela só volta por anúncio, evento ou indicação; com aceite, recebe a campanha trimestral de novidades.

**D6. Respeito ao "não"**
- Quem pediu para parar não recebe nada proativo.
- Se ela escrever de novo, o atendimento é normal.
- O aceite só é reaberto se ela pedir.

## 3.7 Regras de contato (orquestração)

**Prioridade**, da maior para a menor. A de prioridade maior segura as menores por alguns dias:
1. Transacional: pedido, reserva, armário.
2. Atendimento em andamento.
3. Recuperação de serviço.
4. Relacionamento pessoal (tarefas).
5. Marketing: campanhas e réguas.

**Limites padrão** (configuráveis):
- **Marketing:** no máximo 1 a cada 7 dias (já existe nas campanhas) e 4 por mês por pessoa.
- **Relacionamento:** no máximo 2 contatos pessoais a cada 14 dias.
- **Horário:** proativo só das 9h às 20h, de segunda a sábado; o transacional pode sair fora desse horário.

**Bloqueios** — ninguém recebe proativo se:
- tem reclamação aberta;
- está numa conversa aberta com uma pessoa;
- recusou o contato.

**Custo:** orçamento mensal de templates por categoria, com alerta quando chegar a 80%.

**Implementação:** uma única função de permissão de contato, usada por campanhas, réguas, avisos e pela lista do dia.

## 3.8 Mensuração

**Painel "Ciclo de vida"** (Clientes › Ciclo de vida):
- funil do mês: leads novas → qualificadas → 1ª compra → 2ª compra → VIP;
- base por estágio e por segmento RFM;
- movimentos do mês: entraram, saíram, reativadas e perdidas;
- filtros por origem, canal e loja.

**Relatórios novos** (área Relatórios, com CSV):

| Relatório | O que mostra |
|---|---|
| Aquisição por origem | Leads, conversão em 1ª compra, tempo até a 1ª compra, receita; CAC quando há gasto |
| Recompra e coortes | Mês da 1ª compra × % que voltou em 30, 60, 90 e 180 dias |
| Réguas e campanhas | Alcançadas, responderam, compraram, receita, custo, incremento sobre o controle |
| Atendimento por desfecho | Conversão por motivo, canal e pessoa |
| Satisfação | CSAT, NPS e comentários |
| Motivos de perda | Distribuição dos motivos e retomadas |

**Indicadores e metas iniciais.** São uma proposta: medir a base nos primeiros 60 a 90 dias e recalibrar.

| Indicador | Como se calcula | Hoje | Meta inicial |
|---|---|---|---|
| Leads com origem identificada | Leads do mês com origem ÷ leads do mês | Não medido | ≥ 90% |
| Alunas da academia parceira no cadastro | Clientes marcadas como alunas ÷ total de alunos ativos informado pela academia (só o número) | Não medido | 50% em 6 meses |
| Aceite de marketing no WhatsApp | Clientes com aceite ÷ clientes | Visível só na ficha | ≥ 60% |
| Conversão lead → 1ª compra (30 dias) | Leads do mês que compraram em até 30 dias | Não medido | Base + 30% |
| Tempo até a 1ª resposta, no horário | Mediana | Existe (Desempenho) | ≤ 2 min |
| SLA estourado | Transferências fora do prazo ÷ transferências | Existe | ≤ 5% |
| CSAT | Média de 1 a 5 | Não existe | ≥ 4,6 |
| NPS | Promotoras − detratoras | Não existe | ≥ 70 |
| 2ª compra em 90 dias | Clientes novas do mês que voltaram em até 90 dias | Não medido | ≥ 30% |
| Intervalo médio entre compras | Média por cliente recorrente | Não medido | ≤ 90 dias (coerente com o plano de negócios) |
| Receita de recorrentes | Receita de quem já tinha comprado ÷ receita | Não medido | ≥ 50% a partir do 6º mês |
| Reativação em 30 dias | Reativadas ÷ contatadas, menos o mesmo índice no controle | Não medido | +5 p.p. sobre o controle |
| Vendas paradas recuperadas | Links e reservas pagos depois do lembrete ÷ lembretes | Não medido | ≥ 25% |
| Reclamações resolvidas em 48 h | Casos resolvidos no prazo ÷ casos | Não medido | ≥ 90% |
| Descadastro por envio | Pedidos de saída ÷ mensagens de marketing | Parcial | ≤ 1% |

## 3.9 LGPD, regras da Meta e custos

**LGPD**
- **Bases legais:**
  - marketing por consentimento (já implementado, com evidência e recusa imediata);
  - score e segmentação por **legítimo interesse**, com avaliação documentada (LIA), aviso de privacidade e explicação do score;
  - a cliente pode pedir revisão (art. 20).
- **Dados da academia parceira nunca são importados.** O cadastro das alunas é feito por nós, com aceite (QR, PDV, eventos).

**Meta: WhatsApp**
- Janela de 24 h desde a última mensagem da cliente; fora dela, só template aprovado.
- Template de marketing exige aceite.
- A Meta pode não entregar template de marketing a quem já recebe muitos de várias empresas; o sistema registra a falha e não insiste.

**Meta: Instagram**
- Não existe template, e fora de 24 h só uma pessoa responde, com a tag de agente humano, por até 7 dias.
- Por isso, **réguas usam WhatsApp (com aceite) ou tarefa de contato pessoal**, nunca o Instagram.
- A resposta privada a comentário é uma por comentário, em até 7 dias.

**Custos**
- **Templates:** a cobrança é por template entregue, e marketing custa mais que utilidade. Mensagens de atendimento dentro da janela não são cobradas, e templates de utilidade dentro da janela aberta também não (regra atual; conferir a tabela vigente em reais).
- **IA:** o custo por conversa já aparece em Atendimento › Desempenho.
- **Proposta:** orçamento mensal por categoria, acompanhado no painel.

---

# Parte 4 — Como fica a operação com a proposta

## 4.1 O novo ciclo

```
 ┌──────────── AQUISIÇÃO ────────────┐   ┌────── ATENDIMENTO ──────┐   ┌──────── RETENÇÃO ────────┐
 QR na academia parceira · links rastreados          ─▶ boas-vindas + perfil + aceite ─▶ régua pós-compra · 2ª compra
 anúncios · indicação · eventos           IA no horário certo             lista do dia da vendedora
 trainers · prospecção                    distribuição automática         níveis e benefícios · avise-me
 (origem gravada em todo contato)         avisos · desfecho · satisfação  pré-venda VIP de drops
        ▲                                                                              │
        │                       ┌──────────── RECUPERAÇÃO ────────────┐                │
        └──── indicação ◀────── reativação em 3 faixas (com controle) ◀── em risco ◀───┘
                                perdidas por motivo · reclamação = caso
 MEDIÇÃO: painel do ciclo de vida · coortes · resultado de cada régua · regras de contato
```

## 4.2 Um dia da vendedora

| Horário | O que ela faz | Onde |
|---|---|---|
| Abertura | A noite já chega resolvida: a IA atendeu o que era seguro e deixou tarefas com resumo para o resto. Responder "Aguardando" e os rascunhos | Início → Caixa de entrada |
| Logo depois | **Minha lista de hoje:** até 10 contatos com motivo e mensagem pronta. Enviar, marcar feito ou reagendar | Início |
| Picos da academia (manhã cedo e fim da tarde) | Balcão: venda com ficha completa (tamanho, aniversário, aceite); registrar avise-me; entregar o cartão de indicação | PDV |
| Meio da tarde | Prospecção: passos do dia pelo app oficial, na ordem do score | Clientes › Prospecção assistida |
| Durante o dia | Avisos transacionais, lembretes de link e reserva e CSAT saem sozinhos; ela só entra quando a cliente responde | Caixa de entrada |
| Fechamento | Encerrar conversas com desfecho; conferir armários e reservas vencendo; ver o placar do dia | Caixa de entrada · Reservas · Início |

## 4.3 Rotina dos sócios

- **Diário (10 min):**
  - VIPs em risco;
  - casos de reclamação abertos e detratoras;
  - Central de sugestões, agora com os tipos de cliente e de lacuna na base.
- **Semanal (45 min, segunda-feira):**
  - painel do ciclo de vida e resultado das réguas contra o controle;
  - campanha da semana (no máximo uma);
  - desfechos e motivos de perda;
  - lacunas da base de conhecimento e ajuste de textos.
- **Mensal (2 h):**
  - coortes, metas e orçamento de mídia e de templates;
  - níveis e benefícios;
  - limites de contato;
  - avaliação da persona.

## 4.4 Calendário de um drop (a cada 60 dias)

| Quando | O que acontece |
|---|---|
| T-21 | Definir coleção, meta e orçamento; montar públicos (VIP, convidadas dos últimos eventos, interessadas na categoria) |
| T-14 | Convite VIP com pré-venda (template de marketing, com aceite) e convite geral; RSVP pela conversa com a IA |
| T-7 | Lembrete para quem não respondeu; lista de espera quando lotar |
| T-1 | Lembrete transacional para as confirmadas |
| Dia do evento | Check-in por QR, com cadastro e aceite de acompanhantes; vendas no PDV com a ficha completa |
| D+1 | Agradecimento e looks do evento |
| D+7 | Resultado: vendas das convidadas, **novas clientes trazidas**, custo por nova cliente e margem |
| D+14 | Tarefa para quem confirmou e não veio; convidadas sem compra entram na nutrição (A9) |

## 4.5 Jornadas: antes × depois

**J1. Aluna da academia parceira que viu a loja**

| Hoje | Com a proposta |
|---|---|
| Ela entra na loja ou manda mensagem. No PDV, é cadastrada por telefone se a vendedora lembrar, e o aceite é opcional. A origem não fica registrada. Depois da compra, nada acontece até ela "parar" (tarefa em 45 ou 90 dias, se a automação estiver ligada) | 1. QR no vestiário → WhatsApp com código, e a origem fica gravada.<br>2. A IA dá boas-vindas, pergunta atividade e tamanho, oferece o provador e pede o aceite.<br>3. Ela compra no PDV, com a ficha completa.<br>4. Pós-compra: D+4 caimento, D+10 NPS e indicação, D+21 complemento.<br>5. Se não voltar, a régua da 2ª compra começa no D+30 |

**J2. Lead de anúncio às 22h**

| Hoje | Com a proposta |
|---|---|
| Em copiloto, a IA prepara o rascunho e ninguém envia até a manhã. A lead esfria; o alerta de SLA toca de madrugada | 1. Fora do horário, a IA responde as intenções seguras na hora e avisa que a equipe chama às 9h.<br>2. Tarefa na abertura, com o resumo.<br>3. A janela de 72 h do anúncio é aproveitada.<br>4. Sem compra em 48 h, tarefa de acompanhamento.<br>5. O CAC aparece por anúncio |

**J3. Link de pagamento esquecido**

| Hoje | Com a proposta |
|---|---|
| O pedido pendente expira na rotina noturna e ninguém é avisado | 1. Lembrete depois de 2 h.<br>2. Se vencer, tarefa "retomar venda".<br>3. Resultado no relatório de vendas recuperadas |

**J4. VIP sumiu há 70 dias**

| Hoje | Com a proposta |
|---|---|
| Ninguém percebe até a tarefa genérica de inatividade, se ela estiver configurada | 1. O motor marca "em risco" (1,5 vez o intervalo dela) e avisa a dona do relacionamento.<br>2. Ela aparece no topo da lista do dia, com a novidade no tamanho dela.<br>3. O desfecho fica registrado.<br>4. Se não voltar, entra na reativação, com resultado comparado ao controle |

**J5. Reclamação de defeito**

| Hoje | Com a proposta |
|---|---|
| A regra manda para "Aguardando humano". A solução fica perdida na conversa e não se sabe se ela ficou satisfeita | 1. Abre um caso com dona e prazo de 48 h.<br>2. A solução fica registrada (troca, vale-troca de cortesia).<br>3. Retorno em 7 dias, com CSAT.<br>4. Ela fica fora das réguas de marketing até o caso fechar |

## 4.6 Comparativo geral

| Tema | Hoje | Com a proposta |
|---|---|---|
| Origem da cliente | Só anúncio CTWA | Todo contato: QR, link, trainer, evento, indicação, anúncio |
| Score | Exibido, nunca calculado | Calculado todo dia, com explicação |
| Estágio e nível | Mudam só na 1ª compra | Automáticos (nova, recorrente, VIP, em risco, inativa, perdida) |
| Cadastro | Nome, telefone e aceite | + tamanho, aniversário, atividade, preferências (ficha editável) |
| Fora do horário | Copiloto espera a manhã; SLA conta à noite | IA responde o seguro; tarefa na abertura; SLA no horário |
| Quem atende | Atribuição manual | Dona do relacionamento → rodízio → plantão |
| Avisos ao cliente | Só manuais | Transacionais automáticos (utilidade) |
| Venda parada | Expira sem aviso | Lembrete + tarefa + relatório |
| Satisfação | Não medida | CSAT ao encerrar, NPS no D+10, caso para nota baixa |
| Pós-compra | Nada | Régua de 45 dias focada na 2ª compra |
| Prioridade da vendedora | Lista de tarefas | "Minha lista de hoje", ordenada por valor e urgência |
| Falta de tamanho | Venda perdida | Avise-me + reserva automática opcional |
| Fidelidade | Rótulo VIP | Níveis com benefícios e pré-venda de drops |
| Cliente parada | Tarefa genérica | 3 faixas com abordagem própria e grupo de controle |
| Reclamação | Some na conversa | Caso com prazo, solução e retorno |
| Medição | Desempenho, campanha em 7 dias, evento | Painel do ciclo de vida, coortes, réguas, satisfação, CAC |

---

# Parte 5 — Plano de implantação

## 5.1 Fase 0: configurar o que já existe (sem código, 1 a 2 semanas)

1. **Automações:** ligar as do Anexo B.
2. **Templates:**
   - criar e aprovar os de utilidade (pagamento confirmado, pronto para retirada, Armário VIP, reserva vencendo, link de pagamento);
   - criar e aprovar os de marketing (convite de evento, novidades no tamanho, aniversário, reativação).
   Textos no Anexo C.
3. **Base de conhecimento:** publicar trocas (incluindo o arrependimento em 7 dias nas compras à distância), cuidados, medidas, pagamento e parcelamento, retirada e armário, eventos, sobre a marca e a academia parceira.
4. **Persona:** importar os históricos e aprovar.
5. **Modo dos canais:** começar em Copiloto. Passar a **Piloto** quando os rascunhos chegarem a ≥ 70% enviados sem edição (meta do Desempenho) e as avaliações passarem.
6. **Respostas rápidas:** `/endereco`, `/trocas`, `/provador`, `/pix`, `/obrigada`.
7. **PDV:** sempre cadastrar o telefone e **perguntar o aceite**. Frase sugerida: "Posso te avisar por WhatsApp quando chegarem novidades no seu tamanho?"
8. **QR com texto pronto** (depois da autorização da academia parceira), mais a automação que coloca a etiqueta de origem.
9. **Rotina** da seção 1.7, com a reunião semanal dos sócios.

**Pronto quando:**
- ≥ 80% das vendas do PDV têm telefone;
- ≥ 50% delas têm aceite;
- as etiquetas de origem aparecem nas leads novas.

## 5.2 Fases de desenvolvimento

| Fase | Duração | Entregas | Depende de | Pronto quando |
|---|---|---|---|---|
| 1. Dados do ciclo | 2 semanas | Estágios, níveis e RFM automáticos; score com explicação; ficha editável (tamanho, aniversário, preferências, aceite com evidência); links rastreados e origem (1º e último toque); horário de atendimento no roteador e no SLA; desfecho ao encerrar; painel do ciclo de vida v1 | — | Estágios corretos nos testes; painel bate com os relatórios de vendas |
| 2. Atendimento que converte | 2 semanas | Avisos transacionais; retomada de link, reserva, armário e pedido; distribuição automática; resumo e etiquetas; CSAT; "lacuna na base" na Central de sugestões | Templates de utilidade aprovados (Fase 0) | Avisos saem sozinhos e sem duplicar; relatório de vendas recuperadas |
| 3. Retenção | 3 semanas | Motor de réguas (passos, esperas, saídas, grupo de controle); régua pós-compra e da 2ª compra; Minha lista de hoje; avise-me; níveis e benefícios; pré-venda VIP; aniversário com presente | Fases 1 e 2 | Cada régua mostra resultado por passo e contra o controle |
| 4. Recuperação | 2 semanas | Reativação em 3 faixas; retomada por motivo de perda; casos de reclamação + NPS + detratoras | Fase 3 (motor de réguas) | Reativação medida contra o controle; casos com prazo e retorno |
| 5. Aquisição ampliada | 2 a 3 semanas | Indique uma amiga; portal do parceiro; check-in de evento com cadastro; públicos Meta; relatórios de CAC e coortes completos | Validação da API de públicos; contrato com a academia (trainers) | Indicações rastreadas até a compra; CAC por origem |

> **Situação da fase 5:** entregues indique uma amiga (link pessoal, vale-troca após o prazo de troca, teto mensal), check-in de evento por QR com cadastro de quem chega sem convite e os relatórios de aquisição por origem, coortes de recompra, desempenho das réguas, satisfação e motivos de perda. Seguem adiados: portal do parceiro (depende do contrato academia parceira) e públicos Meta (depende de validar a API).

**Por que essa ordem:**
- **Dados primeiro:** sem estágio, score e origem, as réguas não sabem quem incluir e o painel não mede.
- **Atendimento antes da retenção:** os avisos transacionais e a retomada geram receita logo, com pouco risco.
- **Aquisição ampliada por último:** depende de terceiros (Meta, academia parceira).

## 5.3 Mudanças técnicas previstas (para quem desenvolve)

Seguem as convenções do projeto:
- RPCs `SECURITY DEFINER` com permissão;
- RLS em todas as tabelas;
- pgTAP para cada regra;
- jobs em `pg_cron` que só chamam funções idempotentes;
- textos e limites em `core.settings`.

| Área | Banco | Worker / IA | Telas |
|---|---|---|---|
| Ciclo de vida | `crm.customer_metrics` (recência, frequência, valor 12m, intervalo médio); `private.refresh_lifecycle()` (noturno + gatilho na venda); limiares em `core.settings` (`lifecycle`); transições na linha do tempo | — | Clientes › Ciclo de vida; estágio e segmento na lista e na ficha |
| Score | `crm.score_party()` lendo `crm.lead_scoring_rules` ativa, gravando `score_breakdown` | Extração de profissão, esporte e cidade pela rota `extract` (com base legal) | "Por que este score" na ficha |
| Ficha editável e aceite | RPC `crm.update_profile`; `crm.set_consent` com evidência e versão do texto | — | Edição na ficha 360°; aniversário e tamanho no PDV |
| Origem | `mkt.tracking_links` + `mkt.attribution_touches` (previstos no plano geral); código no texto do link → toque na 1ª mensagem | Normalizador reconhece o código | Marketing › Links rastreados (QR em PNG) |
| Atendimento | `omni.conversations.outcome`; `omni.csat_responses`; `business_hours` usado no SLA; regra de distribuição em `core.settings` | Roteador respeita o horário; resumo e classificação (rotas `summarize` e `classify`) | Horário no cadastro do canal; encerrar com desfecho; CSAT; resumo na linha do tempo |
| Avisos e retomada | Novos gatilhos de automação: `ORDER_STATUS`, `RESERVATION_EXPIRING`, `PAYMENT_LINK_UNPAID`, `LOCKER_RETURNED`, `DEAL_LOST`, `BACK_IN_STOCK`, `LIFECYCLE_CHANGE` | Envio por template de utilidade | Automações com os novos gatilhos |
| Réguas | `mkt.journeys`, `mkt.journey_steps`, `mkt.journey_enrollments` (com `holdout`); reaproveitam as ações das automações | Executor de passos (fila `campaign_tasks`) | Marketing › Réguas (editor, resultado por passo) |
| Regras de contato | `private.can_contact(party, kind)` única, usada por campanhas, réguas, avisos e lista do dia; limites em `core.settings` | — | Configurações › Regras de contato |
| Lista do dia | `crm.daily_actions(member)` (prioridade = valor × urgência; teto diário) | Mensagem pronta pela rota `ops_copilot` | "Minha lista de hoje" no Início |
| Avise-me e indicação | `crm.interest_alerts`; `crm.referrals` (sobre cupons, afiliados e vale-troca) | Ferramenta da IA `register_interest` | PDV, conversa, ficha |
| Casos | `crm.cases` (dono, prazos, solução, cortesia) | — | Clientes › Casos |
| Sugestões | Novos tipos em `ai.suggestions`: `REACTIVATION`, `NBA`, `KB_GAP` | — | Central de sugestões |
| Relatórios | Funções de relatório por tema (aquisição, coortes, réguas, desfechos, satisfação, perdas) | — | Novos itens no registro de relatórios (tela + CSV) |

**Testes:**
- pgTAP para transições de estágio, limites de contato, saída de régua e grupo de controle;
- pytest no worker;
- E2E das telas novas.

## 5.4 Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Cansaço e descadastro por excesso de mensagens | Regras de contato únicas; limites conservadores; acompanhar o descadastro por envio |
| Custo de templates | Orçamento mensal com alerta; preferir a janela aberta e o contato pessoal; usar a janela gratuita do anúncio |
| Meta reclassifica utilidade como marketing | Avisos sem nenhuma oferta no texto; revisar os templates rejeitados ou reclassificados |
| Base pequena deixa os testes inconclusivos | Grupo de controle acumulado por meses; decisões por tendência, não por um disparo |
| Sobrecarga da vendedora | Teto diário na lista do dia e na prospecção; o automático cuida do transacional |
| Perfilamento e LGPD | LIA documentada, aviso de privacidade, explicação do score, revisão a pedido |
| Dependência da academia parceira (QR, trainers, dados) | Pedir autorização formal; nunca importar dados da academia; validar a cláusula sobre funcionários |
| IA errar em mensagem proativa | Proativo pessoal sai da vendedora; template aprovado; avaliações com casos de retenção |
| Benefícios que corroem a margem | Começar com benefícios não monetários; cashback só depois da análise de margem |

## 5.5 Decisões dos sócios

1. **Limiares:** VIP, VIP Black, em risco, inativa e perdida (§3.2).
2. **Benefícios por nível** e orçamento; cashback agora ou depois.
3. **Indique uma amiga:** benefício da amiga, crédito de quem indica e teto mensal.
4. **Política de mimo e desconto** em aniversário e reativação (a IA continua sem criar desconto).
5. **Atendimento:** horário, sócia de plantão e quem é a dona do relacionamento de cada VIP.
6. **Limites de contato** e horário de envio (§3.7).
7. **Orçamento mensal** de templates e de mídia.
8. **Texto do aceite** (versão 1) e do aviso de privacidade.
9. **Número VIP em coexistência** (a sócia escreve pelo próprio app, e o sistema vê o eco).
10. **Autorização da academia parceira** para QR nas áreas comuns, e regra para trainers como afiliados.
11. **Metas iniciais** do §3.8 e data da primeira recalibração.

## 5.6 Pedidos de 01/10/2026: situação

Pedidos feitos pelo Paulo durante a implantação. **Entregues na `main` em 01/10/2026**, com o que cada um virou:

1. **Cadastro de pessoas e empresas (pilar do sistema):** entregue. Nova área **Cadastros › Pessoas e Empresas**: lista com busca (nome, telefone, e-mail, CNPJ) e filtro por papel; ficha de cadastro para criar e corrigir identidade, contatos, endereços e papéis; mesclagem de duplicadas (sócio), com sugestão de possíveis duplicadas. A ficha comercial continua em Clientes, com atalho para o cadastro completo. Pendente: CPF no cadastro geral (hoje só na admissão, por ser dado sensível).
2. **CEP preenche o endereço:** entregue em todos os formulários que têm endereço (admissão, cadastro de pessoa e empresa, novo CNPJ do grupo). O CNPJ completo também preenche razão social e endereço.
3. **Vínculos entre pessoas:** entregue. Mãe/filha, casados, companheira(o), irmãs, avós, netas, tias/sobrinhas e amigas, vistos dos dois lados. Réguas novas (desligadas): aniversário de parente, Dia das Mães, Dia dos Pais, Dia dos Namorados, Natal e Dia da Mulher, com `{parente}`, `{nome_parente}` e `{data_parente}` no texto e dentro das regras de contato.
4. **Escala:** entregue.
   - escala semanal padrão por colaborador, aplicada em rascunho nos dias vazios dos próximos meses ao salvar e todo dia de madrugada;
   - regras com liga/desliga e limites editáveis: descanso de 11 h, dias seguidos, jornada máxima, intervalo mínimo, horas semanais e cobertura dos picos; cada pico também liga e desliga;
   - turnos e horários livres respeitam o intervalo mínimo, que já vem como padrão ao criar;
   - total de horas trabalhadas ao vivo ao criar turno, lançar horário livre e na grade (dia, semana contra o contratado e mês).
5. **Admissão:** entregue. Cada vínculo explica o que significa; Intermitente, Temporário e Aprendiz são CLT (mesmos encargos); Estágio e Sócio não. **Freelancer PJ/MEI** como aba própria: prestador sem vínculo, sem folha nem encargos, que vira conta a pagar em rascunho (conta 7.2.09), com alerta de risco trabalhista a partir de 6 diárias em 90 dias.
6. **Automação venda → financeiro e RH → financeiro:** já existia; resposta ao Paulo:
   - venda: gera contas a **receber** automaticamente (cartão, Pix, boleto, com a agenda da maquininha); a comissão da vendedora entra na folha do mês (com DSR) quando o extrato é aprovado, e a de afiliada vira conta a pagar ou vale-troca; o DAS do mês e as parcelas do contrato academia parceira viram contas a pagar;
   - folha aprovada: gera conta a pagar do líquido de cada colaborador, guias de FGTS, INSS (DAE) e IRRF (DARF), benefícios e pensão, e o lançamento contábil por centro de custo; o rateio acontece na baixa (ADR 0002).

---

# Anexos

## A. Glossário

| Termo | Significado |
|---|---|
| Janela de 24 h | Tempo após a última mensagem da cliente em que se pode responder livremente no WhatsApp ou no Instagram |
| Template | Mensagem pré-aprovada pela Meta; única forma de escrever no WhatsApp fora da janela. Categorias: **utilidade** (transacional) e **marketing** (exige aceite) |
| CTWA | Anúncio que abre conversa no WhatsApp (*click-to-WhatsApp*) |
| Aceite | Consentimento registrado, com evidência, para uma finalidade (por exemplo, marketing no WhatsApp) |
| LTV | Total comprado pela cliente |
| RFM | Recência, frequência e valor: base dos segmentos |
| Coorte | Grupo de clientes pelo mês da 1ª compra, acompanhado ao longo do tempo |
| Régua | Sequência planejada de contatos com objetivo, esperas e saídas |
| Grupo de controle | Parte do público (10%) que não recebe a régua, para medir o efeito real |
| CSAT / NPS | Satisfação com o atendimento (1 a 5) / chance de indicar a marca (0 a 10) |
| CAC | Custo para adquirir uma nova cliente (gasto ÷ novas clientes) |
| Próxima melhor ação | O contato mais valioso a fazer agora com cada cliente |

## B. Automações recomendadas para a Fase 0 (com o que já existe)

Configurar em **Atendimento › Automações**. Regras de preenchimento:
- etiquetas: minúsculas, números, `_` ou `-`, de 2 a 30 caracteres;
- `{nome}` vira o primeiro nome da cliente;
- automação que **responde** impede a IA de responder a mesma mensagem. Para só marcar a origem, use apenas a etiqueta.

| # | Nome | Gatilho | Condição | Ações | Intervalo por pessoa |
|---|---|---|---|---|---|
| 1 | Origem: QR recepção | Palavra na mensagem | "qr da recepcao" | Etiqueta `origem-qr-recepcao` | 365 dias |
| 2 | Origem: QR vestiário | Palavra na mensagem | "qr do vestiario" | Etiqueta `origem-qr-vestiario` | 365 dias |
| 3 | Origem: bio do Instagram | Palavra na mensagem | "link da bio" | Etiqueta `origem-bio` | 365 dias |
| 4 | Horário e endereço | Palavra na mensagem | horario, endereco, onde fica, que horas abre | Responder com horário, endereço na academia parceira e link do mapa | 1 dia |
| 5 | Lead de anúncio | Chegou por anúncio no WhatsApp | — | Etiqueta `origem-anuncio` + tarefa "Acompanhar lead do anúncio: {nome}" (prazo 24 h) | 30 dias |
| 6 | Obrigada pela menção | Menção em story | — | Responder "Obrigada por marcar a {loja}, {nome}! ✨" + etiqueta `embaixadora` | 7 dias |
| 7 | Interesse no post | Comentário no Instagram | quero, preco, valor, tamanho | Resposta privada "Oi, {nome}! Vi seu comentário ✨ Qual tamanho você usa? Te passo os detalhes por aqui." + etiqueta `interesse-post` | 0 (uma por comentário) |
| 8 | Troca | Palavra na mensagem | troca, trocar, devolucao, devolver | Chamar uma pessoa + etiqueta `troca` | 1 dia |
| 9 | Aniversário | Aniversário | 3 dias antes | Tarefa "Aniversário de {nome} em 3 dias", com mensagem pronta (prazo 48 h) | 300 dias |
| 10 | Novidades: 45 dias | Cliente parada | 45 dias (de 45 a 75) | Tarefa "Novidade no tamanho de {nome}" + etiqueta `reativar-45` | 60 dias |
| 11 | Convite: 90 dias | Cliente parada | 90 dias (de 90 a 120) | Tarefa "Convidar {nome} para provar" + etiqueta `reativar-90` | 60 dias |
| 12 | Última tentativa: 180 dias | Cliente parada | 180 dias (de 180 a 210) | Tarefa "Última tentativa com {nome}" + etiqueta `reativar-180` | 120 dias |

> - A regra 4 responde no lugar da IA e por isso vale só enquanto a IA estiver em Copiloto. Com a IA em Piloto e a base publicada, desligue-a para a IA responder a mensagem inteira.
> - A regra 9 só alcança quem tem data de nascimento cadastrada. Hoje essa data só entra pela IA; a Fase 1 resolve.

## C. Modelos de mensagem

**Tipos:**
- **[IA]** texto da IA dentro da janela;
- **[Pessoal]** tarefa enviada por uma pessoa;
- **[Utilidade]** e **[Marketing]** templates da Meta.

Nos templates, `{{n}}` são as variáveis. Comece e termine o texto com palavras, não com variável, para facilitar a aprovação. O tom é acolhedor e elegante, com emoji moderado; nunca "barato" e nunca pressão.

| # | Uso | Tipo | Texto |
|---|---|---|---|
| 1 | Boas-vindas (QR) | [IA] | Oi! Que bom te ver por aqui ✨ Somos a {loja}, aqui dentro da academia. Me conta: qual atividade você mais pratica? Assim te mostro as peças certas. |
| 2 | Aceite (v1) | [IA] / [Pessoal] | Posso te avisar por WhatsApp quando chegarem novidades no seu tamanho e convites para os nossos eventos? Você pode sair quando quiser, é só responder SAIR. |
| 3 | `pagamento_confirmado` | [Utilidade] | Oi, {{1}}! Recebemos o pagamento do pedido {{2}}. Avisamos por aqui assim que estiver pronto. |
| 4 | `armario_vip_pronto` | [Utilidade] | Oi, {{1}}! Suas peças estão separadas no Armário VIP até {{2}}. É só passar na loja, dentro da academia. |
| 5 | `reserva_vencendo` | [Utilidade] | Oi, {{1}}! A peça que separamos para você fica reservada até {{2}}. Quer que a gente segure mais um pouco? |
| 6 | `lembrete_link_pagamento` | [Utilidade] | Oi, {{1}}! O link do pedido {{2}} vale até {{3}}: {{4}} . Se preferir, você também pode pagar na loja. |
| 7 | Caimento (D+4) | [Pessoal] | Oi, {nome}! Aqui é a {vendedora}, da {loja}. Como ficou a {peça} no treino? Se o caimento não ficou perfeito, a gente troca rapidinho. |
| 8 | `pesquisa_nps` (D+10) | [Utilidade/Marketing: decisão da Meta] | Oi, {{1}}! De 0 a 10, quanto você indicaria a nossa loja para uma amiga? Sua resposta ajuda muito a gente. |
| 9 | `indique_amiga` | [Marketing] | Oi, {{1}}! Quer presentear uma amiga? Com o seu código {{2}}, ela ganha {{3}} na primeira compra e você ganha {{4}} em vale-troca. É só compartilhar. |
| 10 | Aniversário | [Pessoal] / [Marketing] | Feliz aniversário, {nome}! 💛 Separamos um mimo para você retirar na loja até {data}. |
| 11 | Em risco (45 a 90 dias) | [Pessoal] | {nome}, chegou a nova {peça} no seu tamanho e lembrei de você. Quer que eu separe para provar? |
| 12 | `convite_evento` (90 dias) | [Marketing] | Oi, {{1}}! Vamos fazer um café na loja no dia {{2}} para apresentar o drop novo. Quer vir? Responda SIM e colocamos seu nome na lista. |
| 13 | `sentimos_sua_falta` (180 dias) | [Marketing] | Oi, {{1}}! Sentimos sua falta por aqui. Na sua próxima visita até {{2}}, tem um mimo te esperando. Quer que a gente separe algo no seu tamanho? |
| 14 | `chegou_seu_tamanho` (avise-me) | [Utilidade/Marketing: decisão da Meta] | Oi, {{1}}! Chegou {{2}} no tamanho {{3}} que você pediu. Separamos por 24 h para você. |
| 15 | `pre_venda_vip` | [Marketing] | Oi, {{1}}! O drop {{2}} chega para todo mundo no dia {{3}}. Como VIP, você pode reservar antes: responda QUERO e te mandamos as peças. |
| 16 | Retorno de reclamação | [Pessoal] | {nome}, passando para saber se ficou tudo certo com a {solução}. Se ainda faltar algo, me fala que eu resolvo. |

## D. Quem pode receber o quê

| Situação | WhatsApp, janela aberta | WhatsApp, janela fechada | Instagram | Sem aceite de marketing |
|---|---|---|---|---|
| Resposta de atendimento | Texto livre (IA ou pessoa) | Template de utilidade ligado ao pedido | Até 24 h; de 24 h a 7 dias, só pessoa (tag de agente humano) | Pode (é atendimento) |
| Aviso transacional | Texto livre | Template de utilidade | Não se aplica | Pode |
| Relacionamento pessoal | Texto livre por uma pessoa | Template (marketing exige aceite) ou contato presencial | Só se ela escreveu nas últimas 24 h (até 7 dias, pessoa) | Só presencial ou quando ela escrever |
| Campanha ou régua de marketing | Template de marketing | Template de marketing | Não pode | Não pode |
| Prospecção | — | — | Só pelo app oficial, na cadência, sem DM fria por API | Respeita a recusa no Instagram |
