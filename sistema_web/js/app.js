/**
 * SIÉ Joy OS - Master Frontend Controller (Overhauled)
 * Coordena navegação de 5 Macro-Módulos, Barra Lateral Retrátil,
 * Abas Superiores Dinâmicas e Sincronização em Tempo Real.
 */

document.addEventListener("DOMContentLoaded", async () => {
  await FinancialSync.init();
  await MarketingHub.init();
  if (window.CrmGrowthHub) {
    await CrmGrowthHub.init();
  }
  if (window.ErpController) {
    await ErpController.init();
  }
  
  // State
  let currentModule = "financial";
  let currentSubTab = "financial-dre";
  let isGraceActive = true; // Negociação de 3 meses de carência ativa por padrão!
  let selectedScenarioId = "c4"; // Cenário 4 (Compra R$ 25k -> Venda R$ 60k) padrão
  let transactions = await StoneService.getTransactions();

  // Modules Definition & Navigation Map (Clean, No Parentheses in Labels)
  const MODULES = {
    financial: {
      title: "<span>📊</span> Financeiro & DRE",
      subtitle: "DRE Gerencial, Contas a Pagar/Receber, Conciliação Bancária e Previsão de Impostos",
      defaultSubTab: "financial-kpi",
      subtabs: [
        { id: "financial-kpi", label: "📊 Dashboard de KPIs" },
        { id: "financial-dre", label: "📑 DRE Gerencial" },
        { id: "financial-receivable", label: "💵 Contas a Receber" },
        { id: "financial-payable", label: "🧾 Contas a Pagar" },
        { id: "financial-reconciliation", label: "🏦 Conciliação Bancária" },
        { id: "financial-taxes", label: "🏛️ Previsão de Impostos" }
      ]
    },
    budget: {
      title: "<span>📈</span> Orçamento & Cenários",
      subtitle: "Variance Analysis (Orçado vs. Realizado), Orçamento Base, Cenários e Ponto de Equilíbrio",
      defaultSubTab: "budget-variance",
      subtabs: [
        { id: "budget-variance", label: "📊 Orçado vs. Realizado" },
        { id: "budget-base", label: "📑 Orçamento Base Anual" },
        { id: "budget-scenarios", label: "📈 Simulador de Cenários" },
        { id: "budget-breakeven", label: "⚖️ Ponto de Equilíbrio" }
      ]
    },
    growth: {
      title: "<span>🎯</span> Aquisição & Growth",
      subtitle: "CRM High-Ticket, Extração Apify/instagrapi, Meta Ads e Playbook Anti-Ban",
      defaultSubTab: "growth-crm",
      subtabs: [
        { id: "growth-crm", label: "🗂️ CRM & Funil" },
        { id: "growth-scraping", label: "🔍 Extração de Leads" },
        { id: "growth-meta", label: "📈 Meta Ads Granular" },
        { id: "growth-playbook", label: "🛡️ Playbook Anti-Ban" }
      ]
    },
    retail: {
      title: "<span>🛍️</span> Loja & Operação",
      subtitle: "Frente de Caixa, Terminal PDV Stone, Estoque e Planejamento de Compras",
      defaultSubTab: "retail-sales",
      subtabs: [
        { id: "retail-sales", label: "⚡ Frente de Caixa & Vendas" },
        { id: "retail-pos", label: "💳 Terminal PDV Stone" },
        { id: "retail-catalog", label: "📦 Catálogo & Estoque" },
        { id: "retail-purchasing", label: "🛒 Planejamento de Compras" },
        { id: "retail-drops", label: "🍸 Drops & Eventos" },
        { id: "retail-trainers", label: "🏋️ Joy Trainers VIP" }
      ]
    },
    concierge: {
      title: "<span>💬</span> Atendimento & Concierge",
      subtitle: "Dashboard em Tempo Real, Herme Agent IA, Venda Assistida WhatsApp e Armário VIP",
      defaultSubTab: "concierge-dashboard",
      subtabs: [
        { id: "concierge-dashboard", label: "📊 Atendimentos em Andamento" },
        { id: "concierge-herme", label: "🤖 Herme Agent IA" },
        { id: "concierge-whatsapp", label: "💬 WhatsApp Concierge" },
        { id: "concierge-locker", label: "🎀 Armário VIP" },
        { id: "concierge-insights", label: "💡 Insights de Varejo" }
      ]
    },
    hr: {
      title: "<span>👥</span> Gestão de Equipe, RH & Pró-Labore",
      subtitle: "Colaboradores, Escala de Turnos 6h, Comissões Balcão/WA, Férias CLT, Folha e Pró-Labore",
      defaultSubTab: "hr-employees",
      subtabs: [
        { id: "hr-employees", label: "👩‍💼 Colaboradores & Escala" },
        { id: "hr-commissions", label: "💰 Comissões & Metas" },
        { id: "hr-vacation", label: "🏖️ Gestão de Férias CLT" },
        { id: "hr-payroll", label: "💵 Folha & Encargos Sociais" },
        { id: "hr-prolabore", label: "👔 Pró-Labore dos Sócios" }
      ]
    },
    cadastros: {
      title: "<span>📇</span> Central de Cadastros Gerais",
      subtitle: "Pessoas Físicas e Jurídicas, Fornecedores Homologados, Lojas (1:N) e CNPJs do Grupo",
      defaultSubTab: "cadastros-pessoas",
      subtabs: [
        { id: "cadastros-pessoas", label: "👤 Pessoas (PF / PJ)" },
        { id: "cadastros-fornecedores", label: "🚚 Fornecedores" },
        { id: "cadastros-lojas", label: "🏬 Lojas & Unidades" },
        { id: "cadastros-cnpjs", label: "🏢 CNPJs do Grupo" }
      ]
    },
    settings: {
      title: "<span>⚙️</span> Central de Configurações",
      subtitle: "Dashboard de Sincronizações, Plano de Contas, Centros de Custo e Regras Stone",
      defaultSubTab: "settings-sync-dashboard",
      subtabs: [
        { id: "settings-sync-dashboard", label: "📡 Sincronizações" },
        { id: "settings-chart-accounts", label: "📑 Plano de Contas" },
        { id: "settings-cost-centers", label: "🏢 Centros de Custo" },
        { id: "settings-rules", label: "⚡ Regras de Liquidação" },
        { id: "settings-integrations", label: "🔌 Credenciais APIs" },
        { id: "settings-qualification", label: "⚙️ Regras de Qualificação" },
        { id: "settings-store", label: "🏛️ Parâmetros da Loja" }
      ]
    }
  };

  // DOM Elements
  const appSidebar = document.getElementById("app-sidebar");
  const btnSidebarToggle = document.getElementById("btn-sidebar-toggle");
  const btnSidebarToggleTop = document.getElementById("btn-sidebar-toggle-top");
  const sidebarToggleIcon = document.getElementById("sidebar-toggle-icon");
  const navItems = document.querySelectorAll(".nav-item[data-module]");
  const moduleContainers = document.querySelectorAll(".module-container");
  const topModuleTitle = document.getElementById("top-module-title");
  const topModuleSubtitle = document.getElementById("top-module-subtitle");
  const topSubnavContainer = document.getElementById("top-subnav-container");

  const graceToggleBtn = document.getElementById("btn-toggle-grace");
  const scenarioSelect = document.getElementById("scenario-select");
  const btnSimulateSale = document.getElementById("btn-simulate-sale");
  const modalSale = document.getElementById("modal-simulate-sale");
  const btnCloseModal = document.getElementById("btn-close-modal");
  const formSimulateSale = document.getElementById("form-simulate-sale");

  // --- 1. COLLAPSIBLE SIDEBAR TOGGLE ---
  const toggleSidebar = () => {
    const isCollapsed = appSidebar.classList.toggle("collapsed");
    if (sidebarToggleIcon) {
      sidebarToggleIcon.innerText = isCollapsed ? "▶" : "◀";
    }
  };

  if (btnSidebarToggle) btnSidebarToggle.addEventListener("click", toggleSidebar);
  if (btnSidebarToggleTop) btnSidebarToggleTop.addEventListener("click", toggleSidebar);

  // --- 2. MASTER MODULE SWITCHING ---
  navItems.forEach(item => {
    item.addEventListener("click", () => {
      const moduleKey = item.getAttribute("data-module");
      switchModule(moduleKey);
    });
  });

  function switchModule(moduleKey, targetSubTab = null) {
    if (!MODULES[moduleKey]) return;
    currentModule = moduleKey;

    // Update sidebar active state
    navItems.forEach(item => {
      item.classList.toggle("active", item.getAttribute("data-module") === moduleKey);
    });

    // Update module containers
    moduleContainers.forEach(container => {
      container.classList.toggle("active", container.id === `module-${moduleKey}`);
    });

    // Update top header title & subtitle
    const modConfig = MODULES[moduleKey];
    if (topModuleTitle) topModuleTitle.innerHTML = modConfig.title;
    if (topModuleSubtitle) topModuleSubtitle.innerText = modConfig.subtitle;

    // Reset scroll to top
    window.scrollTo({ top: 0, behavior: "smooth" });

    // Build and render top subnav tabs
    renderTopSubnav(modConfig, targetSubTab || modConfig.defaultSubTab);
  }

  // --- 3. DYNAMIC TOP SUB-NAV TABS ---
  function renderTopSubnav(modConfig, activeSubTabId) {
    if (!topSubnavContainer) return;
    currentSubTab = activeSubTabId;

    const moduleBtnHtml = `
      <button class="top-subnav-module-btn" id="top-btn-active-module" title="Módulo Ativo">
        ${modConfig.title}
      </button>
      <div class="top-subnav-divider"></div>
    `;

    topSubnavContainer.innerHTML = moduleBtnHtml + modConfig.subtabs.map(tab => `
      <button class="top-subnav-btn ${tab.id === activeSubTabId ? 'active' : ''}" data-subtab="${tab.id}">
        <span>${tab.label}</span>
      </button>
    `).join("");

    const moduleBtn = document.getElementById("top-btn-active-module");
    if (moduleBtn) {
      moduleBtn.addEventListener("click", () => {
        switchSubTab(modConfig.defaultSubTab);
      });
    }

    topSubnavContainer.querySelectorAll(".top-subnav-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const subtabId = btn.getAttribute("data-subtab");
        switchSubTab(subtabId);
      });
    });

    switchSubTab(activeSubTabId);
  }

  function switchSubTab(subtabId) {
    currentSubTab = subtabId;

    // Update top subnav buttons
    topSubnavContainer.querySelectorAll(".top-subnav-btn").forEach(b => {
      b.classList.toggle("active", b.getAttribute("data-subtab") === subtabId);
    });

    // Update subpanes visibility inside current module
    const currentContainer = document.getElementById(`module-${currentModule}`);
    if (currentContainer) {
      currentContainer.querySelectorAll(".module-subpane").forEach(pane => {
        pane.classList.toggle("active", pane.id === `subpane-${subtabId}`);
      });
    }

    // Trigger renderers
    if (subtabId === "financial-kpi" || subtabId === "financial-dre" || subtabId === "financial-scenarios" || subtabId === "financial-breakeven") {
      renderDashboard();
    }
    if (subtabId === "growth-crm") {
      if (window.CrmGrowthHub) CrmGrowthHub.renderCrmView();
    }
    if (subtabId === "growth-scraping") {
      if (window.CrmGrowthHub) CrmGrowthHub.renderScrapingEngine();
    }
    if (subtabId === "growth-meta") {
      if (window.CrmGrowthHub) CrmGrowthHub.renderMetaAds();
    }
    if (subtabId === "growth-playbook") {
      if (window.CrmGrowthHub) CrmGrowthHub.renderSafePlaybook();
    }
    if (subtabId === "retail-sales") {
      renderRetailSales();
    }
    if (subtabId === "retail-pos") {
      renderStoneHub();
    }
    if (subtabId === "retail-catalog") {
      renderRetailCatalog();
    }
    if (subtabId === "retail-purchasing") {
      renderPurchasing();
    }
    if (subtabId === "retail-drops" || subtabId === "retail-trainers") {
      renderMarketing();
    }
    if (subtabId === "concierge-herme") {
      if (window.CrmGrowthHub) CrmGrowthHub.renderHermeAgent();
    }
    if (subtabId === "concierge-whatsapp") {
      renderWhatsApp();
    }
    if (subtabId === "settings-qualification") {
      if (window.CrmGrowthHub) CrmGrowthHub.renderQualificationRules();
    }

    // ERP Robust Subtab Triggers
    if (window.ErpController) {
      if (subtabId === "financial-receivable") ErpController.renderAccountsReceivable();
      else if (subtabId === "financial-payable") ErpController.renderAccountsPayable();
      else if (subtabId === "financial-reconciliation") ErpController.renderBankReconciliation();
      else if (subtabId === "financial-taxes") ErpController.renderTaxForecast();
      else if (subtabId === "budget-variance") ErpController.renderBudgetVariance();
      else if (subtabId === "budget-base") ErpController.renderBudgetBase();
      else if (subtabId === "budget-scenarios") ErpController.renderBudgetScenarios();
      else if (subtabId === "budget-breakeven") ErpController.renderBudgetBreakeven();
      else if (subtabId === "concierge-dashboard") ErpController.renderAiConciergeDashboard();
      else if (subtabId === "hr-employees") ErpController.renderHrEmployees();
      else if (subtabId === "hr-commissions") ErpController.renderHrCommissions();
      else if (subtabId === "hr-vacation") ErpController.renderHrVacation();
      else if (subtabId === "hr-payroll") ErpController.renderHrPayroll();
      else if (subtabId === "hr-prolabore") ErpController.renderHrProLabore();
      else if (subtabId === "cadastros-pessoas") ErpController.renderCentralEntities();
      else if (subtabId === "cadastros-fornecedores") ErpController.renderSuppliersRegistration();
      else if (subtabId === "cadastros-lojas") ErpController.renderStoresRegistration();
      else if (subtabId === "cadastros-cnpjs") ErpController.renderCnpjsRegistration();
      else if (subtabId === "settings-sync-dashboard") ErpController.renderSyncDashboard();
      else if (subtabId === "settings-chart-accounts") ErpController.renderChartOfAccountsOnly();
      else if (subtabId === "settings-cost-centers") ErpController.renderCostCentersOnly();
      else if (subtabId === "settings-rules") ErpController.renderSettlementRulesConfig();
    }
  }

  // --- 4. GRACE PERIOD & SCENARIOS ---
  if (graceToggleBtn) {
    graceToggleBtn.addEventListener("click", () => {
      isGraceActive = !isGraceActive;
      graceToggleBtn.classList.toggle("badge-carencia", isGraceActive);
      graceToggleBtn.innerHTML = isGraceActive
        ? `🎁 <strong>3 Meses de Carência Ativos</strong> (Aluguel R$ 0)`
        : `🏢 <strong>Operação Regular</strong> (Aluguel R$ 6.000)`;
      renderDashboard();
    });
  }

  if (scenarioSelect) {
    scenarioSelect.addEventListener("change", (e) => {
      selectedScenarioId = e.target.value;
      renderDashboard();
    });
  }

  // --- 5. RENDER DASHBOARD (FINANCEIRO & DRE COM FILTRO DE LOJA) ---
  function renderDashboard() {
    const currentStore = window.CURRENT_STORE_ID || "ALL";
    let activeTx = transactions;
    if (currentStore !== "ALL") {
      activeTx = transactions.filter(t => !t.storeId || t.storeId === currentStore);
    }
    const dreData = FinancialSync.calculateRealizedDRE(activeTx, selectedScenarioId, isGraceActive);
    if (!dreData) return;

    // Update KPIs
    const elGross = document.getElementById("kpi-gross-revenue");
    const elNet = document.getElementById("kpi-net-profit");
    const elMargin = document.getElementById("kpi-net-margin");
    const elTicket = document.getElementById("kpi-avg-ticket");

    if (elGross) elGross.innerText = StoneService.formatCurrency(dreData.grossRevenue);
    if (elNet) {
      elNet.innerText = StoneService.formatCurrency(dreData.netOperatingProfit);
      elNet.className = dreData.netOperatingProfit >= 0 ? "kpi-value td-emerald" : "kpi-value td-gold";
    }
    if (elMargin) elMargin.innerText = `${(dreData.netMarginPct * 100).toFixed(1)}%`;
    if (elTicket) elTicket.innerText = StoneService.formatCurrency(dreData.averageTicket);

    // Breakeven Thermometer
    const progressFill = document.getElementById("breakeven-progress-fill");
    const progressLabel = document.getElementById("breakeven-percent-label");
    const breakevenTargetVal = document.getElementById("breakeven-target-val");
    const breakevenRemainingVal = document.getElementById("breakeven-remaining-val");

    if (progressFill && progressLabel && breakevenTargetVal && breakevenRemainingVal) {
      const pct = dreData.breakevenProgressPct;
      progressFill.style.width = `${Math.min(pct, 100)}%`;
      progressLabel.innerText = `${pct}% Concluído`;
      breakevenTargetVal.innerText = StoneService.formatCurrency(dreData.targetBreakeven);

      const remaining = Math.max(dreData.targetBreakeven - dreData.grossRevenue, 0);
      breakevenRemainingVal.innerText = remaining === 0 ? "META ATINGIDA! 🚀" : `Falta ${StoneService.formatCurrency(remaining)}`;
    }

    // Render DRE Table
    const tbodyDRE = document.getElementById("dre-table-body");
    if (tbodyDRE) {
      const sc = dreData.scenario;
      tbodyDRE.innerHTML = `
        <tr>
          <td><strong>(+) Receita Bruta de Vendas (Stone)</strong></td>
          <td class="td-currency td-strong">${StoneService.formatCurrency(dreData.grossRevenue)}</td>
          <td class="td-currency">${StoneService.formatCurrency(sc.monthlyRevenueTarget)}</td>
          <td class="td-emerald">${((dreData.grossRevenue / sc.monthlyRevenueTarget) * 100).toFixed(1)}%</td>
        </tr>
        <tr>
          <td>(-) Custo Mercadoria Vendida (CMV 41,67%)</td>
          <td class="td-currency">-${StoneService.formatCurrency(dreData.totalItemsCost)}</td>
          <td class="td-currency">-${StoneService.formatCurrency(sc.monthlyPurchasesTarget)}</td>
          <td>${(0.4167 * 100).toFixed(1)}%</td>
        </tr>
        <tr>
          <td>(-) Simples Nacional (${(sc.simplesRate * 100).toFixed(1)}%)</td>
          <td class="td-currency">-${StoneService.formatCurrency(dreData.simplesTaxAmount)}</td>
          <td class="td-currency">-${StoneService.formatCurrency(sc.monthlyRevenueTarget * sc.simplesRate)}</td>
          <td>${(sc.simplesRate * 100).toFixed(1)}%</td>
        </tr>
        <tr>
          <td>(-) Taxas Stone/SIPAG (D+1 Médio: 3,18%)</td>
          <td class="td-currency">-${StoneService.formatCurrency(dreData.stoneFeesTotal)}</td>
          <td class="td-currency">-${StoneService.formatCurrency(sc.monthlyRevenueTarget * 0.0318)}</td>
          <td>${((dreData.stoneFeesTotal / (dreData.grossRevenue || 1)) * 100).toFixed(2)}%</td>
        </tr>
        <tr>
          <td>(-) Comissão Vendedora + Encargos (2,31% ef.)</td>
          <td class="td-currency">-${StoneService.formatCurrency(dreData.salespersonCommission + dreData.commissionLaborCharges)}</td>
          <td class="td-currency">-${StoneService.formatCurrency(sc.monthlyRevenueTarget * 0.0231)}</td>
          <td>2,31%</td>
        </tr>
        <tr>
          <td>(-) Embalagens de Luxo & Avarias (1,50%)</td>
          <td class="td-currency">-${StoneService.formatCurrency(dreData.packagingAndLosses)}</td>
          <td class="td-currency">-${StoneService.formatCurrency(sc.monthlyRevenueTarget * 0.015)}</td>
          <td>1,50%</td>
        </tr>
        <tr style="background: rgba(255,255,255,0.03);">
          <td><strong>(=) MARGEM DE CONTRIBUIÇÃO LÍQUIDA</strong></td>
          <td class="td-currency td-emerald">${StoneService.formatCurrency(dreData.contributionMargin)}</td>
          <td class="td-currency">${StoneService.formatCurrency(sc.monthlyRevenueTarget * 0.4584)}</td>
          <td class="td-emerald">${(dreData.contributionMarginPct * 100).toFixed(1)}%</td>
        </tr>
        <tr>
          <td>(-) Custos Fixos Regulares ${isGraceActive ? "<span class='badge-pill' style='background:rgba(212,175,55,0.2);color:#F6E05E;'>CARÊNCIA R$ 0</span>" : "(Aluguel R$ 6k)"}</td>
          <td class="td-currency">-${StoneService.formatCurrency(dreData.fixedCostsRegular)}</td>
          <td class="td-currency">-${StoneService.formatCurrency(FinancialSync.targets.monthlyFixedCostsRegular)}</td>
          <td>-</td>
        </tr>
        <tr>
          <td>(-) Provisão Mensal Eventos / Drops (R$ 4k/60d)</td>
          <td class="td-currency">-${StoneService.formatCurrency(dreData.eventProvision)}</td>
          <td class="td-currency">-${StoneService.formatCurrency(FinancialSync.targets.eventProvisionMonthly)}</td>
          <td>-</td>
        </tr>
        <tr style="background: rgba(16, 185, 129, 0.08); border-top: 2px solid var(--emerald-primary);">
          <td><strong style="color:var(--emerald-light);font-size:0.95rem;">(=) RESULTADO OPERACIONAL LÍQUIDO</strong></td>
          <td class="td-currency td-emerald" style="font-size:1.05rem;">${StoneService.formatCurrency(dreData.netOperatingProfit)}</td>
          <td class="td-currency" style="font-size:1.05rem;">${StoneService.formatCurrency(sc.netProfitMonthly)}</td>
          <td class="td-emerald">${(dreData.netMarginPct * 100).toFixed(1)}%</td>
        </tr>
      `;
    }

    // Live Feed
    const feedContainer = document.getElementById("stone-live-feed");
    if (feedContainer) {
      feedContainer.innerHTML = transactions.slice(0, 5).map(tx => `
        <div class="feed-item">
          <div class="feed-avatar">⚡</div>
          <div class="feed-details">
            <strong>${tx.customer?.name || "Aluna JOY"}</strong>
            <span>${tx.items[0]?.name || "Look SIÉ Wear"} • ${tx.paymentMethod}</span>
          </div>
          <div class="feed-amount">${StoneService.formatCurrency(tx.grossAmount)}</div>
        </div>
      `).join("");
    }
  }

  // --- 6. RENDER STONE HUB (LOJA & OPERAÇÃO) ---
  function renderStoneHub() {
    const tableBody = document.getElementById("stone-all-transactions");
    if (tableBody) {
      tableBody.innerHTML = transactions.map(tx => `
        <tr>
          <td><strong style="color:var(--gold-light);">${tx.id}</strong></td>
          <td>${new Date(tx.timestamp).toLocaleString("pt-BR")}</td>
          <td><strong>${tx.customer?.name || "Aluna JOY"}</strong></td>
          <td>${tx.device}</td>
          <td><span class="lead-tag">${tx.paymentMethod} (${tx.installments}x)</span></td>
          <td style="text-align:right;"><strong>${StoneService.formatCurrency(tx.grossAmount)}</strong></td>
          <td style="text-align:right;color:var(--emerald-light);">${StoneService.formatCurrency(tx.netAmount)}</td>
          <td><span class="status-badge" style="background:rgba(16,185,129,0.15);color:var(--emerald-light);">${tx.status}</span></td>
        </tr>
      `).join("");
    }
  }
  window.renderDashboard = renderDashboard;

  // --- 7. RENDER RETAIL CATALOG ---
  async function renderRetailCatalog() {
    const container = document.getElementById("retail-catalog-table-container");
    if (!container) return;
    try {
      const res = await fetch("/api/catalog");
      const catalog = await res.json();
      container.innerHTML = `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>SKU Stone</th>
                <th>Nome do Produto</th>
                <th>Categoria</th>
                <th>Cor</th>
                <th style="text-align:right;">Preço Venda</th>
                <th style="text-align:right;">Custo Unit.</th>
                <th>Grade Disponível (P / M / G / GG)</th>
                <th>Status Estoque</th>
              </tr>
            </thead>
            <tbody>
              ${catalog.map(p => {
                const total = Object.values(p.currentStock).reduce((a, b) => a + b, 0);
                const gradeStr = Object.entries(p.currentStock).map(([s, q]) => `<strong>${s}:</strong> ${q}`).join(" | ");
                return `
                  <tr>
                    <td><strong style="color:var(--gold-light);">${p.stoneSku}</strong></td>
                    <td><strong>${p.name}</strong></td>
                    <td><span class="lead-tag">${p.category}</span></td>
                    <td>${p.color}</td>
                    <td style="text-align:right;"><strong>${StoneService.formatCurrency(p.price)}</strong></td>
                    <td style="text-align:right;color:var(--text-muted);">${StoneService.formatCurrency(p.cost)}</td>
                    <td>${gradeStr}</td>
                    <td>
                      <span class="status-badge" style="background:${total > 10 ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)'};color:${total > 10 ? 'var(--emerald-light)' : 'var(--gold-light)'};">
                        ${total} un. em loja
                      </span>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;
    } catch (e) {
      console.error("Erro ao carregar catálogo:", e);
    }
  }

  // --- 8. RENDER PURCHASING (COMPRAS & GIRO) ---
  async function renderPurchasing() {
    const res = await PurchasingAI.getRecommendations();
    if (!res) return;

    const totalEl = document.getElementById("purchasing-total-cost");
    if (totalEl) totalEl.innerText = StoneService.formatCurrency(res.totalBudgetNeeded);

    const tbody = document.getElementById("purchasing-items-table");
    if (tbody) {
      tbody.innerHTML = res.recommendations.map(r => `
        <tr>
          <td>
            <strong>${r.name}</strong>
            <div style="font-size:0.7rem;color:var(--text-muted);">${r.stoneSku} • ${r.color}</div>
          </td>
          <td><span class="lead-tag highlight">Curva ${r.abcClass}</span></td>
          <td style="text-align:right;">${r.totalStock} un.</td>
          <td>${r.salesVelocityWeekly} un/sem</td>
          <td><strong style="color:${r.urgency === 'ALTA' ? 'var(--rose-alert)' : 'var(--text-primary)'};">${r.daysStockRemaining} dias</strong></td>
          <td>P:${r.bySize.P} | M:${r.bySize.M} | G:${r.bySize.G}</td>
          <td style="text-align:right;"><strong>${r.suggestedOrderQty} un.</strong></td>
          <td style="text-align:right;color:var(--gold-light);"><strong>${StoneService.formatCurrency(r.orderCostTotal)}</strong></td>
        </tr>
      `).join("");
    }
  }

  // --- 9. RENDER MARKETING (DROPS & AFILIADOS) ---
  function renderMarketing() {
    const dropsContainer = document.getElementById("marketing-drops-container");
    if (dropsContainer && MarketingHub.drops) {
      dropsContainer.innerHTML = MarketingHub.drops.map(d => `
        <div class="drop-card">
          <div class="drop-badge">Mês ${d.month} • ${d.date}</div>
          <h5 style="color:#FFF;margin-bottom:6px;font-size:1rem;">${d.theme}</h5>
          <p style="color:var(--text-secondary);font-size:0.8rem;margin-bottom:10px;">${d.concept}</p>
          <div style="font-size:0.75rem;color:var(--gold-light);font-weight:600;">Orçamento: R$ 4.000,00 • Meta: R$ 15.000,00</div>
        </div>
      `).join("");
    }

    const trainersTbody = document.getElementById("trainers-table-body");
    if (trainersTbody && MarketingHub.trainers) {
      trainersTbody.innerHTML = MarketingHub.trainers.map(t => `
        <tr>
          <td><strong>${t.name}</strong></td>
          <td><span class="lead-tag">${t.discipline}</span></td>
          <td><strong style="color:var(--gold-light);">${t.coupon}</strong></td>
          <td style="text-align:right;">${StoneService.formatCurrency(t.salesGenerated)}</td>
          <td>${t.studentsReferred} alunas</td>
          <td style="text-align:right;color:var(--emerald-light);"><strong>${StoneService.formatCurrency(t.creditsEarned)}</strong></td>
        </tr>
      `).join("");
    }
  }

  // --- 10. RENDER WHATSAPP CONCIERGE ---
  function renderWhatsApp() {
    const chatArea = document.getElementById("wa-chat-area");
    if (chatArea) {
      chatArea.innerHTML = WhatsAppBot.chatHistory.map(msg => `
        <div class="wa-bubble ${msg.sender === 'user' ? 'user' : 'bot'}">
          ${msg.text}
          <span class="wa-time">${msg.time}</span>
        </div>
      `).join("");
      chatArea.scrollTop = chatArea.scrollHeight;
    }

    const chipsArea = document.getElementById("wa-chips-area");
    const lastMsg = WhatsAppBot.chatHistory[WhatsAppBot.chatHistory.length - 1];
    if (chipsArea && lastMsg && lastMsg.suggestions) {
      chipsArea.innerHTML = lastMsg.suggestions.map(s => `
        <button class="btn-wa-chip" data-chip="${s}">${s}</button>
      `).join("");

      chipsArea.querySelectorAll(".btn-wa-chip").forEach(btn => {
        btn.addEventListener("click", async () => {
          const chipText = btn.getAttribute("data-chip");
          await WhatsAppBot.sendMessage(chipText);
          renderWhatsApp();
        });
      });
    }
  }

  const btnWaSend = document.getElementById("btn-wa-send");
  const inputWaText = document.getElementById("wa-input-text");
  if (btnWaSend && inputWaText) {
    const sendMsg = async () => {
      const val = inputWaText.value.trim();
      if (!val) return;
      inputWaText.value = "";
      await WhatsAppBot.sendMessage(val);
      renderWhatsApp();
    };
    btnWaSend.addEventListener("click", sendMsg);
    inputWaText.addEventListener("keypress", (e) => {
      if (e.key === "Enter") sendMsg();
    });
  }

  // --- 11. MODAL SIMULATE SALE (STONE) ---
  if (btnSimulateSale && modalSale) {
    btnSimulateSale.addEventListener("click", () => {
      modalSale.classList.add("active");
    });
  }

  if (btnCloseModal && modalSale) {
    btnCloseModal.addEventListener("click", () => {
      modalSale.classList.remove("active");
    });
  }

  if (formSimulateSale) {
    formSimulateSale.addEventListener("submit", async (e) => {
      e.preventDefault();
      const customerName = document.getElementById("sim-customer-name").value;
      const amount = parseFloat(document.getElementById("sim-amount").value);
      const method = document.getElementById("sim-method").value;
      const channel = document.getElementById("sim-channel").value;

      const saleData = {
        customer: { name: customerName, joyPlan: "Membro JOY Club" },
        grossAmount: amount,
        paymentMethod: method,
        channel: channel,
        salesPerson: "Vendedora Titular"
      };

      const result = await StoneService.simulateWebhookSale(saleData);
      if (result.success) {
        modalSale.classList.remove("active");
        transactions = await StoneService.getTransactions();
        renderDashboard();
        alert(`Transação Stone de R$ ${amount.toFixed(2)} recebida e processada com sucesso!`);
      }
    });
  }

  // --- 10B. RENDER RETAIL SALES (FRENTE DE CAIXA & VENDAS) ---
  function renderRetailSales() {
    const tableBody = document.getElementById("pos-today-sales-table");
    if (tableBody) {
      tableBody.innerHTML = transactions.slice(0, 10).map(tx => {
        const timeStr = new Date(tx.timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        return `
          <tr>
            <td><strong style="color:var(--text-muted);">${timeStr}</strong></td>
            <td><strong>${tx.customer?.name || "Aluna JOY"}</strong></td>
            <td><span class="lead-tag">${tx.device || "Balcão P2"}</span></td>
            <td><span class="lead-tag highlight">${tx.paymentMethod}</span></td>
            <td style="text-align:right;"><strong>${StoneService.formatCurrency(tx.grossAmount)}</strong></td>
            <td style="text-align:right;color:var(--emerald-light);">${StoneService.formatCurrency(tx.netAmount)}</td>
          </tr>
        `;
      }).join("");
    }

    // Dynamic fee / CMV / net calculation
    const inputAmount = document.getElementById("pos-sale-amount");
    const selectMethod = document.getElementById("pos-sale-method");
    const selectProduct = document.getElementById("pos-sale-product");
    const feeDisplay = document.getElementById("pos-sale-fee-display");
    const cmvDisplay = document.getElementById("pos-sale-cmv-display");
    const netDisplay = document.getElementById("pos-sale-net-display");

    const updateCalculations = () => {
      const amount = parseFloat(inputAmount?.value) || 0;
      const method = selectMethod?.value || "CREDIT_CARD";
      let feeRate = 0.0318;
      if (method === "PIX") feeRate = 0.0;
      if (method === "DEBIT") feeRate = 0.0089;

      const fee = amount * feeRate;
      const cmv = amount * 0.4167;
      const net = amount - fee;

      if (feeDisplay) feeDisplay.innerText = `- ${StoneService.formatCurrency(fee)} (${(feeRate * 100).toFixed(2)}%)`;
      if (cmvDisplay) cmvDisplay.innerText = `- ${StoneService.formatCurrency(cmv)}`;
      if (netDisplay) netDisplay.innerText = StoneService.formatCurrency(net);
    };

    if (selectProduct) {
      selectProduct.addEventListener("change", (e) => {
        if (inputAmount) inputAmount.value = e.target.value;
        updateCalculations();
      });
    }

    if (inputAmount) inputAmount.addEventListener("input", updateCalculations);
    if (selectMethod) selectMethod.addEventListener("change", updateCalculations);
    updateCalculations();

    // Direct POS sale form submit
    const formPosSale = document.getElementById("form-pos-direct-sale");
    if (formPosSale && !formPosSale.dataset.wired) {
      formPosSale.dataset.wired = "true";
      formPosSale.addEventListener("submit", async (e) => {
        e.preventDefault();
        const customerName = document.getElementById("pos-sale-customer")?.value || "Aluna JOY";
        const amount = parseFloat(document.getElementById("pos-sale-amount")?.value) || 0;
        const method = document.getElementById("pos-sale-method")?.value || "CREDIT_CARD";
        const channel = document.getElementById("pos-sale-channel")?.value || "POS_BALCAO";
        const prodOption = selectProduct?.options[selectProduct.selectedIndex];
        const prodName = prodOption?.getAttribute("data-name") || "Peça SIÉ Wear";

        const saleData = {
          customer: { name: customerName, joyPlan: "Membro JOY Club" },
          grossAmount: amount,
          paymentMethod: method,
          channel: channel,
          salesPerson: "Vendedora Titular",
          items: [{ name: prodName, qty: 1, unitPrice: amount }]
        };

        const result = await StoneService.simulateWebhookSale(saleData);
        if (result.success) {
          transactions = await StoneService.getTransactions();
          renderRetailSales();
          renderDashboard();
          alert(`⚡ Venda de ${StoneService.formatCurrency(amount)} (${customerName}) registrada com sucesso na Stone! NFC-e emitida.`);
          const customerInput = document.getElementById("pos-sale-customer");
          if (customerInput) customerInput.value = "";
        }
      });
    }
  }

  // --- INITIALIZE MASTER VIEW ---
  switchModule("financial", "financial-kpi");
});
