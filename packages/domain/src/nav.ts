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
      { label: "Automações", href: "/atendimento/automacoes", ready: true },
      { label: "Templates", href: "/atendimento/templates", ready: true },
      { label: "Desempenho", href: "/atendimento/desempenho", ready: true },
    ],
  },
  {
    key: "vender", label: "Vender", href: "/vender/pdv", icon: "ShoppingBag", permission: "sales.read",
    items: [
      { label: "PDV", href: "/vender/pdv", permission: "sales.write", ready: true },
      { label: "Pedidos", href: "/vender/pedidos", ready: true },
      { label: "Reservas & Armário VIP", href: "/vender/reservas", ready: true },
      { label: "Trocas & devoluções", href: "/vender/trocas", ready: true },
      { label: "Entregas", href: "/vender/entregas", ready: true },
      { label: "Caixa", href: "/vender/caixa", ready: true },
    ],
  },
  {
    key: "clientes", label: "Clientes", href: "/clientes", icon: "Users", permission: "crm.read",
    items: [
      { label: "Clientes & Leads", href: "/clientes", ready: true },
      { label: "Funis", href: "/clientes/funis", ready: true },
      { label: "Tarefas", href: "/clientes/tarefas", ready: true },
      { label: "Prospecção assistida", href: "/clientes/prospeccao", ready: true },
      { label: "Afiliados", href: "/clientes/afiliados", ready: true },
    ],
  },
  {
    key: "marketing", label: "Marketing", href: "/marketing", icon: "Megaphone", permission: "crm.read",
    items: [
      { label: "Campanhas", href: "/marketing", ready: true },
      { label: "Eventos & Drops", href: "/marketing/eventos", ready: true },
      { label: "Cupons", href: "/marketing/cupons", ready: true },
    ],
  },
  {
    key: "produtos", label: "Produtos & Estoque", href: "/produtos", icon: "Shirt", permission: "catalog.read",
    items: [
      { label: "Catálogo", href: "/produtos", ready: true },
      { label: "Estoque", href: "/produtos/estoque", permission: "inv.read", ready: true },
      { label: "Importar catálogo", href: "/produtos/importar", permission: "catalog.write", ready: true },
      { label: "Pedidos de compra", href: "/produtos/compras", permission: "purch.read", ready: true },
      { label: "Recebimento de NF-e", href: "/produtos/recebimento", permission: "purch.read", ready: true },
      { label: "Reposição", href: "/produtos/reposicao", permission: "purch.read", ready: true },
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
      { label: "Fluxo de caixa", href: "/financeiro/fluxo", ready: true },
      { label: "Contas recorrentes", href: "/financeiro/recorrentes", ready: true },
      { label: "Orçamento", href: "/financeiro/orcamento", ready: true },
      { label: "Fechamento mensal", href: "/financeiro/fechamento", ready: true },
      { label: "Contratos", href: "/financeiro/contratos", ready: true },
    ],
  },
  {
    key: "fiscal", label: "Fiscal", href: "/fiscal", icon: "FileText", permission: "fiscal.read",
    items: [
      { label: "Apuração do Simples", href: "/fiscal", ready: true },
      { label: "Obrigações", href: "/fiscal/obrigacoes", ready: true },
      { label: "eSocial", href: "/fiscal/esocial", ready: true },
      { label: "Notas emitidas", href: "/fiscal/emitidas", ready: true },
      { label: "Notas recebidas", href: "/fiscal/recebidas", ready: true },
      { label: "Exportação para o contador", href: "/fiscal/exportacao", ready: true },
    ],
  },
  {
    key: "equipe", label: "Equipe", href: "/equipe", icon: "BadgeCheck", permission: "hr.read",
    items: [
      { label: "Colaboradores", href: "/equipe", ready: true },
      { label: "Escalas", href: "/equipe/escalas", ready: true },
      { label: "Ponto e banco de horas", href: "/equipe/ponto", ready: true },
      { label: "Férias", href: "/equipe/ferias", ready: true },
      { label: "Folha de pagamento", href: "/equipe/folha", permission: "hr.payroll.read", ready: true },
      { label: "Rescisões", href: "/equipe/rescisoes", permission: "hr.payroll.read", ready: true },
      { label: "Metas & comissões", href: "/equipe/comissoes", ready: true },
      { label: "Acessos ao sistema", href: "/equipe/acessos", permission: "core.admin", ready: true },
    ],
  },
  {
    key: "ia", label: "Inteligência", href: "/ia", icon: "Sparkles", permission: "ai.read",
    items: [
      { label: "Central de sugestões", href: "/ia", ready: true },
      { label: "Modelos & custos", href: "/ia/modelos", ready: true },
      { label: "Personas", href: "/ia/personas", ready: true },
      { label: "Base de conhecimento", href: "/ia/conhecimento", ready: true },
      { label: "Avaliações da IA", href: "/ia/avaliacoes", ready: true },
    ],
  },
  {
    key: "configuracoes", label: "Configurações", href: "/configuracoes", icon: "Settings", permission: "core.admin",
    items: [
      { label: "Empresas & lojas", href: "/configuracoes", ready: true },
      { label: "Contas bancárias", href: "/configuracoes/contas-bancarias", ready: true },
      { label: "Plano de contas", href: "/configuracoes/plano-de-contas", ready: true },
      { label: "Rateios (modelos e regras)", href: "/configuracoes/rateios", ready: true },
      { label: "Formas de pagamento & taxas", href: "/configuracoes/taxas", ready: true },
      { label: "Integrações", href: "/configuracoes/integracoes", ready: true },
    ],
  },
];

/** Filtra o menu pelas permissões do usuário (superusuário vê tudo). */
export function visibleNav(perms: ReadonlySet<string>, isSuperuser: boolean): NavArea[] {
  const can = (p?: string) => !p || isSuperuser || perms.has(p);
  return NAV.filter((a) => can(a.permission)).map((a) => ({ ...a, items: a.items.filter((i) => can(i.permission)) }));
}
