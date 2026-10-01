/** Rótulos das réguas (a regra mora no banco: private.run_journeys). */
export const TRIGGERS: Record<string, { label: string; help: string }> = {
  FIRST_PURCHASE: { label: "Primeira compra", help: "Entra quem acabou de fazer a 1ª compra." },
  ANY_PURCHASE: { label: "Qualquer compra", help: "Entra a cada compra paga." },
  NO_SECOND_PURCHASE: { label: "Sem 2ª compra", help: "Comprou uma vez e não voltou depois de N dias." },
  BIRTHDAY: { label: "Aniversário", help: "N dias antes do aniversário (uma vez por ano)." },
  AT_RISK: { label: "Em risco", help: "Passou de 1,5 vez o intervalo habitual de compra dela." },
  INACTIVE: { label: "Inativa", help: "Ficou inativa (padrão: 120 dias sem comprar)." },
  LONG_INACTIVE: { label: "Inativa há muito", help: "De 180 a 365 dias sem comprar." },
  DEAL_LOST: { label: "Oportunidade perdida", help: "Oportunidade perdida por um dos motivos escolhidos, N dias depois." },
  RELATED_BIRTHDAY: { label: "Aniversário de parente", help: "N dias antes do aniversário de alguém da família cadastrada na ficha (vínculos). Use {parente}, {nome_parente} e {data_parente} no texto." },
  OCCASION: { label: "Data comemorativa", help: "N dias antes da data escolhida, uma vez por ano, para quem tem parente cadastrado (Dia das Mães, Pais, Namorados, Natal, Mulher)." },
};

export const ACTIONS: Record<string, { label: string; help: string }> = {
  TASK: { label: "Tarefa com mensagem pronta", help: "Uma pessoa envia (contato pessoal). Respeita o limite de contatos pessoais." },
  TEXT_IF_WINDOW: { label: "Texto se a janela estiver aberta", help: "Sai sozinho se ela escreveu nas últimas 24 h; senão vira tarefa." },
  MARKETING_TEMPLATE: { label: "Template de marketing", help: "Só com aceite de marketing no WhatsApp e dentro dos limites de frequência." },
};

export const EXIT_LABEL: Record<string, string> = {
  PURCHASED: "comprou", FINISHED: "terminou os passos", OPTED_OUT: "pediu para parar", OPEN_COMPLAINT: "reclamação aberta", JOURNEY_OFF: "régua desligada",
  NOT_CUSTOMER: "não é cliente", NOT_AVAILABLE: "cadastro indisponível", ACTIVE: "em andamento",
};

export const RESULT_LABEL: Record<string, string> = { TASK: "tarefas", SENT_TEXT: "textos enviados", SENT_TEMPLATE: "templates enviados", HOLDOUT: "controle (nada enviado)", SKIPPED: "pulados" };
