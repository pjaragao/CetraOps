/** Catálogo dos provedores configuráveis na tela. Campos "secret" vão para o Vault (nunca voltam); "config" é não sensível e fica visível. */
export type ProviderKey = "META_WA" | "META_IG" | "TELEGRAM" | "FOCUS_NFE" | "META_CAPI" | "META_ADS";

export interface ProviderField {
  key: string;
  label: string;
  hint?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
}

export interface ProviderDef {
  label: string;
  capability: string;
  description: string;
  secret: ProviderField[];
  config: ProviderField[];
  help: string;
}

export const PROVIDERS: Record<ProviderKey, ProviderDef> = {
  META_WA: {
    label: "WhatsApp (Cloud API)", capability: "MESSAGING",
    description: "Número oficial da loja. Recebe e envia mensagens, mídias e templates.",
    secret: [{ key: "token", label: "Token de acesso permanente", hint: "Usuário do sistema (System User) no Gerenciador de Negócios, com permissão whatsapp_business_messaging", required: true }],
    config: [
      { key: "phone_number_id", label: "ID do número de telefone", hint: "Painel da Meta › WhatsApp › Configuração da API (não é o número em si)", required: true },
      { key: "waba_id", label: "ID da conta do WhatsApp Business (WABA)" },
    ],
    help: "Depois de salvar, cadastre o canal abaixo usando o ID do número de telefone e aponte o webhook da Meta para o endereço informado no fim da página.",
  },
  META_IG: {
    label: "Instagram (mensagens)", capability: "MESSAGING",
    description: "Direct do @ da marca (API do Instagram com Login do Instagram). Respostas até 24 h; entre 24 h e 7 dias só por pessoa.",
    secret: [{ key: "access_token", label: "Token de acesso do Instagram", required: true }],
    config: [],
    help: "O identificador do canal é o ID da conta profissional do Instagram (aparece aqui depois do teste). Exige App Review com acesso avançado.",
  },
  TELEGRAM: {
    label: "Telegram (bot)", capability: "MESSAGING",
    description: "Bot para quem chega pelo QR code da loja (/start). O bot só responde a quem iniciou a conversa.",
    secret: [{ key: "token", label: "Token do bot (BotFather)", required: true }],
    config: [],
    help: "Depois do teste, use “Registrar webhook”: o sistema aponta o bot para a Edge Function com o segredo configurado.",
  },
  META_CAPI: {
    label: "Meta Conversões (CAPI)", capability: "ADS",
    description: "Avisa a Meta de cada venda concluída para os anúncios aprenderem quem compra. Venda vinda de anúncio no WhatsApp vai sem dado pessoal; as demais só com consentimento de marketing e com telefone/e-mail criptografados (hash).",
    secret: [{ key: "token", label: "Token de acesso da API de Conversões", hint: "Gerenciador de Eventos › Configurações › API de Conversões › Gerar token", required: true }],
    config: [
      { key: "dataset_id", label: "ID do conjunto de dados (pixel)", hint: "Gerenciador de Eventos da Meta", required: true },
      { key: "waba_id", label: "ID da conta do WhatsApp Business (WABA)", hint: "Para vendas vindas de anúncio que abre conversa no WhatsApp" },
      { key: "test_event_code", label: "Código de evento de teste (opcional)", hint: "Enquanto estiver preenchido, os eventos aparecem só na aba Testar eventos" },
    ],
    help: "Sem esta integração as vendas continuam normais: ficam só registradas como “não enviadas”.",
  },
  META_ADS: {
    label: "Meta Anúncios (resultados)", capability: "ADS",
    description: "Traz todo dia o gasto, o alcance, os cliques e as conversas de cada anúncio. O CentralOps cruza com quem realmente chegou pelo anúncio e comprou, para mostrar o retorno de verdade.",
    secret: [{ key: "token", label: "Token de acesso (permissão ads_read)", hint: "Usuário do sistema no Gerenciador de Negócios, com acesso à conta de anúncios", required: true }],
    config: [{ key: "ad_account_id", label: "ID da conta de anúncios", hint: "Gerenciador de Anúncios › Configurações da conta (só números; o act_ é opcional)", required: true }],
    help: "Só leitura: o sistema nunca cria nem altera anúncios.",
  },
  FOCUS_NFE: {
    label: "Focus NFe (NFC-e / NF-e)", capability: "FISCAL",
    description: "Emite NFC-e e NF-e, cancela e consulta notas recebidas. O certificado A1 fica só no provedor.",
    secret: [{ key: "token", label: "Token de API", required: true }],
    config: [{ key: "environment", label: "Ambiente", options: [{ value: "homologacao", label: "Homologação (testes)" }, { value: "producao", label: "Produção" }] }],
    help: "Comece por Homologação. A troca para Produção só vale depois da bateria de NFC-e de teste e da validação da matriz fiscal com o contador.",
  },
};

export const PROVIDER_KEYS = Object.keys(PROVIDERS) as ProviderKey[];

export const CHANNEL_PROVIDER: Record<string, ProviderKey> = { WHATSAPP: "META_WA", INSTAGRAM: "META_IG", TELEGRAM: "TELEGRAM" };

export const STATUS_LABEL: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  ACTIVE: { label: "Funcionando", tone: "success" },
  PENDING: { label: "Aguardando teste", tone: "warning" },
  ERROR: { label: "Com erro", tone: "danger" },
  DISABLED: { label: "Desativada", tone: "neutral" },
};

export const MODE_LABEL: Record<string, string> = {
  AI_AUTOPILOT: "IA responde sozinha (piloto)",
  AI_COPILOT: "IA sugere, pessoa aprova (copiloto)",
  HUMAN: "Só pessoas",
};
