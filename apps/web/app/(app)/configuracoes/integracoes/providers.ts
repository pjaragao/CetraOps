/** Catálogo dos provedores configuráveis na tela. Campos "secret" vão para o Vault (nunca voltam); "config" é não sensível e fica visível. */
export type ProviderKey = "META_WA" | "META_IG" | "TELEGRAM" | "SEFAZ" | "FOCUS_NFE" | "BRASIL_NFE" | "NOTAAS" | "STONE" | "META_CAPI" | "META_ADS";

export interface ProviderField {
  key: string;
  label: string;
  hint?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  /** "file": o arquivo é lido no navegador e enviado em base64 (ex.: certificado A1) */
  type?: "file";
  accept?: string;
  placeholder?: string;
}

export type IntegrationCategory = "MESSAGING" | "FISCAL" | "PAYMENTS" | "MARKETING";

export interface ProviderDef {
  label: string;
  category: IntegrationCategory;
  capability: string;
  description: string;
  secret: ProviderField[];
  config: ProviderField[];
  help: string;
  requirements?: string;
}

export const CATEGORIES: Record<IntegrationCategory | "ALL", { label: string }> = {
  ALL: { label: "Todas" },
  MESSAGING: { label: "Mensagens & Canais" },
  FISCAL: { label: "Fiscal & NF-e" },
  PAYMENTS: { label: "Pagamentos & POS" },
  MARKETING: { label: "Marketing & Anúncios" },
};

export const PROVIDERS: Record<ProviderKey, ProviderDef> = {
  META_WA: {
    label: "WhatsApp (Cloud API)", category: "MESSAGING", capability: "MESSAGING",
    description: "Número oficial da loja. Recebe e envia mensagens, mídias e templates com suporte a IA e atendimento humano.",
    requirements: "Gerenciador de Negócios da Meta, Conta do WhatsApp Business (WABA) e token permanente do System User.",
    secret: [{ key: "token", label: "Token de acesso permanente", hint: "Usuário do sistema (System User) no Gerenciador de Negócios, com permissão whatsapp_business_messaging", required: true }],
    config: [
      { key: "phone_number_id", label: "ID do número de telefone", hint: "Painel da Meta › WhatsApp › Configuração da API (não é o número em si)", required: true },
      { key: "waba_id", label: "ID da conta do WhatsApp Business (WABA)" },
    ],
    help: "Depois de salvar, cadastre o canal abaixo usando o ID do número de telefone e aponte o webhook da Meta para o endereço informado no fim da página.",
  },
  META_IG: {
    label: "Instagram (mensagens)", category: "MESSAGING", capability: "MESSAGING",
    description: "Direct do @ da marca (API do Instagram com Login do Instagram). Respostas automatizadas e transbordo para a equipe.",
    requirements: "Conta profissional do Instagram vinculada a uma Página do Facebook com permissões de mensagens.",
    secret: [{ key: "access_token", label: "Token de acesso do Instagram", required: true }],
    config: [],
    help: "O identificador do canal é o ID da conta profissional do Instagram (aparece aqui depois do teste). Exige App Review com acesso avançado.",
  },
  TELEGRAM: {
    label: "Telegram (bot)", category: "MESSAGING", capability: "MESSAGING",
    description: "Bot para clientes que chegam pelo QR code da loja ou link direto. Atendimento e triagem automática.",
    requirements: "Bot criado no @BotFather no Telegram com token de API HTTP.",
    secret: [{ key: "token", label: "Token do bot (BotFather)", required: true }],
    config: [],
    help: "Depois do teste, use “Registrar webhook”: o sistema aponta o bot para a Edge Function com o segredo configurado.",
  },
  SEFAZ: {
    label: "SEFAZ direta (certificado A1)", category: "FISCAL", capability: "FISCAL",
    description: "Emite a NFC-e e busca as notas recebidas direto nos webservices da SEFAZ, sem API paga. As APIs conectadas abaixo viram reserva.",
    requirements: "Certificado digital e-CNPJ A1 (.pfx) da empresa, Inscrição Estadual ativa e credenciamento para NFC-e na SEF/SC. Hoje: emitente de SC no Simples Nacional.",
    secret: [
      { key: "certificate_pfx", label: "Certificado digital A1 (.pfx / .p12)", type: "file", accept: ".pfx,.p12,application/x-pkcs12", required: true,
        hint: "O arquivo fica guardado cifrado no cofre e só o worker o lê para assinar e conectar na SEFAZ" },
      { key: "certificate_password", label: "Senha do certificado", required: true },
      { key: "csc_token", label: "CSC – código (opcional)", hint: "Só para o QR Code versão 2. Em branco, o sistema usa a versão 3 (NT 2025.001), que dispensa o CSC" },
    ],
    config: [
      { key: "environment", label: "Ambiente", options: [{ value: "homologacao", label: "Homologação (testes, sem valor fiscal)" }, { value: "producao", label: "Produção" }] },
      { key: "uf", label: "UF do emitente", options: [{ value: "SC", label: "SC — autorização pela SVRS" }] },
      { key: "ie", label: "Inscrição Estadual (opcional)", hint: "Em branco: usa a IE do cadastro da empresa (Configurações › Empresas & lojas)" },
      { key: "cmun", label: "Código IBGE do município (opcional)", hint: "Em branco: usa o do cadastro da empresa. Florianópolis: 4205407", placeholder: "4205407" },
      { key: "nfce_series", label: "Série da NFC-e", hint: "Use uma série só deste sistema (diferente da usada na Notaas ou em outro emissor), para os números nunca colidirem", placeholder: "2", required: true },
      { key: "nfce_last_number", label: "Último número já emitido nesta série", hint: "0 se a série é nova. O sistema continua do número seguinte", placeholder: "0" },
      { key: "csc_id", label: "CSC – identificador (opcional)", hint: "Ex.: 000001. Junto com o código, ativa o QR Code versão 2" },
      { key: "phone", label: "Telefone da loja (opcional)", hint: "Sai no endereço do emitente" },
      { key: "resp_cnpj", label: "Responsável técnico – CNPJ", hint: "Quem mantém o sistema emissor; pode ser a própria empresa. Em branco: CNPJ da empresa" },
      { key: "resp_contato", label: "Responsável técnico – contato" },
      { key: "resp_email", label: "Responsável técnico – e-mail" },
      { key: "resp_fone", label: "Responsável técnico – telefone" },
      { key: "trib_federal_pct", label: "Tributos aproximados – federal (%)", hint: "Lei 12.741/2012: % da tabela do IBPT para os seus produtos (ou o informado pelo contador). Ex.: 13,45. Em branco: a nota sai sem a informação" },
      { key: "trib_estadual_pct", label: "Tributos aproximados – estadual (%)", hint: "Ex.: 17,00" },
      { key: "trib_municipal_pct", label: "Tributos aproximados – municipal (%)", hint: "Para venda de mercadoria normalmente 0" },
      { key: "trib_fonte", label: "Fonte dos tributos", hint: "Sai no DANFE. Ex.: IBPT 26.2.A", placeholder: "IBPT" },
    ],
    help: "Comece em Homologação: o teste confere o certificado, a senha, o CNPJ e o serviço da SEFAZ. Depois de algumas NFC-e de teste autorizadas, troque para Produção. Se a SEFAZ estiver fora do ar, a nota sai pela API conectada (Notaas, Focus NFe ou Brasil NFe), se houver.",
  },
  FOCUS_NFE: {
    label: "Focus NFe (NFC-e / NF-e)", category: "FISCAL", capability: "FISCAL",
    description: "Emite NFC-e no balcão do PDV, NF-e de remessa/devolução e consulta notas recebidas.",
    requirements: "Conta na Focus NFe com certificado digital A1 enviado no painel da Focus e CSC cadastrado para NFC-e.",
    secret: [{ key: "token", label: "Token de API", required: true }],
    config: [{ key: "environment", label: "Ambiente", options: [{ value: "homologacao", label: "Homologação (testes)" }, { value: "producao", label: "Produção" }] }, { key: "primary", label: "Provedor fiscal principal", hint: "Com mais de um provedor fiscal conectado, as notas saem pelo principal", options: [{ value: "", label: "Não" }, { value: "true", label: "Sim" }] }],
    help: "Comece por Homologação. A troca para Produção só vale depois da bateria de NFC-e de teste e da validação da matriz fiscal com o contador.",
  },
  BRASIL_NFE: {
    label: "Brasil NFe (NFC-e / NF-e / MDe)", category: "FISCAL", capability: "FISCAL",
    description: "Emissão de NFC-e/NF-e e captura automática de notas de compras via SEFAZ (MDe nacional).",
    requirements: "Conta na Brasil NFe com certificado A1 e token de empresa gerado.",
    secret: [
      { key: "token", label: "Token da Empresa", hint: "Token gerado no painel da Brasil NFe", required: true },
      { key: "user_token", label: "Token de Usuário (opcional)", hint: "UserToken caso utilize autenticação de usuário" },
    ],
    config: [
      { key: "environment", label: "Ambiente", options: [{ value: "homologacao", label: "Homologação (testes)" }, { value: "producao", label: "Produção" }] },
      { key: "uf", label: "UF da Empresa (SEFAZ)", hint: "Ex: SC, SP, RJ (usado no teste de status SEFAZ)", required: false },
      { key: "primary", label: "Provedor fiscal principal", hint: "Com mais de um provedor fiscal conectado, as notas saem pelo principal", options: [{ value: "", label: "Não" }, { value: "true", label: "Sim" }] },
    ],
    help: "Comece em Homologação para testes. Ao migrar para Produção, certifique-se de que o certificado A1 e o CSC estão configurados no painel da Brasil NFe.",
  },
  NOTAAS: {
    label: "Notaas (NFC-e / NF-e)", category: "FISCAL", capability: "FISCAL",
    description: "API de emissão fiscal para desenvolvedores (NFC-e modelo 65 e NF-e modelo 55) com webhooks em tempo real.",
    requirements: "Conta na Notaas (notaas.com.br) com API Key (ntaas_...) e empresa configurada com certificado A1.",
    secret: [
      { key: "api_key", label: "Chave de API (API Key)", hint: "Chave iniciada com ntaas_ gerada no painel da Notaas", required: true },
    ],
    config: [
      { key: "environment", label: "Ambiente", options: [{ value: "homologacao", label: "Homologação (testes)" }, { value: "producao", label: "Produção" }] },
      { key: "api_base", label: "URL da API", hint: "Obrigatória em homologação (endereço de testes da Notaas); em produção, vazio usa o endereço oficial", required: false },
      { key: "default_model", label: "Modelo padrão", hint: "65 para NFC-e (balcão/consumidor) ou 55 para NF-e", options: [{ value: "65", label: "NFC-e (modelo 65)" }, { value: "55", label: "NF-e (modelo 55)" }] },
      { key: "primary", label: "Provedor fiscal principal", hint: "Com mais de um provedor fiscal conectado, as notas saem pelo principal", options: [{ value: "", label: "Não" }, { value: "true", label: "Sim" }] },
    ],
    help: "Cadastre a API Key da Notaas. Em homologação informe a URL de testes: sem ela nenhuma nota é emitida. A busca de notas recebidas (MDe) não existe na Notaas: use a SEFAZ direta, o Focus NFe ou a Brasil NFe para isso. Com a SEFAZ direta conectada, a Notaas vira reserva: use nela uma série diferente.",
  },
  STONE: {
    label: "Stone (Maquininha Smart POS)", category: "PAYMENTS", capability: "ACQUIRER",
    description: "Envia o valor da venda direto para a tela da maquininha Stone (Connect 2.0) e confirma o pagamento na hora com NSU.",
    requirements: "Credencial da Stone (Secret Key / sk_...) e maquininhas Smart POS conectadas ao Wi-Fi ou 4G.",
    secret: [
      { key: "secret_key", label: "Chave Secreta (Secret Key)", hint: "sk_... gerada no Partner Hub ou na Dashboard Pagar.me da Stone", required: true },
    ],
    config: [
      { key: "stone_code", label: "Stonecode do Estabelecimento", hint: "Código do estabelecimento na Stone (ex: 84729104)", required: false },
      { key: "environment", label: "Ambiente", options: [{ value: "producao", label: "Produção" }, { value: "sandbox", label: "Sandbox (testes)" }] },
    ],
    help: "Cadastre suas maquininhas com nome (ex: Caixa 1, Salão, Móvel 2). No PDV, selecione a máquina desejada para cobrar diretamente no terminal.",
  },
  META_CAPI: {
    label: "Meta Conversões (CAPI)", category: "MARKETING", capability: "ADS",
    description: "Informa à Meta cada compra concluída para otimizar campanhas de tráfego pago com privacidade (ZDR).",
    requirements: "Pixel / Dataset no Gerenciador de Eventos da Meta e Token de Acesso gerado.",
    secret: [{ key: "token", label: "Token de acesso da API de Conversões", hint: "Gerenciador de Eventos › Configurações › API de Conversões › Gerar token", required: true }],
    config: [
      { key: "dataset_id", label: "ID do conjunto de dados (pixel)", hint: "Gerenciador de Eventos da Meta", required: true },
      { key: "waba_id", label: "ID da conta do WhatsApp Business (WABA)", hint: "Para vendas vindas de anúncio que abre conversa no WhatsApp" },
      { key: "test_event_code", label: "Código de evento de teste (opcional)", hint: "Enquanto estiver preenchido, os eventos aparecem só na aba Testar eventos" },
    ],
    help: "Sem esta integração as vendas continuam normais: ficam só registradas como “não enviadas”.",
  },
  META_ADS: {
    label: "Meta Anúncios (métricas)", category: "MARKETING", capability: "ADS",
    description: "Importa diário de investimento, cliques e conversões para cruzar com receita e ROAS real por produto.",
    requirements: "Conta de anúncios no Gerenciador de Anúncios e token com permissão ads_read.",
    secret: [{ key: "token", label: "Token de acesso (permissão ads_read)", hint: "Usuário do sistema no Gerenciador de Negócios, com acesso à conta de anúncios", required: true }],
    config: [{ key: "ad_account_id", label: "ID da conta de anúncios", hint: "Gerenciador de Anúncios › Configurações da conta (só números; o act_ é opcional)", required: true }],
    help: "Só leitura: o sistema nunca cria nem altera anúncios.",
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
