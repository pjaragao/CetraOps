/**
 * Arquitetura de informação do SIÉ JOY OS 2.0: menu organizado pela tarefa do usuário.
 * Cada área exige uma permissão; o sócio (superusuário) vê tudo. Ícones = nomes do lucide-react.
 */
export interface NavItem {
  label: string;
  href: string;
  permission?: string;
  ready?: boolean; // false = tela prevista em sprint futuro (mostra aviso honesto)
}

export interface NavArea {
  key: string;
  label: string;
  href: string;
  icon: string;
  permission?: string;
  items: NavItem[];
}

export const NAV: NavArea[] = [
  { key: "inicio", label: "Início", href: "/inicio", icon: "LayoutDashboard", items: [] },
  {
    key: "atendimento", label: "Atendimento", href: "/atendimento", icon: "MessagesSquare", permission: "omni.read",
    items: [
      { label: "Caixa de entrada", href: "/atendimento", ready: true },
      { label: "Automações", href: "/atendimento/automacoes", ready: false },
      { label: "Templates", href: "/atendimento/templates", ready: false },
      { label: "Desempenho", href: "/atendimento/desempenho", ready: false },
    ],
  },
  {
    key: "vender", label: "Vender", href: "/vender/pdv", icon: "ShoppingBag", permission: "sales.read",
    items: [
      { label: "PDV", href: "/vender/pdv", permission: "sales.write", ready: true },
      { label: "Pedidos", href: "/vender/pedidos", ready: true },
      { label: "Reservas & Armário VIP", href: "/vender/reservas", ready: false },
      { label: "Trocas & devoluções", href: "/vender/trocas", ready: false },
      { label: "Caixa", href: "/vender/caixa", ready: true },
    ],
  },
  {
    key: "clientes", label: "Clientes", href: "/clientes", icon: "Users", permission: "crm.read",
    items: [
      { label: "Clientes & Leads", href: "/clientes", ready: true },
      { label: "Funis", href: "/clientes/funis", ready: false },
      { label: "Tarefas", href: "/clientes/tarefas", ready: false },
      { label: "Prospecção assistida", href: "/clientes/prospeccao", ready: false },
      { label: "Afiliados", href: "/clientes/afiliados", ready: false },
    ],
  },
  {
    key: "marketing", label: "Marketing", href: "/marketing", icon: "Megaphone", permission: "crm.read",
    items: [
      { label: "Campanhas", href: "/marketing", ready: false },
      { label: "Eventos & Drops", href: "/marketing/eventos", ready: false },
      { label: "Cupons", href: "/marketing/cupons", ready: false },
    ],
  },
  {
    key: "produtos", label: "Produtos & Estoque", href: "/produtos", icon: "Shirt", permission: "catalog.read",
    items: [
      { label: "Catálogo", href: "/produtos", ready: true },
      { label: "Estoque", href: "/produtos/estoque", permission: "inv.read", ready: true },
      { label: "Importar catálogo", href: "/produtos/importar", permission: "catalog.write", ready: true },
      { label: "Compras & recebimento", href: "/produtos/compras", ready: false },
    ],
  },
  {
    key: "financeiro", label: "Financeiro", href: "/financeiro", icon: "Landmark", permission: "fin.read",
    items: [
      { label: "Visão geral", href: "/financeiro", ready: true },
      { label: "Contas a pagar", href: "/financeiro/pagar", ready: true },
      { label: "Contas a receber", href: "/financeiro/receber", ready: true },
      { label: "Movimentações", href: "/financeiro/movimentacoes", ready: true },
      { label: "Conciliação", href: "/financeiro/conciliacao", ready: true },
      { label: "Razão contábil", href: "/financeiro/razao", ready: true },
      { label: "DRE", href: "/financeiro/dre", ready: true },
      { label: "Fluxo de caixa", href: "/financeiro/fluxo", ready: false },
      { label: "Contratos", href: "/financeiro/contratos", ready: true },
    ],
  },
  {
    key: "fiscal", label: "Fiscal", href: "/fiscal", icon: "FileText", permission: "fiscal.read",
    items: [
      { label: "Apuração do Simples", href: "/fiscal", ready: true },
      { label: "Notas emitidas", href: "/fiscal/emitidas", ready: false },
      { label: "Notas recebidas", href: "/fiscal/recebidas", ready: false },
    ],
  },
  {
    key: "equipe", label: "Equipe", href: "/equipe", icon: "BadgeCheck", permission: "core.admin",
    items: [
      { label: "Pessoas & acessos", href: "/equipe", ready: true },
      { label: "Metas & comissões", href: "/equipe/comissoes", ready: false },
    ],
  },
  {
    key: "ia", label: "Inteligência", href: "/ia", icon: "Sparkles", permission: "ai.read",
    items: [
      { label: "Central de sugestões", href: "/ia", ready: false },
      { label: "Modelos & custos", href: "/ia/modelos", ready: true },
      { label: "Personas", href: "/ia/personas", ready: false },
    ],
  },
  {
    key: "configuracoes", label: "Configurações", href: "/configuracoes", icon: "Settings", permission: "core.admin",
    items: [
      { label: "Empresas & lojas", href: "/configuracoes", ready: true },
      { label: "Contas bancárias", href: "/configuracoes/contas-bancarias", ready: true },
      { label: "Plano de contas", href: "/configuracoes/plano-de-contas", ready: true },
      { label: "Modelos de rateio", href: "/configuracoes/rateios", ready: true },
      { label: "Formas de pagamento & taxas", href: "/configuracoes/taxas", ready: true },
      { label: "Integrações", href: "/configuracoes/integracoes", ready: false },
    ],
  },
];

/** Filtra o menu pelas permissões do usuário (superusuário vê tudo). */
export function visibleNav(perms: ReadonlySet<string>, isSuperuser: boolean): NavArea[] {
  const can = (p?: string) => !p || isSuperuser || perms.has(p);
  return NAV.filter((a) => can(a.permission)).map((a) => ({ ...a, items: a.items.filter((i) => can(i.permission)) }));
}
