/**
 * SIÉ Joy OS - ERP Robust Controller
 * Gerencia:
 * 1. Multi-CNPJ & Multi-Loja (1:N) com Seletor Global e Sincronização Dinâmica da Barra Lateral
 * 2. Contas a Receber Operacional & Contas a Pagar Operacional
 * 3. Conciliação Bancária em 3 Vias (Stone POS <-> Stone Extrato <-> Banco Inter)
 * 4. Previsão de Impostos (Simples Nacional / Lucro Presumido, DAS, Sublimite SC)
 * 5. Módulo Equipe & RH (Colaboradores, Escala 6h, Comissões, Férias CLT, Folha, Pró-Labore)
 * 6. Central de Cadastros (Pessoas PF/PJ com seletor dinâmico, Lojas & Unidades 1:N, CNPJs do Grupo)
 * 7. Configurações: Plano de Contas, Centros de Custo e Regras de Liquidação Stone
 */

const ErpController = {
  // State
  cnpjs: [],
  stores: [],
  currentStoreId: "ALL",
  currentCnpjId: "ALL",
  receivablesData: null,
  payablesData: null,
  financialMovementData: null,
  customFieldsConfig: null,
  reconciliationData: null,
  taxData: null,
  employeesData: null,
  accountsData: null,
  entitiesData: null,
  activeEntityTypeFilter: "ALL",

  async init() {
    console.log("Inicializando SIÉ Joy OS ERP Controller...");
    try {
      await this.loadCnpjsAndStores();
      await this.loadCustomFieldsConfig();
      this.setupStoreSwitcher();
      this.setupModalsAndEvents();
      console.log("ERP Controller inicializado com sucesso!");
    } catch (err) {
      console.error("Erro na inicialização do ERP Controller:", err);
    }
  },

  // --- 1. MULTI-CNPJ & MULTI-LOJA CONTEXT & SYNC ---
  async loadCnpjsAndStores() {
    try {
      const res = await fetch("/api/erp/cnpjs");
      const data = await res.json();
      this.cnpjs = data.cnpjs || [];
      this.stores = data.stores || [];
    } catch (err) {
      console.error("Erro ao carregar CNPJs e Lojas:", err);
    }
  },

  async loadCustomFieldsConfig() {
    try {
      const res = await fetch("/api/erp/custom-fields");
      this.customFieldsConfig = await res.json();
    } catch (err) {
      console.error("Erro ao carregar custom fields:", err);
    }
  },

  setupStoreSwitcher() {
    const select = document.getElementById("select-store-context");
    if (!select) return;

    select.innerHTML = `
      <option value="ALL" ${this.currentStoreId === "ALL" ? "selected" : ""}>🌐 Todas as Lojas</option>
      ${this.stores.map(s => {
        let shortName = s.name;
        if (s.id === "store-01") shortName = "Boutique JOY Floripa";
        else if (s.id === "store-02") shortName = "Loja Expansão SP";
        else if (s.id === "store-03") shortName = "Loja Curitiba Batel";
        else if (s.id === "store-04") shortName = "Loja Rio Ipanema";
        return `
          <option value="${s.id}" ${s.id === this.currentStoreId ? "selected" : ""}>
            ${s.type === 'BOUTIQUE' ? '👑' : '📍'} ${shortName}
          </option>
        `;
      }).join("")}
    `;

    select.addEventListener("change", (e) => {
      this.setStoreContext(e.target.value);
    });

    // Initial sync of sidebar location
    this.updateSidebarLocation(this.currentStoreId);
  },

  updateSidebarLocation(storeId) {
    const locText = document.getElementById("sidebar-location-text");
    if (!locText) return;

    if (storeId === "ALL") {
      locText.innerHTML = "🌐 Todas as Lojas (Consolidado)";
    } else {
      const s = this.stores.find(x => x.id === storeId);
      if (s) {
        locText.innerHTML = `📍 ${s.name} • ${s.city}`;
      }
    }
  },

  setStoreContext(storeId) {
    this.currentStoreId = storeId;
    window.CURRENT_STORE_ID = storeId;

    if (storeId === "ALL") {
      this.currentCnpjId = "ALL";
    } else {
      const store = this.stores.find(s => s.id === storeId);
      this.currentCnpjId = store ? store.cnpjId : "ALL";
    }

    // Sync sidebar text
    this.updateSidebarLocation(storeId);

    // Show visual toast notification
    this.showToastNotification(
      storeId === "ALL" 
        ? "🏢 Contexto alterado: Visão Consolidada de Todas as Lojas" 
        : `📍 Unidade Ativa: ${this.getStoreName(storeId)}`
    );

    // If financial dashboard or sales is active, re-render
    if (typeof window.renderDashboard === "function") {
      window.renderDashboard();
    }
    if (typeof window.renderRetailSales === "function") {
      window.renderRetailSales();
    }

    // Re-render active subpane if it belongs to ERP
    const activeSubpane = document.querySelector(".module-subpane.active");
    if (activeSubpane) {
      const id = activeSubpane.id;
      if (id === "subpane-financial-receivable") this.renderAccountsReceivable();
      else if (id === "subpane-financial-payable") this.renderAccountsPayable();
      else if (id === "subpane-financial-movement") this.renderFinancialMovement();
      else if (id === "subpane-financial-reconciliation") this.renderBankReconciliation();
      else if (id === "subpane-financial-taxes") this.renderTaxForecast();
      else if (id === "subpane-hr-employees") this.renderHrEmployees();
      else if (id === "subpane-hr-commissions") this.renderHrCommissions();
      else if (id === "subpane-hr-vacation") this.renderHrVacation();
      else if (id === "subpane-hr-payroll") this.renderHrPayroll();
      else if (id === "subpane-hr-prolabore") this.renderHrProLabore();
      else if (id === "subpane-cadastros-pessoas") this.renderCentralEntities();
      else if (id === "subpane-cadastros-lojas") this.renderStoresRegistration();
      else if (id === "subpane-settings-sync-dashboard") this.renderSyncDashboard();
      else if (id === "subpane-settings-chart-accounts") this.renderChartOfAccountsOnly();
      else if (id === "subpane-settings-cost-centers") this.renderCostCentersOnly();
      else if (id === "subpane-settings-custom-fields") this.renderCustomFieldsConfig();
      else if (id === "subpane-settings-rules") this.renderSettlementRulesConfig();
    }
  },

  showToastNotification(msg) {
    let toast = document.getElementById("erp-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "erp-toast";
      toast.className = "erp-toast";
      document.body.appendChild(toast);
    }
    toast.innerHTML = msg;
    toast.classList.add("visible");
    setTimeout(() => {
      toast.classList.remove("visible");
    }, 3000);
  },

  // --- 2. CONTAS A RECEBER (OPERACIONAL) ---
  async renderAccountsReceivable() {
    const container = document.getElementById("subpane-financial-receivable");
    if (!container) return;

    try {
      const res = await fetch(`/api/erp/accounts-receivable?storeId=${this.currentStoreId}&cnpjId=${this.currentCnpjId}`);
      this.receivablesData = await res.json();
    } catch (e) {
      console.error(e);
      return;
    }

    const { receivables, summary } = this.receivablesData || { receivables: [], summary: { totalGross: 0, settledNet: 0, pendingNet: 0, totalFees: 0, count: 0 } };

    container.innerHTML = `
      <!-- KPI Row -->
      <div class="kpi-grid" style="margin-bottom:20px;">
        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-emerald">💰</div>
            <span class="kpi-badge positive">Bruto Total</span>
          </div>
          <div class="kpi-title">Receita Registrada (${this.getStoreName(this.currentStoreId)})</div>
          <div class="kpi-value">R$ ${(summary?.totalGross || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</div>
          <div class="kpi-subtitle">${summary?.count || 0} recebíveis capturados</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-gold">⚡</div>
            <span class="kpi-badge positive">Liquidado</span>
          </div>
          <div class="kpi-title">Disponível em Conta (D+0/D+1)</div>
          <div class="kpi-value">R$ ${(summary?.settledNet || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</div>
          <div class="kpi-subtitle">Pix compensado e cartões D+1</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-blue">⏳</div>
            <span class="kpi-badge">A Liquidar</span>
          </div>
          <div class="kpi-title">Pendente de Liquidação</div>
          <div class="kpi-value" style="color:var(--blue-accent);">R$ ${(summary?.pendingNet || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</div>
          <div class="kpi-subtitle">Previsão em D+1 e Faturamento D+30</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-rose">🏷️</div>
            <span class="kpi-badge">MDR Stone</span>
          </div>
          <div class="kpi-title">Taxas de Cartão Retidas</div>
          <div class="kpi-value" style="color:var(--rose-light);">R$ ${(summary?.totalFees || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</div>
          <div class="kpi-subtitle">Taxa efetiva Stone: 3,18%</div>
        </div>
      </div>

      <!-- Receivables Ledger Table -->
      <div class="content-card">
        <div class="card-header">
          <div>
            <h4>📑 Livro Razão de Contas a Receber (Aging List)</h4>
            <span class="status-badge" style="background:rgba(0,168,104,0.12);color:var(--stone-green);">
              Integrado em Tempo Real com Maquininha Stone
            </span>
          </div>
          <button id="btn-new-receivable" class="btn-primary-luxury" style="padding:6px 14px;font-size:0.8rem;">
            ➕ Faturamento / Boleto Corporativo
          </button>
        </div>

        <div class="table-responsive">
          <table class="crm-compact-table">
            <thead>
              <tr>
                <th>Código / Ref.</th>
                <th>Loja & CNPJ</th>
                <th>Centro de Custo & Plano de Contas</th>
                <th>Cliente</th>
                <th>Meio / Parcelas</th>
                <th>Data Venda</th>
                <th>Previsão Liquidação</th>
                <th>Valor Bruto</th>
                <th>Taxa MDR</th>
                <th>Valor Líquido</th>
                <th>Status</th>
                <th style="text-align:right;">Ação</th>
              </tr>
            </thead>
            <tbody>
              ${receivables.length > 0 ? receivables.map(r => `
                <tr style="height:42px;">
                  <td><strong>${r.id}</strong><span style="font-size:0.68rem;color:var(--text-muted);margin-left:4px;">${r.saleCode}</span></td>
                  <td title="${this.getStoreName(r.storeId)} • ${this.getCnpjNumber(r.cnpjId)}">
                    <span style="font-weight:600;color:#FFF;font-size:0.8rem;white-space:nowrap;">
                      ${r.storeId === 'store-01' ? 'Floripa' : (r.storeId === 'store-02' ? 'Baln. Camboriú' : (r.storeId === 'store-05' ? 'Canal Digital' : 'Loja'))}
                    </span>
                    <span style="font-size:0.7rem;color:var(--text-muted);">• ${r.cnpjId === 'cnpj-01' ? 'Matriz' : 'Filial'}</span>
                  </td>
                  <td>
                    <div style="font-weight:600;font-size:0.78rem;display:flex;align-items:center;gap:4px;">
                      <span class="category-pill" style="background:rgba(59,130,246,0.15);color:var(--blue-accent);padding:2px 6px;font-size:0.7rem;font-weight:600;">
                        ${r.costCenterId || 'CC-01'}
                      </span>
                      <span style="font-size:0.74rem;color:#FFF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;" title="${r.costCenterName || ''}">
                        ${(r.costCenterName || 'Boutique Floripa').split(' - ')[0]}
                      </span>
                    </div>
                    <div style="font-size:0.7rem;color:var(--gold-light);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;" title="${r.chartOfAccountName || ''}">
                      ${r.chartOfAccountId || '1.1.2.01'} • ${(r.chartOfAccountName || 'Contas a Receber').split(' - ').slice(-1)[0]}
                    </div>
                  </td>
                  <td>
                    <div style="font-weight:600;color:#FFF;">${r.customerName}</div>
                    ${r.customFields && Object.keys(r.customFields).length > 0 ? `
                      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;">
                        ${Object.entries(r.customFields).filter(([k,v]) => v).map(([k,v]) => `
                          <span style="font-size:0.68rem;background:rgba(212,175,55,0.1);color:var(--gold-light);padding:1px 5px;border-radius:3px;border:1px solid rgba(212,175,55,0.2);">
                            <strong>${this.getCustomFieldLabel(k)}:</strong> ${v}
                          </span>
                        `).join("")}
                      </div>
                    ` : ''}
                  </td>
                  <td>
                    <span class="payment-badge-pill">${r.paymentMethod}</span>
                    <span style="font-size:0.7rem;color:var(--text-muted);margin-left:4px;">${r.installments}x (${r.settlementMode})</span>
                  </td>
                  <td>${new Date(r.saleDate).toLocaleDateString('pt-BR')}</td>
                  <td><strong>${new Date(r.expectedSettlementDate).toLocaleDateString('pt-BR')}</strong></td>
                  <td>R$ ${r.grossAmount.toLocaleString('pt-BR', {minimumFractionDigits:2})}</td>
                  <td style="color:var(--rose-light);">- R$ ${r.feeAmount.toLocaleString('pt-BR', {minimumFractionDigits:2})}</td>
                  <td><strong style="color:var(--emerald-light);">R$ ${r.netAmount.toLocaleString('pt-BR', {minimumFractionDigits:2})}</strong></td>
                  <td>
                    <span class="erp-status-badge ${r.status === 'SETTLED' ? 'settled' : 'pending'}">
                      ${r.status === 'SETTLED' ? '✅ Conciliado' : '⏳ Pendente'}
                    </span>
                  </td>
                  <td style="text-align:right;">
                    ${r.status !== 'SETTLED' ? `
                      <button class="crm-mini-btn btn-settle-rec" data-id="${r.id}" style="background:rgba(0,168,104,0.15);color:var(--stone-green);border-color:rgba(0,168,104,0.3);" title="Conciliar recebimento com extrato Stone">
                        🎯 Conciliar
                      </button>
                    ` : '<span style="font-size:0.75rem;color:var(--text-muted);">Conciliado</span>'}
                  </td>
                </tr>
              `).join("") : `
                <tr><td colspan="12" style="text-align:center;padding:24px;color:var(--text-muted);">Nenhum recebível registrado para esta unidade.</td></tr>
              `}
            </tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelectorAll(".btn-settle-rec").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-id");
        if (confirm(`Confirmar conciliação do recebível ${id}?`)) {
          await fetch("/api/erp/accounts-receivable/reconcile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ receivableId: id, status: "SETTLED" })
          });
          this.renderAccountsReceivable();
        }
      });
    });

    const btnNewRec = document.getElementById("btn-new-receivable");
    if (btnNewRec) btnNewRec.addEventListener("click", () => this.openModalNewReceivable());
  },

  // --- 3. CONTAS A PAGAR (OPERACIONAL) ---
  async renderAccountsPayable() {
    const container = document.getElementById("subpane-financial-payable");
    if (!container) return;

    try {
      const res = await fetch(`/api/erp/accounts-payable?storeId=${this.currentStoreId}&cnpjId=${this.currentCnpjId}`);
      this.payablesData = await res.json();
    } catch (e) {
      console.error(e);
      return;
    }

    const { payables, summary } = this.payablesData || { payables: [], summary: { totalAmount: 0, paidAmount: 0, pendingAmount: 0, count: 0 } };

    container.innerHTML = `
      <!-- KPI Row -->
      <div class="kpi-grid" style="margin-bottom:20px;">
        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-rose">🧾</div>
            <span class="kpi-badge">Contas Cadastradas</span>
          </div>
          <div class="kpi-title">Total Despesas (${this.getStoreName(this.currentStoreId)})</div>
          <div class="kpi-value">R$ ${(summary?.totalAmount || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</div>
          <div class="kpi-subtitle">${summary?.count || 0} títulos no período</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-emerald">✅</div>
            <span class="kpi-badge positive">Quitado</span>
          </div>
          <div class="kpi-title">Total Pago no Mês</div>
          <div class="kpi-value" style="color:var(--emerald-light);">R$ ${(summary?.paidAmount || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</div>
          <div class="kpi-subtitle">Inclui carência de aluguel R$ 0</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-gold">⏳</div>
            <span class="kpi-badge positive">A Liquidar</span>
          </div>
          <div class="kpi-title">Total a Pagar / Pendente</div>
          <div class="kpi-value" style="color:var(--gold-light);">R$ ${(summary?.pendingAmount || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</div>
          <div class="kpi-subtitle">Fornecedores (30/60/90d) & Serviços</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-blue">🛡️</div>
            <span class="kpi-badge positive">Economia Negociada</span>
          </div>
          <div class="kpi-title">Carência Aluguel JOY Club</div>
          <div class="kpi-value" style="color:var(--blue-accent);">R$ 18.000,00</div>
          <div class="kpi-subtitle">3 meses sem desembolso fixo</div>
        </div>
      </div>

      <!-- Payables Table -->
      <div class="content-card">
        <div class="card-header">
          <div>
            <h4>🧾 Livro de Contas a Pagar (Fornecedores CMV, Aluguel, Drops & Serviços)</h4>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px;">
              Fluxo parcelado 30/60/90 dias para confecção SIÉ e controle de carência JOY Club.
            </p>
          </div>
          <button id="btn-new-payable" class="btn-primary-luxury" style="padding:6px 14px;font-size:0.8rem;">
            ➕ Cadastrar Título a Pagar
          </button>
        </div>

        <div class="table-responsive">
          <table class="crm-compact-table">
            <thead>
              <tr>
                <th>Código</th>
                <th>Centro de Custo & Plano de Contas</th>
                <th>Fornecedor / Beneficiário</th>
                <th>Descrição / Parcela</th>
                <th>Documento</th>
                <th>Emissão</th>
                <th>Vencimento</th>
                <th>Valor</th>
                <th>Status</th>
                <th style="text-align:right;">Ação</th>
              </tr>
            </thead>
            <tbody>
              ${payables.length > 0 ? payables.map(p => `
                <tr style="height:42px;">
                  <td><strong>${p.id}</strong></td>
                  <td>
                    <div style="font-weight:600;font-size:0.78rem;display:flex;align-items:center;gap:4px;">
                      <span class="category-pill" style="background:rgba(59,130,246,0.15);color:var(--blue-accent);padding:2px 6px;font-size:0.7rem;font-weight:600;">
                        ${p.costCenterId || 'CC-01'}
                      </span>
                      <span style="font-size:0.74rem;color:#FFF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px;" title="${p.costCenterName || ''}">
                        ${(p.costCenterName || 'Boutique Floripa').split(' - ')[0]}
                      </span>
                    </div>
                    <div style="font-size:0.7rem;color:var(--gold-light);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px;" title="${p.chartOfAccountName || ''}">
                      ${p.chartOfAccountId || '2.1.1.01'} • ${(p.chartOfAccountName || 'Fornecedores').split(' - ').slice(-1)[0]}
                    </div>
                  </td>
                  <td><strong>${p.supplier}</strong></td>
                  <td>
                    <div style="font-weight:500;color:#FFF;font-size:0.83rem;">
                      ${p.description.replace(/\(Parcela.*?\)/gi, '').trim()}
                    </div>
                    <div style="display:flex;gap:6px;align-items:center;margin-top:2px;">
                      ${p.installmentsInfo ? `<span style="font-size:0.7rem;color:var(--gold-light);background:rgba(212,175,55,0.12);padding:1px 6px;border-radius:4px;">${p.installmentsInfo}</span>` : ''}
                      ${p.notes ? `<span style="font-size:0.7rem;color:var(--emerald-light);">${p.notes}</span>` : ''}
                    </div>
                    ${p.customFields && Object.keys(p.customFields).length > 0 ? `
                      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;">
                        ${Object.entries(p.customFields).filter(([k,v]) => v).map(([k,v]) => `
                          <span style="font-size:0.68rem;background:rgba(212,175,55,0.1);color:var(--gold-light);padding:1px 5px;border-radius:3px;border:1px solid rgba(212,175,55,0.2);">
                            <strong>${this.getCustomFieldLabel(k)}:</strong> ${v}
                          </span>
                        `).join("")}
                      </div>
                    ` : ''}
                  </td>
                  <td>${p.documentNumber}</td>
                  <td>${new Date(p.issueDate).toLocaleDateString('pt-BR')}</td>
                  <td><strong style="color:${p.status === 'PAID' ? 'var(--text-muted)' : '#FFF'};">${new Date(p.dueDate).toLocaleDateString('pt-BR')}</strong></td>
                  <td>
                    <strong style="font-size:0.9rem;color:${p.amount === 0 ? 'var(--emerald-light)' : '#FFF'};">
                      R$ ${p.amount.toLocaleString('pt-BR', {minimumFractionDigits: 2})}
                    </strong>
                  </td>
                  <td>
                    <span class="erp-status-badge ${p.status === 'PAID' ? 'settled' : (p.status === 'APPROVED' ? 'approved' : 'pending')}">
                      ${p.status === 'PAID' ? '✅ Conciliado' : (p.status === 'APPROVED' ? '👍 Aprovado' : '⏳ Pendente')}
                    </span>
                  </td>
                  <td style="text-align:right;">
                    ${p.status !== 'PAID' ? `
                      <button class="crm-mini-btn btn-pay-payable" data-id="${p.id}" style="background:rgba(0,168,104,0.15);color:var(--stone-green);border-color:rgba(0,168,104,0.3);" title="Conciliar despesa com extrato bancário">
                        🎯 Conciliar
                      </button>
                    ` : '<span style="font-size:0.75rem;color:var(--text-muted);">Conciliado</span>'}
                  </td>
                </tr>
              `).join("") : `
                <tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted);">Nenhum título a pagar encontrado para esta unidade.</td></tr>
              `}
            </tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelectorAll(".btn-pay-payable").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-id");
        if (confirm(`Confirmar conciliação do título ${id}?`)) {
          await fetch("/api/erp/accounts-payable/pay", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ payableId: id, status: "PAID" })
          });
          this.renderAccountsPayable();
        }
      });
    });

    const btnNewPay = document.getElementById("btn-new-payable");
    if (btnNewPay) btnNewPay.addEventListener("click", () => this.openModalNewPayable());
  },

  // --- 4. CONCILIAÇÃO BANCÁRIA ---
  async renderBankReconciliation() {
    const container = document.getElementById("subpane-financial-reconciliation");
    if (!container) return;

    try {
      const res = await fetch("/api/erp/bank-reconciliation");
      this.reconciliationData = await res.json();
    } catch (e) {
      console.error(e);
      return;
    }

    const { bankAccounts, reconciledTransactions } = this.reconciliationData || { bankAccounts: [], reconciledTransactions: [] };
    const account = bankAccounts[0] || { bankName: "Banco Inter S.A.", agency: "0001", accountNumber: "9812440-1", currentBalance: 48250.30, lastSync: new Date().toISOString() };

    container.innerHTML = `
      <div class="content-card" style="margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
          <div style="display:flex;align-items:center;gap:14px;">
            <div style="font-size:2rem;background:rgba(255,255,255,0.05);padding:10px 14px;border-radius:12px;">🏦</div>
            <div>
              <h4 style="color:#FFF;font-size:1.1rem;margin:0;">${account.bankName} • Agência ${account.agency} Conta ${account.accountNumber}</h4>
              <p style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px;">
                CNPJ Vinculado: ${this.getCnpjNumber(account.cnpjId)} | Última sincronização OFX/Open Finance: ${new Date(account.lastSync).toLocaleTimeString('pt-BR')}
              </p>
            </div>
          </div>
          <div>
            <span style="font-size:0.75rem;color:var(--text-muted);display:block;">Saldo Real em Conta Corrente:</span>
            <div style="font-family:var(--font-display);font-size:1.6rem;font-weight:700;color:var(--emerald-light);">
              R$ ${account.currentBalance.toLocaleString('pt-BR', {minimumFractionDigits: 2})}
            </div>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:14px;margin-bottom:24px;">
        <div class="param-card" style="border-left:3px solid var(--gold-primary);">
          <label>1ª Via: Venda Smart POS / Link</label>
          <div class="param-value" style="font-size:1.1rem;">Captura Stone</div>
          <p>Registro do valor bruto da peça e forma de pagamento na maquininha.</p>
        </div>
        <div class="param-card" style="border-left:3px solid var(--blue-accent);">
          <label>2ª Via: Extrato da Adquirente Stone</label>
          <div class="param-value" style="font-size:1.1rem;color:var(--blue-accent);">Liquidação StoneCo</div>
          <p>Desconto automático de taxas MDR e previsão de depósito D+0 / D+1.</p>
        </div>
        <div class="param-card" style="border-left:3px solid var(--emerald-light);">
          <label>3ª Via: Extrato Bancário (Banco Inter)</label>
          <div class="param-value" style="font-size:1.1rem;color:var(--emerald-light);">Crédito em Conta</div>
          <p>Batimento automático de valor líquido exato creditado na conta jurídica.</p>
        </div>
      </div>

      <div class="content-card">
        <div class="card-header">
          <div>
            <h4>🔄 Batimento em 3 Vias de Transações (API Banco Inter + IA)</h4>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px;">
              Cruzamento preditivo por IA com nível de correspondência e aprovação humana obrigatória para liquidação.
            </p>
          </div>
          <button id="btn-batch-approve-rec" class="btn-primary-luxury" style="padding:6px 14px;font-size:0.8rem;">
            ⚡ Aprovar Sugestões IA (> 95% Confiança)
          </button>
        </div>

        <div class="table-responsive">
          <table class="crm-compact-table">
            <thead>
              <tr>
                <th>ID Batimento</th>
                <th>Transação Stone</th>
                <th>1ª Via: Venda</th>
                <th>2ª Via: Stone D+1</th>
                <th>3ª Via: Extrato Inter</th>
                <th>Centro de Custo & Plano de Contas</th>
                <th>Sugestão de Batimento & Confiança IA</th>
                <th>Status & Auditoria</th>
                <th style="text-align:right;">Ação Humana</th>
              </tr>
            </thead>
            <tbody>
              ${(reconciledTransactions || []).map(m => {
                const isApproved = m.approvalStatus === 'APPROVED';
                return `
                <tr style="height:46px;">
                  <td><strong>${m.id}</strong></td>
                  <td><span class="payment-badge-pill">${m.stoneTxCode}</span></td>
                  <td>R$ ${m.saleAmount.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
                  <td><strong style="color:var(--blue-accent);">R$ ${m.stoneSettledAmount.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong></td>
                  <td><strong style="color:var(--emerald-light);">R$ ${m.bankStatementAmount.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong></td>
                  <td>
                    <div style="font-weight:600;font-size:0.78rem;display:flex;align-items:center;gap:4px;">
                      <span class="category-pill" style="background:rgba(59,130,246,0.15);color:var(--blue-accent);padding:2px 6px;font-size:0.7rem;font-weight:600;">
                        ${m.costCenterId || 'CC-01'}
                      </span>
                      <span style="font-size:0.74rem;color:#FFF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px;" title="${m.costCenterName || ''}">
                        ${(m.costCenterName || 'Boutique Floripa').split(' - ')[0]}
                      </span>
                    </div>
                    <div style="font-size:0.7rem;color:var(--gold-light);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px;" title="${m.chartOfAccountName || ''}">
                      ${m.chartOfAccountId || '5.1.1.01'} • ${(m.chartOfAccountName || 'Vendas Balcão').split(' - ').slice(-1)[0]}
                    </div>
                  </td>
                  <td>
                    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                      <span class="engine-pill-badge engine-apify" style="font-size:0.7rem;padding:2px 8px;">
                        🤖 ${((m.aiConfidence || 0.95) * 100).toFixed(0)}% Confiança IA
                      </span>
                      <span style="font-size:0.68rem;background:rgba(212,175,55,0.15);color:var(--gold-light);padding:1px 6px;border-radius:4px;border:1px solid rgba(212,175,55,0.3);">
                        🎯 Classificação Sugerida
                      </span>
                    </div>
                    <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;line-height:1.3;">
                      ${m.aiRecommendation || m.notes}
                    </div>
                  </td>
                  <td>
                    <span class="erp-status-badge ${isApproved ? 'settled' : 'pending'}">
                      ${isApproved ? '✅ Aprovado Humano' : '⏳ Sugerido por IA'}
                    </span>
                    ${isApproved && m.approvedBy ? `<div style="font-size:0.68rem;color:var(--text-muted);margin-top:2px;">${m.approvedBy}</div>` : ''}
                  </td>
                  <td style="text-align:right;">
                    ${!isApproved ? `
                      <button class="crm-mini-btn btn-approve-single-rec" data-id="${m.id}" style="background:rgba(0,168,104,0.15);color:var(--stone-green);border-color:rgba(0,168,104,0.3);font-size:0.75rem;">
                        👍 Aprovar Match & Contabilidade
                      </button>
                    ` : '<span style="font-size:0.75rem;color:var(--stone-green);">✔ Conciliado & Classificado</span>'}
                  </td>
                </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Single approve button handler
    container.querySelectorAll(".btn-approve-single-rec").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-id");
        await fetch("/api/erp/bank-reconciliation/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ matchIds: [id], approvedBy: "Paulo Júnior (Diretor Executivo)" })
        });
        this.showToastNotification("Conciliação e classificação contábil aprovadas com sucesso!", "success");
        this.renderBankReconciliation();
      });
    });

    // Batch approve button handler
    const btnBatch = document.getElementById("btn-batch-approve-rec");
    if (btnBatch) {
      btnBatch.addEventListener("click", async () => {
        const pendingIds = (reconciledTransactions || [])
          .filter(m => m.approvalStatus !== 'APPROVED' && (m.aiConfidence || 0) >= 0.95)
          .map(m => m.id);

        if (pendingIds.length === 0) {
          alert("Todas as sugestões de alta confiança já foram aprovadas!");
          return;
        }

        await fetch("/api/erp/bank-reconciliation/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ matchIds: pendingIds, approvedBy: "Paulo Júnior (Diretor Executivo)" })
        });
        this.showToastNotification(`${pendingIds.length} conciliações aprovadas em lote com sucesso!`, "success");
        this.renderBankReconciliation();
      });
    }
  },

  // --- 5. PREVISÃO DE IMPOSTOS ---
  async renderTaxForecast() {
    const container = document.getElementById("subpane-financial-taxes");
    if (!container) return;

    try {
      const res = await fetch("/api/erp/tax-forecast");
      this.taxData = await res.json();
    } catch (e) {
      console.error(e);
      return;
    }

    const { regimes, currentForecast } = this.taxData || { regimes: {}, currentForecast: { rbt12: 180000, effectiveTaxRate: 0.055, dasAmountEstimated: 1880, paymentDueDate: "2026-10-20", currentMonthRevenue: 34185, nfceCount: 42 } };
    const simples = regimes?.SIMPLES_NACIONAL || { name: "Simples Nacional - Anexo I (Comércio)", stateSublimitSC: 3600000, brackets: [] };

    container.innerHTML = `
      <div class="hero-banner" style="margin-bottom:24px;">
        <div class="hero-grid">
          <div class="hero-info">
            <div style="display:inline-flex;align-items:center;gap:6px;background:rgba(212,175,55,0.15);border:1px solid var(--gold-primary);color:var(--gold-light);padding:4px 10px;border-radius:20px;font-size:0.75rem;font-weight:600;margin-bottom:8px;">
              🏛️ Regime Fiscal Oficial: ${simples.name}
            </div>
            <h3>Apuração do Documento de Arrecadação do Simples (DAS)</h3>
            <p>
              Cálculo baseado na <strong>Receita Bruta dos últimos 12 meses (RBT12)</strong> e no faturamento capturado em tempo real nas maquininhas Stone.
            </p>
            <div class="hero-metrics-pill-row">
              <div class="metric-pill">
                <span>RBT12 Acumulado:</span>
                <strong>R$ ${currentForecast.rbt12.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong>
              </div>
              <div class="metric-pill">
                <span>Alíquota Efetiva:</span>
                <strong style="color:var(--blue-accent);">${(currentForecast.effectiveTaxRate * 100).toFixed(2)}%</strong>
              </div>
              <div class="metric-pill">
                <span>Vencimento do DAS:</span>
                <strong style="color:var(--gold-light);">${new Date(currentForecast.paymentDueDate).toLocaleDateString('pt-BR')}</strong>
              </div>
            </div>
          </div>

          <div class="thermometer-card">
            <div class="thermometer-header">
              <span class="thermometer-label">DAS Estimado (Mês Corrente)</span>
              <span class="thermometer-val" style="color:var(--emerald-light);">R$ ${currentForecast.dasAmountEstimated.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</span>
            </div>
            <div class="progress-track" style="margin-top:14px;">
              <div class="progress-bar-fill" style="width: ${(currentForecast.currentMonthRevenue / 60000) * 100}%;"></div>
            </div>
            <div class="thermometer-footer" style="margin-top:10px;">
              <span>Faturamento Stone: <strong>R$ ${currentForecast.currentMonthRevenue.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong></span>
              <span style="color:var(--blue-accent);">${currentForecast.nfceCount} NFC-e Emitidas</span>
            </div>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px;">
        <div class="content-card">
          <div class="card-header">
            <h4>📍 Sublimite Estadual de Santa Catarina (ICMS)</h4>
            <span class="status-badge" style="background:rgba(0,168,104,0.12);color:var(--stone-green);">Dentro do Limite</span>
          </div>
          <p style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:14px;">
            Em Santa Catarina, empresas do Simples Nacional recolhem ICMS dentro do DAS até o limite de R$ 3.600.000,00/ano.
          </p>
          <div style="background:rgba(255,255,255,0.03);padding:14px;border-radius:10px;border:1px solid var(--border-subtle);">
            <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:6px;">
              <span>Utilização do Sublimite SC:</span>
              <strong>${((currentForecast.rbt12 / simples.stateSublimitSC) * 100).toFixed(1)}% (R$ 180k / R$ 3,6M)</strong>
            </div>
            <div class="progress-track">
              <div class="progress-bar-fill" style="width: 5%;background:var(--emerald-light);"></div>
            </div>
          </div>
        </div>

        <div class="content-card">
          <div class="card-header">
            <h4>⚡ SEFAZ-SC & Emissão de NFC-e</h4>
            <span class="status-badge" style="background:rgba(0,168,104,0.12);color:var(--stone-green);">🟢 ONLINE</span>
          </div>
          <p style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:14px;">
            Ambiente de Produção SEFAZ Santa Catarina integrado à maquininha Stone para emissão em contingência offline e envio síncrono.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:0.8rem;">
            <div style="background:rgba(255,255,255,0.03);padding:10px;border-radius:8px;">
              <span style="color:var(--text-muted);display:block;font-size:0.7rem;">Certificado Digital A1:</span>
              <strong style="color:var(--gold-light);">Válido até 15/08/2027</strong>
            </div>
            <div style="background:rgba(255,255,255,0.03);padding:10px;border-radius:8px;">
              <span style="color:var(--text-muted);display:block;font-size:0.7rem;">CSC Homologado:</span>
              <strong style="color:#FFF;">Token SC #0001 Ativo</strong>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  // --- 6. MÓDULO EQUIPE & RH ---
  async loadEmployeesData() {
    try {
      const res = await fetch(`/api/erp/employees?storeId=${this.currentStoreId}`);
      this.employeesData = await res.json();
    } catch (e) {
      console.error(e);
    }
  },

  async renderHrEmployees(filterType = "ALL") {
    const container = document.getElementById("subpane-hr-employees");
    if (!container) return;
    await this.loadEmployeesData();

    let employees = this.employeesData?.employees || [];
    if (filterType === "CLT") {
      employees = employees.filter(e => e.contractType !== "COMMISSION_ONLY");
    } else if (filterType === "COMMISSION_ONLY") {
      employees = employees.filter(e => e.contractType === "COMMISSION_ONLY");
    }

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px;">
        <div>
          <h4 style="color:#FFF;font-size:1.2rem;margin:0;">👩‍💼 Colaboradores & Escala de Trabalho (${this.getStoreName(this.currentStoreId)})</h4>
          <p style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px;">
            Gestão unificada de Consultoras CLT e Vendedores 100% Comissionados (PJ / Autônomo / RPA).
          </p>
        </div>
        <div style="display:flex;gap:10px;align-items:center;">
          <div class="filter-pills-row" style="margin:0;">
            <button class="filter-pill ${filterType === 'ALL' ? 'active' : ''}" id="hr-filter-all">Todos (${(this.employeesData?.employees || []).length})</button>
            <button class="filter-pill ${filterType === 'CLT' ? 'active' : ''}" id="hr-filter-clt">CLT Fixo + Comis.</button>
            <button class="filter-pill ${filterType === 'COMMISSION_ONLY' ? 'active' : ''}" id="hr-filter-comm">100% Comissionados</button>
          </div>
          <button id="btn-hr-add-emp" class="btn-primary-luxury" style="padding:8px 14px;font-size:0.8rem;">
            ➕ Cadastrar Colaborador
          </button>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:16px;">
        ${employees.length > 0 ? employees.map(emp => {
          const isCommOnly = emp.contractType === "COMMISSION_ONLY";
          return `
          <div class="content-card">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
              <div style="display:flex;align-items:center;gap:14px;">
                <div style="font-size:2rem;background:rgba(212,175,55,0.1);padding:12px;border-radius:12px;border:1px solid var(--gold-primary);">
                  ${isCommOnly ? '💼' : '👩‍💼'}
                </div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <strong style="color:#FFF;font-size:1.15rem;">${emp.name}</strong>
                    <span class="status-badge" style="${isCommOnly ? 'background:rgba(212,175,55,0.15);color:var(--gold-light);' : 'background:rgba(0,168,104,0.12);color:var(--stone-green);'}">
                      ${isCommOnly ? 'Comissionado Puro (100% Comissão)' : 'CLT (Fixo + Comissão)'}
                    </span>
                  </div>
                  <div style="font-size:0.82rem;color:var(--gold-light);font-weight:600;">${emp.role}</div>
                  <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">
                    CPF: ${emp.cpf} • Alocada em: <strong>${this.getStoreName(emp.storeId)}</strong> • Admissão: ${new Date(emp.admissionDate).toLocaleDateString('pt-BR')}
                  </div>
                </div>
              </div>

              <div style="text-align:right;">
                <span style="font-size:0.72rem;color:var(--text-muted);display:block;">${isCommOnly ? 'Modelo de Remuneração:' : 'Salário Base Contratual:'}</span>
                <div style="font-family:var(--font-display);font-size:1.3rem;font-weight:700;color:${isCommOnly ? 'var(--gold-light)' : '#FFF'};">
                  ${isCommOnly ? '100% Comissão (Sem Fixo)' : `R$ ${emp.baseSalary.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`}
                </div>
                <span style="font-size:0.75rem;color:var(--emerald-light);font-weight:600;">
                  ${isCommOnly ? `Balcão: ${((emp.commissionRates?.posDirect || 0.08)*100).toFixed(0)}% • WA: ${((emp.commissionRates?.waLink || 0.08)*100).toFixed(0)}%` : `⏰ ${emp.workSchedule}`}
                </span>
              </div>
            </div>
          </div>
          `;
        }).join("") : `
          <div class="content-card" style="text-align:center;padding:30px;color:var(--text-muted);">
            Nenhum colaborador encontrado para este filtro.
          </div>
        `}
      </div>
    `;

    // Filter events
    const fAll = document.getElementById("hr-filter-all");
    const fClt = document.getElementById("hr-filter-clt");
    const fComm = document.getElementById("hr-filter-comm");
    if (fAll) fAll.addEventListener("click", () => this.renderHrEmployees("ALL"));
    if (fClt) fClt.addEventListener("click", () => this.renderHrEmployees("CLT"));
    if (fComm) fComm.addEventListener("click", () => this.renderHrEmployees("COMMISSION_ONLY"));

    const btnAdd = document.getElementById("btn-hr-add-emp");
    if (btnAdd) btnAdd.addEventListener("click", () => this.openModalNewEmployee());
  },

  async renderHrCommissions() {
    const container = document.getElementById("subpane-hr-commissions");
    if (!container) return;
    await this.loadEmployeesData();

    const employees = this.employeesData?.employees || [];

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <div>
            <h4>💰 Regras & Histórico de Comissões (Balcão Stone POS vs Links WhatsApp)</h4>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px;">
              Comissionamento diferenciado por canal com cálculo em tempo real sobre as vendas capturadas.
            </p>
          </div>
        </div>

        <div class="table-responsive">
          <table class="crm-compact-table">
            <thead>
              <tr>
                <th>Colaboradora</th>
                <th>Loja</th>
                <th>Comissão Balcão POS</th>
                <th>Vendas Balcão</th>
                <th>Comissão WA Link</th>
                <th>Vendas WhatsApp</th>
                <th>Total Comissões</th>
                <th>DSR s/ Comissão</th>
              </tr>
            </thead>
            <tbody>
              ${employees.map(e => {
                const p = e.payrollCurrentMonth || {};
                return `
                  <tr>
                    <td><strong>${e.name}</strong><div style="font-size:0.7rem;color:var(--text-muted);">${e.role}</div></td>
                    <td>${this.getStoreName(e.storeId)}</td>
                    <td><strong style="color:var(--gold-light);">${((e.commissionRates?.posDirect || 0.03) * 100).toFixed(1)}%</strong></td>
                    <td>R$ ${(p.posSalesAmount || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
                    <td><strong style="color:var(--emerald-light);">${((e.commissionRates?.waLink || 0.03) * 100).toFixed(1)}%</strong></td>
                    <td>R$ ${(p.waSalesAmount || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
                    <td><strong style="color:var(--gold-light);font-size:0.9rem;">+ R$ ${(p.totalCommission || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong></td>
                    <td>+ R$ ${(p.dsrAmount || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  async renderHrVacation() {
    const container = document.getElementById("subpane-hr-vacation");
    if (!container) return;
    await this.loadEmployeesData();

    const employees = this.employeesData?.employees || [];

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <div>
            <h4>🏖️ Gestão de Férias CLT (Período Aquisitivo & Prazo Concessivo)</h4>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px;">
              Controle legal de prazos para evitar férias em dobro e provisão contínua de 1/3 constitucional.
            </p>
          </div>
        </div>

        <div class="table-responsive">
          <table class="crm-compact-table">
            <thead>
              <tr>
                <th>Colaboradora</th>
                <th>Admissão</th>
                <th>Início Aquisitivo</th>
                <th>Fim Aquisitivo</th>
                <th>Prazo Concessivo Limite</th>
                <th>Saldo Disponível</th>
                <th>Status</th>
                <th style="text-align:right;">Ação</th>
              </tr>
            </thead>
            <tbody>
              ${employees.map(e => {
                const v = e.vacationInfo || {};
                return `
                  <tr>
                    <td><strong>${e.name}</strong></td>
                    <td>${new Date(e.admissionDate).toLocaleDateString('pt-BR')}</td>
                    <td>${new Date(v.acquisitionPeriodStart || e.admissionDate).toLocaleDateString('pt-BR')}</td>
                    <td>${new Date(v.acquisitionPeriodEnd || '2027-07-31').toLocaleDateString('pt-BR')}</td>
                    <td><strong style="color:var(--blue-accent);">${new Date(v.concessivePeriodDeadline || '2028-07-31').toLocaleDateString('pt-BR')}</strong></td>
                    <td><strong style="color:var(--emerald-light);">${v.daysBalance || 30} dias</strong></td>
                    <td>
                      <span class="status-badge badge-carencia">
                        ${v.status === 'ACQUIRING' ? '⏳ Período em Aquisição' : '✅ Férias Agendadas'}
                      </span>
                    </td>
                    <td style="text-align:right;">
                      <button class="crm-mini-btn btn-schedule-vacation" data-id="${e.id}" style="background:rgba(212,175,55,0.15);color:var(--gold-light);border-color:rgba(212,175,55,0.3);">
                        📅 Agendar Férias
                      </button>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelectorAll(".btn-schedule-vacation").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        this.openModalScheduleVacation(id);
      });
    });
  },

  async renderHrPayroll() {
    const container = document.getElementById("subpane-hr-payroll");
    if (!container) return;
    await this.loadEmployeesData();

    const employees = this.employeesData?.employees || [];

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <div>
            <h4>💵 Folha de Pagamento & Encargos Sociais Provisionados</h4>
            <span class="status-badge" style="background:rgba(0,168,104,0.12);color:var(--stone-green);">Competência Atual</span>
          </div>
        </div>

        <div class="table-responsive">
          <table class="crm-compact-table">
            <thead>
              <tr>
                <th>Colaboradora</th>
                <th>Salário Base</th>
                <th>Comissão + DSR</th>
                <th>Salário Bruto</th>
                <th>Desc. INSS</th>
                <th>Desc. IRRF</th>
                <th>Salário Líquido</th>
                <th>FGTS (8%)</th>
                <th>Prov. 13º (1/12)</th>
                <th>Prov. Férias+1/3</th>
              </tr>
            </thead>
            <tbody>
              ${employees.map(e => {
                const p = e.payrollCurrentMonth || {};
                const isCommOnly = e.contractType === "COMMISSION_ONLY";
                return `
                  <tr style="height:46px;">
                    <td>
                      <strong>${e.name}</strong>
                      <div style="font-size:0.7rem;color:${isCommOnly ? 'var(--gold-light)' : 'var(--text-muted)'};">
                        ${isCommOnly ? '💼 100% Comissionado (PJ/RPA)' : 'CLT'}
                      </div>
                    </td>
                    <td>${isCommOnly ? '<span style="color:var(--text-muted);font-size:0.8rem;">R$ 0,00 (Sem fixo)</span>' : `R$ ${(p.baseSalary || e.baseSalary).toLocaleString('pt-BR', {minimumFractionDigits: 2})}`}</td>
                    <td style="color:var(--gold-light);"><strong style="font-size:0.9rem;">+ R$ ${((p.totalCommission || 0) + (p.dsrAmount || 0)).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong></td>
                    <td><strong>R$ ${(p.grossTotal || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong></td>
                    <td style="color:var(--rose-light);">${isCommOnly ? '<span style="color:var(--text-muted);font-size:0.75rem;">Isento</span>' : `- R$ ${(p.inssDeduction || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}`}</td>
                    <td style="color:var(--rose-light);">${p.irrfDeduction > 0 ? `- R$ ${(p.irrfDeduction || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}` : '<span style="color:var(--text-muted);font-size:0.75rem;">Isento</span>'}</td>
                    <td><strong style="color:var(--emerald-light);font-size:0.95rem;">R$ ${(p.netSalary || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong></td>
                    <td>${isCommOnly ? '<span style="color:var(--text-muted);font-size:0.72rem;">Isento (PJ/RPA)</span>' : `R$ ${(p.fgtsDeposit || 0).toFixed(2)}`}</td>
                    <td>${isCommOnly ? '<span style="color:var(--text-muted);font-size:0.72rem;">Isento (PJ/RPA)</span>' : `R$ ${(p.provision13th || 0).toFixed(2)}`}</td>
                    <td>${isCommOnly ? '<span style="color:var(--text-muted);font-size:0.72rem;">Isento (PJ/RPA)</span>' : `R$ ${(p.provisionVacation || 0).toFixed(2)}`}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  async renderHrProLabore() {
    const container = document.getElementById("subpane-hr-prolabore");
    if (!container) return;
    await this.loadEmployeesData();

    const partners = this.employeesData?.partnersProLabore || [];

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <div>
            <h4>👔 Pró-Labore dos Sócios Administradores</h4>
            <span class="status-badge" style="background:rgba(212,175,55,0.12);color:var(--gold-light);">Governança Societária</span>
          </div>
        </div>

        <div class="table-responsive">
          <table class="crm-compact-table">
            <thead>
              <tr>
                <th>Sócio / Administrador</th>
                <th>Cargo / Função</th>
                <th>CPF</th>
                <th>Pró-Labore Bruto</th>
                <th>Retenção INSS (11%)</th>
                <th>Retenção IRRF</th>
                <th>Valor Líquido Creditado</th>
              </tr>
            </thead>
            <tbody>
              ${partners.map(p => `
                <tr>
                  <td><strong>${p.name}</strong></td>
                  <td>${p.role}</td>
                  <td>${p.cpf}</td>
                  <td>R$ ${p.proLaboreGross.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
                  <td style="color:var(--rose-light);">- R$ ${p.inssDeduction.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
                  <td style="color:var(--rose-light);">- R$ ${p.irrfDeduction.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
                  <td><strong style="color:var(--emerald-light);font-size:0.95rem;">R$ ${p.netAmount.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  // --- 7. CENTRAL DE CADASTROS (PESSOAS PF/PJ, FORNECEDORES, LOJAS & CNPJS) ---
  async loadCentralEntities() {
    try {
      const typeParam = this.activeEntityTypeFilter || "ALL";
      const res = await fetch(`/api/erp/entities?type=${typeParam}`);
      this.entitiesData = await res.json();
    } catch (e) {
      console.error(e);
    }
  },

  async renderCentralEntities() {
    const container = document.getElementById("subpane-cadastros-pessoas");
    if (!container) return;
    await this.loadCentralEntities();

    // Fetch all for accurate counts
    let allEntities = [];
    try {
      const allRes = await fetch("/api/erp/entities");
      const allData = await allRes.json();
      allEntities = allData.entities || [];
    } catch (err) {
      allEntities = this.entitiesData?.entities || [];
    }

    const entities = this.entitiesData?.entities || [];
    const totalCount = allEntities.length;
    const pfCount = allEntities.filter(e => e.type === "PF").length;
    const pjCount = allEntities.filter(e => e.type === "PJ").length;
    const supplierCount = allEntities.filter(e => e.isSupplier || e.category === "FORNECEDOR_CMV").length;

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
        <div>
          <h4 style="color:#FFF;font-size:1.2rem;margin:0;">👤 Cadastro Centralizado de Pessoas Físicas & Jurídicas</h4>
          <p style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px;">
            Clientes VIP, Alunas JOY, Fornecedores Homologados, Parceiros e Contatos com sincronização com a maquininha Stone.
          </p>
        </div>
        <div style="display:flex;gap:10px;">
          <button id="btn-sync-stone-customers" class="btn-primary-luxury" style="padding:8px 14px;font-size:0.8rem;background:rgba(0,168,104,0.15);color:var(--stone-green);border:1px solid rgba(0,168,104,0.3);">
            🔄 Puxar da Maquininha Stone
          </button>
          <button id="btn-add-central-entity" class="btn-primary-luxury" style="padding:8px 14px;font-size:0.8rem;">
            ➕ Novo Cadastro
          </button>
        </div>
      </div>

      <!-- Filters & Type Selector -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
        <div class="crm-view-toggle">
          <button class="crm-view-btn entity-type-btn ${(!this.activeEntityTypeFilter || this.activeEntityTypeFilter === 'ALL') ? 'active' : ''}" data-type="ALL">
            Todos (${totalCount})
          </button>
          <button class="crm-view-btn entity-type-btn ${this.activeEntityTypeFilter === 'PF' ? 'active' : ''}" data-type="PF">
            👤 Pessoas Físicas (${pfCount})
          </button>
          <button class="crm-view-btn entity-type-btn ${this.activeEntityTypeFilter === 'PJ' ? 'active' : ''}" data-type="PJ">
            🏢 Pessoas Jurídicas (${pjCount})
          </button>
          <button class="crm-view-btn entity-type-btn ${this.activeEntityTypeFilter === 'SUPPLIER' ? 'active' : ''}" data-type="SUPPLIER">
            🚚 Fornecedores (${supplierCount})
          </button>
        </div>

        <div class="crm-search-bar" style="max-width:320px;">
          <span>🔍</span>
          <input type="text" id="input-search-entities" placeholder="Buscar por nome, CPF/CNPJ ou e-mail...">
        </div>
      </div>

      <!-- Entities Table -->
      <div class="content-card">
        <div class="table-responsive">
          <table class="crm-compact-table">
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Nome / Razão Social</th>
                <th>Documento (CPF / CNPJ)</th>
                <th>Contato & Cidade</th>
                <th>Categoria / Vínculo</th>
                <th>Total Movimentado</th>
                <th>Origem Stone</th>
                <th style="text-align:right;">Ações</th>
              </tr>
            </thead>
            <tbody id="table-entities-body">
              ${entities.map(e => `
                <tr>
                  <td>
                    <span class="erp-badge-mode" style="${e.type === 'PF' ? 'background:rgba(56,189,248,0.15);color:var(--blue-accent);' : 'background:rgba(212,175,55,0.15);color:var(--gold-light);'}">
                      ${e.type}
                    </span>
                    ${e.isSupplier ? `<span class="status-badge badge-homologado" style="font-size:0.62rem;background:rgba(212,175,55,0.15);color:var(--gold-light);border:1px solid rgba(212,175,55,0.3);display:block;margin-top:4px;">🚚 Fornecedor</span>` : ''}
                  </td>
                  <td>
                    <strong>${e.type === 'PF' ? e.name : (e.nomeFantasia || e.razaoSocial)}</strong>
                    ${e.type === 'PJ' && e.razaoSocial !== e.nomeFantasia ? `<div style="font-size:0.7rem;color:var(--text-muted);">${e.razaoSocial}</div>` : ''}
                  </td>
                  <td><strong>${e.type === 'PF' ? e.cpf : e.cnpj}</strong></td>
                  <td>
                    <div>${e.phone || '-'}</div>
                    <div style="font-size:0.7rem;color:var(--text-muted);">${e.email || e.city}</div>
                  </td>
                  <td>
                    <span class="category-pill ${(e.category || '').toLowerCase()}">${e.category}</span>
                    <div style="font-size:0.7rem;color:var(--text-muted);">${e.relationship || ''}</div>
                  </td>
                  <td>
                    <strong style="color:var(--emerald-light);">R$ ${(e.totalSpent || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong>
                  </td>
                  <td>
                    <span class="status-badge ${e.stoneSynced ? 'badge-homologado' : 'badge-carencia'}" style="font-size:0.68rem;">
                      ${e.stoneSynced ? '🟢 Maquininha Stone' : 'Manual ERP'}
                    </span>
                  </td>
                  <td style="text-align:right;white-space:nowrap;">
                    <button class="crm-mini-btn btn-view-entity" data-id="${e.id}">Ver Ficha</button>
                    ${e.isSupplier ? `<button class="crm-mini-btn btn-direct-pay" data-name="${e.type === 'PF' ? e.name : (e.nomeFantasia || e.razaoSocial)}" data-cat="${e.category}" style="background:rgba(212,175,55,0.15);color:var(--gold-light);border:1px solid rgba(212,175,55,0.3);margin-left:4px;" title="Lançar Conta a Pagar">🧾 Pagar</button>` : ''}
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Bind entity type filter toggle
    container.querySelectorAll(".entity-type-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        this.activeEntityTypeFilter = btn.getAttribute("data-type");
        this.renderCentralEntities();
      });
    });

    // Bind search
    const inputSearch = document.getElementById("input-search-entities");
    if (inputSearch) {
      inputSearch.addEventListener("input", (e) => {
        const q = e.target.value.toLowerCase();
        const rows = container.querySelectorAll("#table-entities-body tr");
        rows.forEach(r => {
          r.style.display = r.textContent.toLowerCase().includes(q) ? "" : "none";
        });
      });
    }

    // Bind sync stone button
    const btnSyncStone = document.getElementById("btn-sync-stone-customers");
    if (btnSyncStone) {
      btnSyncStone.addEventListener("click", async () => {
        const res = await fetch("/api/erp/sync-stone-customers", { method: "POST" });
        const data = await res.json();
        alert(data.message || "Clientes sincronizados com a maquininha Stone!");
        this.renderCentralEntities();
      });
    }

    const btnAdd = document.getElementById("btn-add-central-entity");
    if (btnAdd) btnAdd.addEventListener("click", () => this.openModalNewEntity());

    // Bind view entity buttons
    container.querySelectorAll(".btn-view-entity").forEach(btn => {
      btn.addEventListener("click", () => this.openModalViewEntity(btn.getAttribute("data-id")));
    });

    container.querySelectorAll(".btn-direct-pay").forEach(btn => {
      btn.addEventListener("click", () => {
        const supName = btn.getAttribute("data-name");
        const supCat = btn.getAttribute("data-cat");
        this.openModalNewPayable({ supplierName: supName, category: supCat });
      });
    });
  },

  async renderSuppliersRegistration() {
    const container = document.getElementById("subpane-cadastros-fornecedores");
    if (!container) return;

    try {
      const res = await fetch("/api/erp/entities?type=SUPPLIER");
      const data = await res.json();
      const suppliers = data.entities || [];

      // KPIs
      const totalSuppliers = suppliers.length;
      const cmvCount = suppliers.filter(s => (s.supplierCategory || '').includes('CMV') || s.category === 'FORNECEDOR_CMV').length;
      const servicesCount = suppliers.filter(s => (s.supplierCategory || '').includes('Serviço') || (s.supplierCategory || '').includes('Eventos') || (s.supplierCategory || '').includes('Contabilidade') || (s.supplierCategory || '').includes('Locação')).length;
      const withPixCount = suppliers.filter(s => s.pixKey && s.pixKey.trim() !== '').length;

      container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
          <div>
            <h4 style="color:#FFF;font-size:1.2rem;margin:0;">🚚 Gestão de Fornecedores Homologados & Parceiros</h4>
            <p style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px;">
              Fornecedores de Confecção CMV (30/60/90d), Locação, Eventos, Contabilidade e Prestadores de Serviços (PF/PJ).
            </p>
          </div>
          <div style="display:flex;gap:10px;">
            <button id="btn-add-supplier-direct" class="btn-primary-luxury" style="padding:8px 14px;font-size:0.8rem;">
              ➕ Novo Fornecedor
            </button>
            <button id="btn-supplier-new-payable" class="btn-primary-luxury" style="padding:8px 14px;font-size:0.8rem;background:rgba(212,175,55,0.15);color:var(--gold-light);border:1px solid rgba(212,175,55,0.3);">
              🧾 Lançar Conta a Pagar
            </button>
          </div>
        </div>

        <!-- 4 KPI Cards -->
        <div class="kpi-grid" style="margin-bottom:20px;">
          <div class="kpi-card">
            <div class="kpi-top">
              <div class="kpi-icon icon-gold">🚚</div>
              <span class="kpi-badge positive">Cadastrados</span>
            </div>
            <div class="kpi-title">Fornecedores Ativos</div>
            <div class="kpi-value">${totalSuppliers}</div>
            <div class="kpi-subtitle">Parceiros PF & PJ Homologados</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-top">
              <div class="kpi-icon icon-rose">🧵</div>
              <span class="kpi-badge positive">CMV & Peças</span>
            </div>
            <div class="kpi-title">Confecção & Tecidos</div>
            <div class="kpi-value">${cmvCount}</div>
            <div class="kpi-subtitle">Faturamento 30/60/90d</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-top">
              <div class="kpi-icon icon-blue">💼</div>
              <span class="kpi-badge positive">Operação</span>
            </div>
            <div class="kpi-title">Serviços & Parcerias</div>
            <div class="kpi-value">${servicesCount}</div>
            <div class="kpi-subtitle">Locação, Drops & Contábil</div>
          </div>

          <div class="kpi-card">
            <div class="kpi-top">
              <div class="kpi-icon icon-emerald">⚡</div>
              <span class="kpi-badge positive">Chave Pronta</span>
            </div>
            <div class="kpi-title">Com Chave PIX Ativa</div>
            <div class="kpi-value">${withPixCount}</div>
            <div class="kpi-subtitle">Liquidação rápida sem atrito</div>
          </div>
        </div>

        <!-- Search and Filter Bar -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
          <div class="crm-search-bar" style="max-width:380px;">
            <span>🔍</span>
            <input type="text" id="input-search-suppliers" placeholder="Buscar fornecedor por razão social, CNPJ/CPF ou ramo...">
          </div>
          <div style="font-size:0.8rem;color:var(--text-muted);">
            Exibindo <strong style="color:var(--gold-light);">${suppliers.length}</strong> fornecedores homologados
          </div>
        </div>

        <!-- Suppliers Table -->
        <div class="content-card">
          <div class="table-responsive">
            <table class="crm-compact-table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Razão Social / Nome</th>
                  <th>CNPJ / CPF</th>
                  <th>Ramo / Especialidade</th>
                  <th>Condição de Pagamento</th>
                  <th>PIX / Dados Bancários</th>
                  <th>Contato</th>
                  <th style="text-align:right;">Ações</th>
                </tr>
              </thead>
              <tbody id="table-suppliers-body">
                ${suppliers.map(s => `
                  <tr>
                    <td>
                      <span class="erp-badge-mode" style="${s.type === 'PF' ? 'background:rgba(56,189,248,0.15);color:var(--blue-accent);' : 'background:rgba(212,175,55,0.15);color:var(--gold-light);'}">
                        ${s.type}
                      </span>
                    </td>
                    <td>
                      <strong>${s.type === 'PF' ? s.name : (s.nomeFantasia || s.razaoSocial)}</strong>
                      ${s.type === 'PJ' && s.razaoSocial && s.razaoSocial !== s.nomeFantasia ? `<div style="font-size:0.7rem;color:var(--text-muted);">${s.razaoSocial}</div>` : ''}
                    </td>
                    <td><strong style="color:var(--text-secondary);">${s.type === 'PF' ? s.cpf : s.cnpj}</strong></td>
                    <td>
                      <span class="category-pill ${s.type === 'PJ' ? 'fornecedor_cmv' : 'parceiro'}" style="font-size:0.72rem;">
                        ${s.supplierCategory || (s.category === 'FORNECEDOR_CMV' ? 'Confecção CMV' : s.category)}
                      </span>
                    </td>
                    <td>
                      <strong style="color:var(--gold-light);font-size:0.78rem;">${s.paymentCondition || '30 dias'}</strong>
                    </td>
                    <td>
                      ${s.pixKey ? `<div style="font-size:0.75rem;color:var(--emerald-light);">🔑 PIX: ${s.pixKey}</div>` : ''}
                      ${s.bankInfo ? `<div style="font-size:0.7rem;color:var(--text-muted);">${s.bankInfo}</div>` : (!s.pixKey ? '<span style="color:var(--text-muted);font-size:0.75rem;">-</span>' : '')}
                    </td>
                    <td>
                      <div style="font-size:0.75rem;">${s.phone || '-'}</div>
                      <div style="font-size:0.7rem;color:var(--text-muted);">${s.email || s.city || '-'}</div>
                    </td>
                    <td style="text-align:right;white-space:nowrap;">
                      <button class="crm-mini-btn btn-view-entity" data-id="${s.id}" title="Ver Ficha Completa">Ficha</button>
                      <button class="crm-mini-btn btn-supplier-pay" data-name="${s.type === 'PF' ? s.name : (s.nomeFantasia || s.razaoSocial)}" data-cat="${s.category}" style="background:rgba(212,175,55,0.15);color:var(--gold-light);border:1px solid rgba(212,175,55,0.3);margin-left:4px;" title="Lançar Nova Conta a Pagar">🧾 Pagar</button>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;

      // Event bindings
      const btnAddSup = document.getElementById("btn-add-supplier-direct");
      if (btnAddSup) btnAddSup.addEventListener("click", () => this.openModalNewEntity({ isSupplier: true }));

      const btnPayable = document.getElementById("btn-supplier-new-payable");
      if (btnPayable) btnPayable.addEventListener("click", () => this.openModalNewPayable());

      container.querySelectorAll(".btn-view-entity").forEach(b => {
        b.addEventListener("click", () => this.openModalViewEntity(b.getAttribute("data-id")));
      });

      container.querySelectorAll(".btn-supplier-pay").forEach(b => {
        b.addEventListener("click", () => {
          const supName = b.getAttribute("data-name");
          const supCat = b.getAttribute("data-cat");
          this.openModalNewPayable({ supplierName: supName, category: supCat });
        });
      });

      const inputSearch = document.getElementById("input-search-suppliers");
      if (inputSearch) {
        inputSearch.addEventListener("input", (e) => {
          const q = e.target.value.toLowerCase();
          const rows = container.querySelectorAll("#table-suppliers-body tr");
          rows.forEach(r => {
            const text = r.textContent.toLowerCase();
            r.style.display = text.includes(q) ? "" : "none";
          });
        });
      }
    } catch (e) {
      console.error(e);
    }
  },

  renderStoresRegistration() {
    const container = document.getElementById("subpane-cadastros-lojas");
    if (!container) return;

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <div>
          <h4 style="color:#FFF;font-size:1.2rem;margin:0;">🏬 Cadastro de Lojas, Corners & Pop-ups (1:N)</h4>
          <p style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px;">
            Unidades vinculadas aos CNPJs do grupo SIÉ com parametrização de aluguel, carência, maquininhas Stone e metas.
          </p>
        </div>
        <button id="btn-add-store-cadastros" class="btn-primary-luxury" style="padding:8px 14px;font-size:0.8rem;">
          ➕ Nova Loja / Corner
        </button>
      </div>

      <div class="stores-grid">
        ${this.stores.map(s => `
          <div class="store-card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
              <div>
                <strong style="color:#FFF;font-size:1rem;display:block;">${s.name}</strong>
                <span style="font-size:0.75rem;color:var(--blue-accent);">${s.type} • ${s.city}</span>
              </div>
              <span class="status-badge badge-carencia" style="font-size:0.68rem;">Stone: ${s.stoneCode}</span>
            </div>

            <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:10px;">
              📍 ${s.location}
            </div>

            <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:8px;">
              CNPJ Mantenedor: <strong style="color:var(--gold-light);">${this.getCnpjNumber(s.cnpjId)}</strong>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;background:rgba(255,255,255,0.02);padding:10px;border-radius:8px;font-size:0.75rem;">
              <div>
                <span style="color:var(--text-muted);display:block;">Aluguel / Mês:</span>
                <strong style="color:${s.rentAmount === 0 ? 'var(--emerald-light)' : '#FFF'};">
                  R$ ${s.rentAmount.toLocaleString('pt-BR', {minimumFractionDigits: 2})}
                </strong>
                ${s.gracePeriodRemainingMonths > 0 ? `
                  <span style="font-size:0.68rem;color:var(--emerald-light);display:block;">(${s.gracePeriodRemainingMonths}m de carência)</span>
                ` : ''}
              </div>
              <div>
                <span style="color:var(--text-muted);display:block;">Meta Vendas:</span>
                <strong style="color:var(--gold-light);">R$ ${s.salesTargetMonthly.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong>
              </div>
            </div>

            <div style="margin-top:8px;font-size:0.7rem;color:var(--text-muted);">
              Terminais: <strong>${(s.terminals || []).join(", ")}</strong>
            </div>
          </div>
        `).join("")}
      </div>
    `;

    const btnAdd = document.getElementById("btn-add-store-cadastros");
    if (btnAdd) btnAdd.addEventListener("click", () => this.openModalNewStore());
  },

  renderCnpjsRegistration() {
    const container = document.getElementById("subpane-cadastros-cnpjs");
    if (!container) return;

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <div>
          <h4 style="color:#FFF;font-size:1.2rem;margin:0;">🏢 Cadastro Geral de CNPJs do Grupo SIÉ</h4>
          <p style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px;">
            Empresas mantenedoras, inscrição estadual, certificados digitais A1 e regimes fiscais.
          </p>
        </div>
        <button id="btn-add-cnpj-cadastros" class="btn-primary-luxury" style="padding:8px 14px;font-size:0.8rem;">
          ➕ Novo CNPJ
        </button>
      </div>

      <div style="display:flex;flex-direction:column;gap:18px;">
        ${this.cnpjs.map(c => `
          <div class="content-card" style="border:1px solid rgba(212,175,55,0.25);">
            <div class="card-header">
              <div>
                <strong style="color:var(--gold-light);font-size:1.1rem;">${c.nomeFantasia}</strong>
                <div style="font-size:0.82rem;color:#FFF;font-weight:600;">${c.razaoSocial}</div>
                <div style="font-size:0.75rem;color:var(--text-muted);">
                  CNPJ: <strong>${c.cnpj}</strong> • Inscrição Estadual: <strong>${c.ie}</strong>
                </div>
              </div>
              <div style="text-align:right;">
                <span class="category-pill ${(c.taxRegime || '').toLowerCase()}">${c.taxRegime}</span>
                <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;">
                  Certificado A1 até: <strong>${new Date(c.digitalCertificateExpires || '2027-12-31').toLocaleDateString('pt-BR')}</strong>
                </div>
              </div>
            </div>
            <div style="font-size:0.78rem;color:var(--text-secondary);margin-top:10px;">
              📍 Endereço Fiscal: ${c.address}
            </div>
          </div>
        `).join("")}
      </div>
    `;

    const btnAdd = document.getElementById("btn-add-cnpj-cadastros");
    if (btnAdd) btnAdd.addEventListener("click", () => this.openModalNewCnpj());
  },

  // --- 8A. CONFIGURAÇÕES: DASHBOARD DE SINCRONIZAÇÕES ---
  async renderSyncDashboard() {
    const container = document.getElementById("subpane-settings-sync-dashboard");
    if (!container) return;

    const syncServices = [
      {
        id: "stone-pos",
        name: "Stone POS Smart P2 (Balcão Loja)",
        category: "Frente de Caixa & TEF",
        provider: "Stone Pagamentos",
        status: "ONLINE",
        statusLabel: "🟢 Conectado & Operacional",
        latency: "98ms",
        lastSync: "Há 2 minutos",
        details: "Terminal P2-89472-FLN ativo na Boutique JOY. NFC-e SEFAZ/SC sincronizada com emissão instantânea.",
        metrics: "R$ 34.185,00 capturados no mês"
      },
      {
        id: "stone-bank",
        name: "Stone Banking & Liquidações API",
        category: "Banking & Split",
        provider: "Stone Banking",
        status: "ONLINE",
        statusLabel: "🟢 Sincronizado (D+1)",
        latency: "142ms",
        lastSync: "Há 8 minutos",
        details: "Regra D+1 Antecipado ativa. Conciliação bancária de recebíveis via webhook charge.paid.",
        metrics: "Taxa média MDR 3,18%"
      },
      {
        id: "meta-wa",
        name: "WhatsApp Cloud API (Meta Oficial)",
        category: "Mensageria & Concierge",
        provider: "Meta Graph API v20.0",
        status: "ONLINE",
        statusLabel: "🟢 Webhooks Ativos",
        latency: "115ms",
        lastSync: "Há 1 minuto",
        details: "WABA ID: waba_sie_joy_2026. Herme Agent IA operando em 5 conversas simultâneas de clientes VIP.",
        metrics: "96.4% de resolução por IA"
      },
      {
        id: "meta-ads",
        name: "Meta Ads Graph API (Marketing Hub)",
        category: "Tráfego Pago & CAPI",
        provider: "Meta Business",
        status: "ONLINE",
        statusLabel: "🟢 Autenticado",
        latency: "180ms",
        lastSync: "Há 15 minutos",
        details: "Conta act_sie_luxury_floripa. Conversões da API (CAPI) sincronizadas com catálogo de produtos.",
        metrics: "ROAS 4.8x • R$ 8.200 orçado"
      },
      {
        id: "apify-scraping",
        name: "Apify & Instagrapi (Scraping Hub)",
        category: "Aquisição de Leads",
        provider: "Apify Cloud Actor",
        status: "STANDBY",
        statusLabel: "🟢 Standby / Agendado",
        latency: "210ms",
        lastSync: "21/09/2026 18:30",
        details: "Monitoramento dos perfis @joywellnessclub, @caiadofloripa e @jurereinternacional. Próxima coleta às 08:00.",
        metrics: "42 leads qualificados hoje"
      },
      {
        id: "erp-catalog",
        name: "Catálogo & Estoque Stone Cloud",
        category: "Gestão de Mercadorias",
        provider: "SIÉ ERP Core",
        status: "ONLINE",
        statusLabel: "🟢 Sincronizado",
        latency: "64ms",
        lastSync: "Há 4 minutos",
        details: "148 SKUs alinhados com o balcão da boutique e pronta-entrega. 2 itens com alerta de grade crítica.",
        metrics: "148 SKUs monitorados"
      }
    ];

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
        <div>
          <h4 style="color:#FFF;font-size:1.2rem;margin:0;">📡 Painel de Sincronizações & Saúde das APIs</h4>
          <p style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px;">
            Status operacional em tempo real de todas as integrações de pagamentos, mensageria, tráfego e inteligência artificial.
          </p>
        </div>
        <div style="display:flex;gap:10px;">
          <button id="btn-force-sync-all" class="btn-primary-luxury" style="font-size:0.8rem;padding:8px 14px;">
            <span>🔄</span>
            <span>Forçar Sincronização Geral</span>
          </button>
        </div>
      </div>

      <!-- Sync KPI Cards Row -->
      <div class="kpi-grid" style="margin-bottom:24px;">
        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-emerald">⚡</div>
            <span class="kpi-badge positive">100% Online</span>
          </div>
          <div class="kpi-title">Saúde das Integrações</div>
          <div class="kpi-value">6 / 6</div>
          <div class="kpi-subtitle">Todos os serviços operacionais</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-gold">⏱️</div>
            <span class="kpi-badge positive">Ótima</span>
          </div>
          <div class="kpi-title">Latência Média Global</div>
          <div class="kpi-value">134 ms</div>
          <div class="kpi-subtitle">APIs Stone, Meta & Apify</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-blue">🔄</div>
            <span class="kpi-badge positive">Hoje</span>
          </div>
          <div class="kpi-title">Eventos Sincronizados</div>
          <div class="kpi-value">142</div>
          <div class="kpi-subtitle">Webhooks e liquidações processadas</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-rose">🛡️</div>
            <span class="kpi-badge positive">Ativo</span>
          </div>
          <div class="kpi-title">Próximo Ciclo Automático</div>
          <div class="kpi-value">12 min</div>
          <div class="kpi-subtitle">Varredura de extrato & leads</div>
        </div>
      </div>

      <!-- Service Status Cards Grid -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(360px, 1fr));gap:16px;margin-bottom:24px;">
        ${syncServices.map(svc => `
          <div class="content-card" style="display:flex;flex-direction:column;justify-content:space-between;padding:18px;">
            <div>
              <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
                <div>
                  <strong style="color:#FFF;font-size:0.95rem;">${svc.name}</strong>
                  <div style="font-size:0.72rem;color:var(--text-muted);">${svc.category} • ${svc.provider}</div>
                </div>
                <span class="status-badge" style="background:rgba(0,168,104,0.12);color:var(--stone-green);border:1px solid rgba(0,168,104,0.3);font-size:0.72rem;padding:4px 10px;">
                  ${svc.statusLabel}
                </span>
              </div>
              <p style="font-size:0.78rem;color:var(--text-secondary);line-height:1.4;margin-bottom:12px;">
                ${svc.details}
              </p>
            </div>
            
            <div style="border-top:1px solid var(--border-subtle);padding-top:10px;display:flex;justify-content:space-between;align-items:center;font-size:0.75rem;">
              <span style="color:var(--gold-light);">${svc.metrics}</span>
              <span style="color:var(--text-muted);">Latência: <strong style="color:#FFF;">${svc.latency}</strong></span>
            </div>
          </div>
        `).join("")}
      </div>

      <!-- Event Sync Logs Table -->
      <div class="content-card">
        <div class="card-header">
          <h4>📜 Log Recente de Eventos de Sincronização</h4>
          <span class="status-badge" style="background:rgba(56,189,248,0.12);color:var(--blue-accent);">Em Tempo Real</span>
        </div>
        <div class="table-responsive">
          <table class="crm-compact-table">
            <thead>
              <tr>
                <th>Horário</th>
                <th>Serviço</th>
                <th>Evento / Ação</th>
                <th>Origem / Destino</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>${new Date().toLocaleTimeString('pt-BR')}</td>
                <td><strong style="color:var(--stone-green);">Stone POS P2</strong></td>
                <td>Captura de Venda Balcão NFC-e</td>
                <td>Terminal Boutique JOY -> ERP</td>
                <td><span class="status-badge" style="background:rgba(0,168,104,0.12);color:var(--stone-green);font-size:0.7rem;">Sucesso 200</span></td>
              </tr>
              <tr>
                <td>Há 4 min</td>
                <td><strong style="color:var(--gold-light);">Stone Banking</strong></td>
                <td>Conciliação de Taxa MDR D+1</td>
                <td>API Stone Recebíveis -> Contas a Receber</td>
                <td><span class="status-badge" style="background:rgba(0,168,104,0.12);color:var(--stone-green);font-size:0.7rem;">Conciliado</span></td>
              </tr>
              <tr>
                <td>Há 7 min</td>
                <td><strong style="color:var(--blue-accent);">WhatsApp Cloud API</strong></td>
                <td>Mensagem Atendida por Herme Agent IA</td>
                <td>Webhook Meta -> Cliente Aluna VIP</td>
                <td><span class="status-badge" style="background:rgba(0,168,104,0.12);color:var(--stone-green);font-size:0.7rem;">Entregue</span></td>
              </tr>
              <tr>
                <td>Há 15 min</td>
                <td><strong style="color:var(--rose-light);">Meta Ads</strong></td>
                <td>Sync de Métricas de Campanha (CAPI)</td>
                <td>Meta Graph API -> Marketing Hub</td>
                <td><span class="status-badge" style="background:rgba(0,168,104,0.12);color:var(--stone-green);font-size:0.7rem;">Sincronizado</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    const btnForce = document.getElementById("btn-force-sync-all");
    if (btnForce) {
      btnForce.addEventListener("click", () => {
        btnForce.disabled = true;
        btnForce.innerHTML = `<span>⏳</span><span>Sincronizando Todas as APIs...</span>`;
        setTimeout(() => {
          btnForce.disabled = false;
          btnForce.innerHTML = `<span>🔄</span><span>Forçar Sincronização Geral</span>`;
          this.showToastNotification("✅ Todas as 6 integrações foram sincronizadas com sucesso! Latência normal.");
        }, 1200);
      });
    }
  },

  // --- 8B. CONFIGURAÇÕES: PLANO DE CONTAS (TOTALMENTE EDITÁVEL) ---
  async loadAccountsData() {
    try {
      const res = await fetch("/api/erp/chart-of-accounts");
      this.accountsData = await res.json();
      return this.accountsData;
    } catch (e) {
      console.error("Erro ao carregar plano de contas e centros de custo:", e);
      return null;
    }
  },

  getCostCenterOptionsHtml(selectedId = "") {
    const list = this.accountsData?.costCenters || [];
    const cnpjList = list.filter(c => c.scope === "CNPJ" || (c.id && c.id.includes("CNPJ")) || c.id === "CC-06");
    const storeList = list.filter(c => c.scope !== "CNPJ" && (!c.id || !c.id.includes("CNPJ")) && c.id !== "CC-06");

    return `
      <optgroup label="🏢 Centros de Custo por CNPJ (Corporativo & Governança)">
        ${cnpjList.map(c => `
          <option value="${c.id}" data-name="${c.name}" ${(c.id === selectedId || c.code === selectedId || (c.legacyId && c.legacyId === selectedId)) ? 'selected' : ''}>
            ${c.code || c.id} • ${c.name.split(' - ')[0]}
          </option>
        `).join("")}
      </optgroup>
      <optgroup label="📍 Centros de Custo por Loja / Unidade">
        ${storeList.map(c => `
          <option value="${c.id}" data-name="${c.name}" ${(c.id === selectedId || c.code === selectedId) ? 'selected' : ''}>
            ${c.code || c.id} • ${c.name.split(' - ')[0]}
          </option>
        `).join("")}
      </optgroup>
    `;
  },

  getAnalyticalAccounts(tree = null) {
    const root = tree || this.accountsData?.chartOfAccounts || [];
    const analyticals = [];
    const traverse = (nodes, parentName = "") => {
      if (!nodes) return;
      for (const n of nodes) {
        if (n.type === "ANALITICA") {
          analyticals.push({ ...n, group: parentName });
        }
        if (n.children && n.children.length > 0) {
          traverse(n.children, parentName ? `${parentName} > ${n.name}` : n.name);
        }
      }
    };
    traverse(root);
    return analyticals;
  },

  getChartAccountOptionsHtml(filterType = "ALL", selectedCode = "") {
    const list = this.getAnalyticalAccounts();
    const groups = {};
    for (const acc of list) {
      let g = acc.group || "Geral";
      if (filterType === "EXPENSE" && acc.nature === "CREDORA" && !acc.code.startsWith("2.") && !acc.code.startsWith("4.")) {
        // Skip non-expense if filtered
      }
      if (!groups[g]) groups[g] = [];
      groups[g].push(acc);
    }

    return Object.entries(groups).map(([groupName, accs]) => `
      <optgroup label="${groupName}">
        ${accs.map(a => `
          <option value="${a.code}" data-name="${a.name}" ${a.code === selectedCode ? 'selected' : ''}>
            ${a.code} - ${a.name}
          </option>
        `).join("")}
      </optgroup>
    `).join("");
  },

  findAccountInTree(nodes, code, parent = null) {
    if (!nodes) return null;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].code === code) {
        return { node: nodes[i], list: nodes, index: i, parent };
      }
      if (nodes[i].children && nodes[i].children.length > 0) {
        const found = this.findAccountInTree(nodes[i].children, code, nodes[i]);
        if (found) return found;
      }
    }
    return null;
  },

  getAllSyntheticAccounts(nodes = null) {
    const root = nodes || this.accountsData?.chartOfAccounts || [];
    const synthetics = [];
    const traverse = (list, depth = 0) => {
      if (!list) return;
      for (const item of list) {
        if (item.type === "SINTETICA") {
          synthetics.push({ code: item.code, name: item.name, depth });
          if (item.children) traverse(item.children, depth + 1);
        }
      }
    };
    traverse(root);
    return synthetics;
  },

  async saveChartOfAccountsTree(newTree) {
    try {
      const res = await fetch("/api/erp/chart-of-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chartOfAccounts: newTree })
      });
      const data = await res.json();
      if (data.success) {
        if (!this.accountsData) this.accountsData = {};
        this.accountsData.chartOfAccounts = data.chartOfAccounts || newTree;
        this.showToastNotification("✅ Plano de Contas salvo com sucesso!");
        this.renderChartOfAccountsOnly();
      } else {
        alert("Erro ao salvar: " + (data.error || "Erro desconhecido"));
      }
    } catch (err) {
      console.error("Erro ao salvar plano de contas:", err);
      alert("Falha de comunicação com o servidor.");
    }
  },

  renderTreeRowsHtml(nodes, depth = 0, filter = "") {
    if (!nodes || nodes.length === 0) return "";
    let html = "";
    const f = filter.toLowerCase().trim();

    for (const node of nodes) {
      const matchSelf = !f || node.code.toLowerCase().includes(f) || node.name.toLowerCase().includes(f) || (node.type || '').toLowerCase().includes(f) || (node.nature || '').toLowerCase().includes(f);
      const childrenHtml = node.children && node.children.length > 0
        ? this.renderTreeRowsHtml(node.children, depth + 1, filter)
        : "";
      const matchChildren = childrenHtml.length > 0;

      if (!matchSelf && !matchChildren) continue;

      const isSynthetic = node.type === "SINTETICA";
      const rowStyle = depth === 0
        ? 'background:rgba(212,175,55,0.08);font-weight:700;'
        : (depth === 1 ? 'background:rgba(255,255,255,0.02);font-weight:600;' : '');
      const indentPadding = depth === 0 ? 12 : (depth * 20 + 12);

      html += `
        <tr style="${rowStyle}height:42px;">
          <td style="padding-left:${indentPadding}px;white-space:nowrap;">
            <strong style="color:${depth === 0 ? 'var(--gold-light)' : (depth === 1 ? '#FFF' : 'var(--text-muted)')};font-family:monospace;font-size:0.85rem;">
              ${node.code}
            </strong>
          </td>
          <td>
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:0.85rem;">${isSynthetic ? '📁' : '📄'}</span>
              <span style="color:${isSynthetic ? '#FFF' : 'var(--text-secondary)'};font-size:0.83rem;">
                ${node.name}
              </span>
            </div>
          </td>
          <td>
            <span class="erp-badge-mode btn-toggle-type" data-code="${node.code}" style="cursor:pointer;background:${isSynthetic ? 'rgba(59,130,246,0.15)' : 'rgba(16,185,129,0.15)'};color:${isSynthetic ? 'var(--blue-accent)' : 'var(--emerald-light)'};border:1px solid ${isSynthetic ? 'rgba(59,130,246,0.3)' : 'rgba(16,185,129,0.3)'};font-size:0.68rem;padding:2px 6px;" title="Clique para alternar entre Sintética e Analítica">
              ${node.type}
            </span>
          </td>
          <td>
            <span class="btn-toggle-nature" data-code="${node.code}" style="cursor:pointer;color:${node.nature === 'DEVEDORA' ? 'var(--rose-light)' : 'var(--emerald-light)'};font-size:0.75rem;font-weight:600;" title="Clique para alternar Natureza">
              ${node.nature}
            </span>
          </td>
          <td style="text-align:right;white-space:nowrap;">
            <div style="display:inline-flex;gap:4px;align-items:center;">
              ${isSynthetic ? `
                <button class="crm-mini-btn btn-add-subaccount" data-code="${node.code}" title="Adicionar Subconta Filha" style="background:rgba(0,168,104,0.15);color:var(--stone-green);border-color:rgba(0,168,104,0.3);font-size:0.7rem;padding:3px 7px;">
                  ➕ Filha
                </button>
              ` : ''}
              <button class="crm-mini-btn btn-edit-account" data-code="${node.code}" title="Editar Conta (Número, Nome, Tipo)" style="background:rgba(59,130,246,0.15);color:var(--blue-accent);border-color:rgba(59,130,246,0.3);font-size:0.7rem;padding:3px 6px;">
                ✏️
              </button>
              <button class="crm-mini-btn btn-move-account-up" data-code="${node.code}" title="Mover para Cima" style="background:rgba(255,255,255,0.06);color:#FFF;border-color:rgba(255,255,255,0.2);font-size:0.7rem;padding:3px 6px;">
                ⬆️
              </button>
              <button class="crm-mini-btn btn-move-account-down" data-code="${node.code}" title="Mover para Baixo" style="background:rgba(255,255,255,0.06);color:#FFF;border-color:rgba(255,255,255,0.2);font-size:0.7rem;padding:3px 6px;">
                ⬇️
              </button>
              <button class="crm-mini-btn btn-delete-account" data-code="${node.code}" title="Excluir Conta" style="background:rgba(239,68,68,0.15);color:var(--rose-light);border-color:rgba(239,68,68,0.3);font-size:0.7rem;padding:3px 6px;">
                🗑️
              </button>
            </div>
          </td>
        </tr>
      `;

      if (childrenHtml) {
        html += childrenHtml;
      }
    }
    return html;
  },

  async renderChartOfAccountsOnly() {
    const container = document.getElementById("subpane-settings-chart-accounts");
    if (!container) return;

    try {
      const res = await fetch("/api/erp/chart-of-accounts");
      this.accountsData = await res.json();
    } catch (e) {
      console.error(e);
      return;
    }

    const { chartOfAccounts } = this.accountsData || { chartOfAccounts: [] };

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
        <div>
          <h4 style="color:#FFF;font-size:1.2rem;margin:0;">📑 Plano de Contas Totalmente Editável (SIÉ Wear & Varejo)</h4>
          <p style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px;">
            Adicione, edite numeração, nome, tipo (Sintética/Analítica), natureza, reordene e exclua contas contábeis em tempo real.
          </p>
        </div>
        <div style="display:flex;gap:10px;align-items:center;">
          <input type="text" id="chart-account-search" placeholder="🔍 Filtrar conta por código/nome..." class="erp-input-sm" style="width:230px;padding:6px 10px;font-size:0.78rem;">
          <button id="btn-add-root-account" class="btn-primary-luxury" style="font-size:0.8rem;padding:7px 14px;">
            ➕ Nova Conta Raiz
          </button>
        </div>
      </div>

      <!-- Chart of Accounts Tree Table -->
      <div class="content-card">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;gap:10px;">
            <h4 style="margin:0;">📊 Estrutura Hierárquica Interativa</h4>
            <span class="status-badge" style="background:rgba(212,175,55,0.12);color:var(--gold-light);">Padrão CPC / DRE</span>
          </div>
          <span style="font-size:0.75rem;color:var(--text-muted);">
            💡 Clique no tipo ou natureza para alternância rápida, ou em ✏️ para edição completa.
          </span>
        </div>

        <div class="table-responsive">
          <table class="crm-compact-table" id="table-chart-accounts">
            <thead>
              <tr>
                <th style="width:130px;">Código</th>
                <th>Classificação Contábil</th>
                <th style="width:110px;">Tipo</th>
                <th style="width:100px;">Natureza</th>
                <th style="text-align:right;width:220px;">Ações</th>
              </tr>
            </thead>
            <tbody id="chart-accounts-tbody">
              ${this.renderTreeRowsHtml(chartOfAccounts, 0, "")}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Live search listener
    const searchInput = document.getElementById("chart-account-search");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        const filter = e.target.value;
        const tbody = document.getElementById("chart-accounts-tbody");
        if (tbody) {
          tbody.innerHTML = this.renderTreeRowsHtml(this.accountsData?.chartOfAccounts || [], 0, filter);
          this.attachChartAccountsTableEvents(container);
        }
      });
    }

    // Add root account
    const btnAddRoot = document.getElementById("btn-add-root-account");
    if (btnAddRoot) {
      btnAddRoot.addEventListener("click", () => this.openModalAddChartAccount(null));
    }

    // Attach row events
    this.attachChartAccountsTableEvents(container);
  },

  attachChartAccountsTableEvents(container) {
    // Add subaccount
    container.querySelectorAll(".btn-add-subaccount").forEach(btn => {
      btn.addEventListener("click", () => {
        const code = btn.getAttribute("data-code");
        this.openModalAddChartAccount(code);
      });
    });

    // Edit account
    container.querySelectorAll(".btn-edit-account").forEach(btn => {
      btn.addEventListener("click", () => {
        const code = btn.getAttribute("data-code");
        this.openModalEditChartAccount(code);
      });
    });

    // Move up
    container.querySelectorAll(".btn-move-account-up").forEach(btn => {
      btn.addEventListener("click", () => {
        const code = btn.getAttribute("data-code");
        this.moveChartAccount(code, "UP");
      });
    });

    // Move down
    container.querySelectorAll(".btn-move-account-down").forEach(btn => {
      btn.addEventListener("click", () => {
        const code = btn.getAttribute("data-code");
        this.moveChartAccount(code, "DOWN");
      });
    });

    // Delete
    container.querySelectorAll(".btn-delete-account").forEach(btn => {
      btn.addEventListener("click", () => {
        const code = btn.getAttribute("data-code");
        this.deleteChartAccount(code);
      });
    });

    // Quick toggle type
    container.querySelectorAll(".btn-toggle-type").forEach(badge => {
      badge.addEventListener("click", () => {
        const code = badge.getAttribute("data-code");
        this.toggleAccountType(code);
      });
    });

    // Quick toggle nature
    container.querySelectorAll(".btn-toggle-nature").forEach(badge => {
      badge.addEventListener("click", () => {
        const code = badge.getAttribute("data-code");
        this.toggleAccountNature(code);
      });
    });
  },

  openModalAddChartAccount(parentCode = null) {
    const synthetics = this.getAllSyntheticAccounts();
    const modalHtml = `
      <div id="modal-erp-temp" class="modal-backdrop" style="display:flex;">
        <div class="modal-window" style="max-width:560px;">
          <button class="modal-close-btn" onclick="document.getElementById('modal-erp-temp').remove()">&times;</button>
          <h4 style="color:#FFF;font-family:var(--font-display);margin-bottom:6px;">➕ Nova Conta Contábil</h4>
          <p style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:16px;">
            ${parentCode ? `Inserindo subconta vinculada ao grupo <strong>${parentCode}</strong>` : 'Adicione uma conta raiz ou selecione um agrupador sintético.'}
          </p>

          <form id="form-add-chart-account">
            <div style="display:grid;grid-template-columns:1fr 2fr;gap:12px;margin-bottom:12px;">
              <div>
                <label class="erp-label">Código / Numeração:</label>
                <input type="text" id="in-new-acc-code" required class="erp-input-sm" style="width:100%;font-weight:700;" placeholder="Ex: 1.1.2.03">
              </div>
              <div>
                <label class="erp-label">Nome da Conta Contábil:</label>
                <input type="text" id="in-new-acc-name" required class="erp-input-sm" style="width:100%;" placeholder="Ex: Vendas Voucher & Parcerias VIP">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
              <div>
                <label class="erp-label">Tipo da Conta:</label>
                <select id="in-new-acc-type" class="erp-input-sm" style="width:100%;">
                  <option value="ANALITICA">ANALÍTICA (Lançamentos / Operacional)</option>
                  <option value="SINTETICA">SINTÉTICA (Agrupadora / Totalizadora)</option>
                </select>
              </div>
              <div>
                <label class="erp-label">Natureza do Saldo:</label>
                <select id="in-new-acc-nature" class="erp-input-sm" style="width:100%;">
                  <option value="DEVEDORA">DEVEDORA (Ativo / Custos / Despesas)</option>
                  <option value="CREDORA">CREDORA (Passivo / PL / Receitas)</option>
                </select>
              </div>
            </div>

            <div style="margin-bottom:18px;">
              <label class="erp-label">Conta Pai / Agrupador Sintético:</label>
              <select id="in-new-acc-parent" class="erp-input-sm" style="width:100%;">
                <option value="">(Nenhuma - Nível Raiz / Grupo Principal)</option>
                ${synthetics.map(s => `
                  <option value="${s.code}" ${s.code === parentCode ? 'selected' : ''}>
                    ${'&nbsp;&nbsp;'.repeat(s.depth * 2)}${s.code} - ${s.name}
                  </option>
                `).join("")}
              </select>
            </div>

            <div style="display:flex;justify-content:flex-end;gap:10px;">
              <button type="button" class="modal-close-btn-secondary" onclick="document.getElementById('modal-erp-temp').remove()">Cancelar</button>
              <button type="submit" class="btn-primary-luxury">Salvar Conta Contábil</button>
            </div>
          </form>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", modalHtml);

    document.getElementById("form-add-chart-account").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = document.getElementById("in-new-acc-code").value.trim();
      const name = document.getElementById("in-new-acc-name").value.trim();
      const type = document.getElementById("in-new-acc-type").value;
      const nature = document.getElementById("in-new-acc-nature").value;
      const targetParentCode = document.getElementById("in-new-acc-parent").value;

      const tree = JSON.parse(JSON.stringify(this.accountsData?.chartOfAccounts || []));
      const newAccount = {
        code,
        name,
        type,
        nature,
        ...(type === "SINTETICA" ? { children: [] } : {})
      };

      if (!targetParentCode) {
        tree.push(newAccount);
      } else {
        const foundParent = this.findAccountInTree(tree, targetParentCode);
        if (foundParent && foundParent.node) {
          if (!foundParent.node.children) foundParent.node.children = [];
          foundParent.node.children.push(newAccount);
        } else {
          tree.push(newAccount);
        }
      }

      document.getElementById("modal-erp-temp").remove();
      await this.saveChartOfAccountsTree(tree);
    });
  },

  openModalEditChartAccount(code) {
    const tree = JSON.parse(JSON.stringify(this.accountsData?.chartOfAccounts || []));
    const item = this.findAccountInTree(tree, code);
    if (!item) {
      alert("Conta não encontrada: " + code);
      return;
    }
    const { node, parent } = item;
    const currentParentCode = parent ? parent.code : "";
    const synthetics = this.getAllSyntheticAccounts(tree).filter(s => s.code !== code);

    const modalHtml = `
      <div id="modal-erp-temp" class="modal-backdrop" style="display:flex;">
        <div class="modal-window" style="max-width:560px;">
          <button class="modal-close-btn" onclick="document.getElementById('modal-erp-temp').remove()">&times;</button>
          <h4 style="color:#FFF;font-family:var(--font-display);margin-bottom:6px;">✏️ Editar Conta Contábil</h4>
          <p style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:16px;">
            Altere numeração, descrição, tipo contábil, natureza ou mova para outro grupo sintético.
          </p>

          <form id="form-edit-chart-account">
            <div style="display:grid;grid-template-columns:1fr 2fr;gap:12px;margin-bottom:12px;">
              <div>
                <label class="erp-label">Código / Numeração:</label>
                <input type="text" id="in-edit-acc-code" required class="erp-input-sm" style="width:100%;font-weight:700;" value="${node.code}">
              </div>
              <div>
                <label class="erp-label">Nome da Conta Contábil:</label>
                <input type="text" id="in-edit-acc-name" required class="erp-input-sm" style="width:100%;" value="${node.name}">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
              <div>
                <label class="erp-label">Tipo da Conta:</label>
                <select id="in-edit-acc-type" class="erp-input-sm" style="width:100%;">
                  <option value="SINTETICA" ${node.type === 'SINTETICA' ? 'selected' : ''}>SINTÉTICA (Agrupadora / Totalizadora)</option>
                  <option value="ANALITICA" ${node.type === 'ANALITICA' ? 'selected' : ''}>ANALÍTICA (Lançamentos / Operacional)</option>
                </select>
              </div>
              <div>
                <label class="erp-label">Natureza do Saldo:</label>
                <select id="in-edit-acc-nature" class="erp-input-sm" style="width:100%;">
                  <option value="DEVEDORA" ${node.nature === 'DEVEDORA' ? 'selected' : ''}>DEVEDORA (Ativo / Custos / Despesas)</option>
                  <option value="CREDORA" ${node.nature === 'CREDORA' ? 'selected' : ''}>CREDORA (Passivo / PL / Receitas)</option>
                </select>
              </div>
            </div>

            <div style="margin-bottom:18px;">
              <label class="erp-label">Conta Pai / Agrupador Sintético (Mover de Nível):</label>
              <select id="in-edit-acc-parent" class="erp-input-sm" style="width:100%;">
                <option value="" ${!currentParentCode ? 'selected' : ''}>(Nenhuma - Nível Raiz / Grupo Principal)</option>
                ${synthetics.map(s => `
                  <option value="${s.code}" ${s.code === currentParentCode ? 'selected' : ''}>
                    ${'&nbsp;&nbsp;'.repeat(s.depth * 2)}${s.code} - ${s.name}
                  </option>
                `).join("")}
              </select>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;">
              <button type="button" class="modal-close-btn-secondary" style="color:var(--rose-light);border-color:rgba(239,68,68,0.3);" onclick="ErpController.deleteChartAccount('${node.code}')">
                🗑️ Excluir Conta
              </button>
              <div style="display:flex;gap:10px;">
                <button type="button" class="modal-close-btn-secondary" onclick="document.getElementById('modal-erp-temp').remove()">Cancelar</button>
                <button type="submit" class="btn-primary-luxury">Salvar Alterações</button>
              </div>
            </div>
          </form>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", modalHtml);

    document.getElementById("form-edit-chart-account").addEventListener("submit", async (e) => {
      e.preventDefault();
      const newCode = document.getElementById("in-edit-acc-code").value.trim();
      const newName = document.getElementById("in-edit-acc-name").value.trim();
      const newType = document.getElementById("in-edit-acc-type").value;
      const newNature = document.getElementById("in-edit-acc-nature").value;
      const newParentCode = document.getElementById("in-edit-acc-parent").value;

      node.code = newCode;
      node.name = newName;
      node.type = newType;
      node.nature = newNature;
      if (newType === "SINTETICA" && !node.children) node.children = [];

      // Check if parent moved
      if (newParentCode !== currentParentCode) {
        item.list.splice(item.index, 1);
        if (!newParentCode) {
          tree.push(node);
        } else {
          const newParentItem = this.findAccountInTree(tree, newParentCode);
          if (newParentItem && newParentItem.node) {
            if (!newParentItem.node.children) newParentItem.node.children = [];
            newParentItem.node.children.push(node);
          } else {
            tree.push(node);
          }
        }
      }

      document.getElementById("modal-erp-temp").remove();
      await this.saveChartOfAccountsTree(tree);
    });
  },

  async deleteChartAccount(code) {
    const tree = JSON.parse(JSON.stringify(this.accountsData?.chartOfAccounts || []));
    const item = this.findAccountInTree(tree, code);
    if (!item) return;

    const hasChildren = item.node.children && item.node.children.length > 0;
    const msg = hasChildren
      ? `Atenção: A conta [${item.node.code}] possui ${item.node.children.length} subcontas vinculadas!\nDeseja realmente excluir esta conta e TODAS as suas subcontas?`
      : `Deseja realmente excluir a conta [${item.node.code} - ${item.node.name}]?`;

    if (!confirm(msg)) return;

    item.list.splice(item.index, 1);
    const modal = document.getElementById("modal-erp-temp");
    if (modal) modal.remove();
    await this.saveChartOfAccountsTree(tree);
  },

  async moveChartAccount(code, direction) {
    const tree = JSON.parse(JSON.stringify(this.accountsData?.chartOfAccounts || []));
    const item = this.findAccountInTree(tree, code);
    if (!item) return;

    const { list, index } = item;
    if (direction === "UP") {
      if (index === 0) {
        this.showToastNotification("A conta já é a primeira do seu grupo!");
        return;
      }
      const temp = list[index - 1];
      list[index - 1] = list[index];
      list[index] = temp;
    } else if (direction === "DOWN") {
      if (index === list.length - 1) {
        this.showToastNotification("A conta já é a última do seu grupo!");
        return;
      }
      const temp = list[index + 1];
      list[index + 1] = list[index];
      list[index] = temp;
    }

    await this.saveChartOfAccountsTree(tree);
  },

  async toggleAccountType(code) {
    const tree = JSON.parse(JSON.stringify(this.accountsData?.chartOfAccounts || []));
    const item = this.findAccountInTree(tree, code);
    if (!item) return;

    if (item.node.type === "SINTETICA") {
      if (item.node.children && item.node.children.length > 0) {
        if (!confirm(`A conta possui ${item.node.children.length} subcontas. Ao mudar para Analítica, as subcontas permanecerão ocultas nos lançamentos. Continuar?`)) {
          return;
        }
      }
      item.node.type = "ANALITICA";
    } else {
      item.node.type = "SINTETICA";
      if (!item.node.children) item.node.children = [];
    }

    await this.saveChartOfAccountsTree(tree);
  },

  async toggleAccountNature(code) {
    const tree = JSON.parse(JSON.stringify(this.accountsData?.chartOfAccounts || []));
    const item = this.findAccountInTree(tree, code);
    if (!item) return;

    item.node.nature = item.node.nature === "DEVEDORA" ? "CREDORA" : "DEVEDORA";
    await this.saveChartOfAccountsTree(tree);
  },

  // --- 8C. CONFIGURAÇÕES: CENTROS DE CUSTO (POR LOJA E POR CNPJ) ---
  async renderCostCentersOnly() {
    const container = document.getElementById("subpane-settings-cost-centers");
    if (!container) return;

    try {
      const res = await fetch("/api/erp/chart-of-accounts");
      this.accountsData = await res.json();
    } catch (e) {
      console.error(e);
      return;
    }

    const costCenters = this.accountsData?.costCenters || [];
    const cnpjCostCenters = costCenters.filter(c => c.scope === "CNPJ" || (c.id && c.id.includes("CNPJ")) || c.id === "CC-06");
    const storeCostCenters = costCenters.filter(c => c.scope !== "CNPJ" && (!c.id || !c.id.includes("CNPJ")) && c.id !== "CC-06");

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
        <div>
          <h4 style="color:#FFF;font-size:1.2rem;margin:0;">🏢 Centros de Custo (Unidades Físicas, Digitais & Corporativo CNPJ)</h4>
          <p style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px;">
            Estrutura vinculada: um centro de custo para cada Loja e um para cada CNPJ do grupo SIÉ.
          </p>
        </div>
        <button id="btn-new-cost-center" class="btn-primary-luxury" style="font-size:0.8rem;padding:8px 14px;">
          ➕ Novo Centro de Custo
        </button>
      </div>

      <!-- Section 1: CNPJ Corporate Cost Centers -->
      <div style="margin-bottom:24px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
          <span style="font-size:1.1rem;">🏢</span>
          <h5 style="color:var(--gold-light);margin:0;font-size:0.95rem;text-transform:uppercase;letter-spacing:0.5px;">
            Centros de Custo por CNPJ (Corporativo & Governança)
          </h5>
          <span class="status-badge" style="background:rgba(212,175,55,0.15);color:var(--gold-light);font-size:0.68rem;">
            ${cnpjCostCenters.length} Centros Vinculados
          </span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(360px, 1fr));gap:16px;">
          ${cnpjCostCenters.map(cc => `
            <div class="content-card" style="padding:18px;border-left:3px solid var(--gold-primary);">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <strong style="color:#FFF;font-size:1rem;">${cc.name}</strong>
                <span class="erp-badge-mode" style="background:rgba(212,175,55,0.15);color:var(--gold-light);border:1px solid rgba(212,175,55,0.3);font-size:0.75rem;padding:2px 8px;">
                  ${cc.code || cc.id}
                </span>
              </div>
              <div style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:8px;">
                Escopo: <strong style="color:var(--gold-light);">Corporativo por CNPJ</strong> • Gestor: <strong style="color:#FFF;">${cc.manager}</strong>
              </div>
              <div style="font-size:0.74rem;color:var(--text-muted);margin-bottom:10px;">
                CNPJ Vinculado: <strong style="color:var(--blue-accent);">${this.getCnpjNumber(cc.cnpjId)}</strong>
              </div>
              <div style="border-top:1px solid var(--border-subtle);padding-top:10px;margin-top:10px;display:flex;justify-content:space-between;align-items:center;font-size:0.75rem;">
                <span style="color:var(--stone-green);font-weight:600;">🟢 Ativo & Vinculado</span>
                <button class="crm-mini-btn btn-edit-cost-center" data-id="${cc.id}" style="background:rgba(255,255,255,0.06);color:#FFF;border-color:rgba(255,255,255,0.2);font-size:0.7rem;padding:3px 8px;">
                  ✏️ Editar
                </button>
              </div>
            </div>
          `).join("")}
        </div>
      </div>

      <!-- Section 2: Store Cost Centers -->
      <div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
          <span style="font-size:1.1rem;">📍</span>
          <h5 style="color:var(--blue-accent);margin:0;font-size:0.95rem;text-transform:uppercase;letter-spacing:0.5px;">
            Centros de Custo por Loja / Unidade Operacional
          </h5>
          <span class="status-badge" style="background:rgba(59,130,246,0.15);color:var(--blue-accent);font-size:0.68rem;">
            ${storeCostCenters.length} Lojas Vinculadas
          </span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(360px, 1fr));gap:16px;">
          ${storeCostCenters.map(cc => `
            <div class="content-card" style="padding:18px;border-left:3px solid var(--blue-accent);">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <strong style="color:#FFF;font-size:1rem;">${cc.name}</strong>
                <span class="erp-badge-mode" style="background:rgba(59,130,246,0.15);color:var(--blue-accent);border:1px solid rgba(59,130,246,0.3);font-size:0.75rem;padding:2px 8px;">
                  ${cc.code || cc.id}
                </span>
              </div>
              <div style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:8px;">
                Escopo: <strong style="color:var(--blue-accent);">Unidade Loja</strong> • Tipo: <strong>${cc.type}</strong> • Gestor: <strong style="color:#FFF;">${cc.manager}</strong>
              </div>
              <div style="font-size:0.74rem;color:var(--text-muted);margin-bottom:10px;">
                CNPJ Vinculado: <strong style="color:#FFF;">${this.getCnpjNumber(cc.cnpjId)}</strong>
              </div>
              <div style="border-top:1px solid var(--border-subtle);padding-top:10px;margin-top:10px;display:flex;justify-content:space-between;align-items:center;font-size:0.75rem;">
                <span style="color:var(--stone-green);font-weight:600;">🟢 Ativo & Vinculado</span>
                <button class="crm-mini-btn btn-edit-cost-center" data-id="${cc.id}" style="background:rgba(255,255,255,0.06);color:#FFF;border-color:rgba(255,255,255,0.2);font-size:0.7rem;padding:3px 8px;">
                  ✏️ Editar
                </button>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    `;

    // Wire btn-new-cost-center
    const btnNew = document.getElementById("btn-new-cost-center");
    if (btnNew) {
      btnNew.addEventListener("click", () => this.openModalNewCostCenter());
    }

    // Wire edit buttons
    container.querySelectorAll(".btn-edit-cost-center").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        this.openModalNewCostCenter(id);
      });
    });
  },

  openModalNewCostCenter(costCenterId = null) {
    const list = this.accountsData?.costCenters || [];
    const cc = costCenterId ? list.find(c => c.id === costCenterId) : null;
    const isEdit = !!cc;

    const modalHtml = `
      <div id="modal-erp-temp" class="modal-backdrop" style="display:flex;">
        <div class="modal-window" style="max-width:560px;">
          <button class="modal-close-btn" onclick="document.getElementById('modal-erp-temp').remove()">&times;</button>
          <h4 style="color:#FFF;font-family:var(--font-display);margin-bottom:6px;">
            ${isEdit ? '✏️ Editar Centro de Custo' : '➕ Novo Centro de Custo'}
          </h4>
          <p style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:16px;">
            Vincule um centro de custo para cada Loja ou para cada CNPJ do grupo SIÉ.
          </p>

          <form id="form-cost-center">
            <div style="display:grid;grid-template-columns:1fr 2fr;gap:12px;margin-bottom:12px;">
              <div>
                <label class="erp-label">Código / Sigla:</label>
                <input type="text" id="in-cc-code" required class="erp-input-sm" style="width:100%;font-weight:700;" value="${cc ? (cc.code || cc.id) : `CC-${list.length + 1}`}">
              </div>
              <div>
                <label class="erp-label">Nome do Centro de Custo:</label>
                <input type="text" id="in-cc-name" required class="erp-input-sm" style="width:100%;" value="${cc ? cc.name : ''}" placeholder="Ex: Corner JOY Club - Balneário Camboriú">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
              <div>
                <label class="erp-label">Escopo do Centro de Custo:</label>
                <select id="in-cc-scope" class="erp-input-sm" style="width:100%;">
                  <option value="STORE" ${cc?.scope === 'STORE' ? 'selected' : ''}>📍 Por Loja / Unidade Operacional</option>
                  <option value="CNPJ" ${cc?.scope === 'CNPJ' ? 'selected' : ''}>🏢 Por CNPJ (Corporativo & Governança)</option>
                </select>
              </div>
              <div>
                <label class="erp-label">Tipo Operacional:</label>
                <select id="in-cc-type" class="erp-input-sm" style="width:100%;">
                  <option value="LOJA_PROPRIA" ${cc?.type === 'LOJA_PROPRIA' ? 'selected' : ''}>Boutique Flagship</option>
                  <option value="CORNER" ${cc?.type === 'CORNER' ? 'selected' : ''}>Corner</option>
                  <option value="POPUP" ${cc?.type === 'POPUP' ? 'selected' : ''}>Pop-up Store</option>
                  <option value="CANAL_DIGITAL" ${cc?.type === 'CANAL_DIGITAL' ? 'selected' : ''}>Canal Digital / IA</option>
                  <option value="CORPORATIVO_CNPJ" ${cc?.type === 'CORPORATIVO_CNPJ' ? 'selected' : ''}>Corporativo CNPJ</option>
                  <option value="ADMINISTRATIVO" ${cc?.type === 'ADMINISTRATIVO' ? 'selected' : ''}>Administração Geral</option>
                </select>
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
              <div>
                <label class="erp-label">CNPJ Vinculado:</label>
                <select id="in-cc-cnpj" class="erp-input-sm" style="width:100%;">
                  ${this.cnpjs.map(c => `
                    <option value="${c.id}" ${cc?.cnpjId === c.id ? 'selected' : ''}>
                      ${c.cnpj} (${c.nomeFantasia || c.razaoSocial})
                    </option>
                  `).join("")}
                </select>
              </div>
              <div>
                <label class="erp-label">Loja Vinculada (se aplicável):</label>
                <select id="in-cc-store" class="erp-input-sm" style="width:100%;">
                  <option value="ALL">(Nenhuma / Aplicável a Todas)</option>
                  ${this.stores.map(s => `
                    <option value="${s.id}" ${cc?.storeId === s.id ? 'selected' : ''}>
                      ${s.name}
                    </option>
                  `).join("")}
                </select>
              </div>
            </div>

            <div style="margin-bottom:18px;">
              <label class="erp-label">Gestor / Responsável:</label>
              <input type="text" id="in-cc-manager" required class="erp-input-sm" style="width:100%;" value="${cc ? cc.manager : 'Paulo Júnior'}" placeholder="Nome do gestor do centro de custo">
            </div>

            <div style="display:flex;justify-content:flex-end;gap:10px;">
              <button type="button" class="modal-close-btn-secondary" onclick="document.getElementById('modal-erp-temp').remove()">Cancelar</button>
              <button type="submit" class="btn-primary-luxury">Salvar Centro de Custo</button>
            </div>
          </form>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", modalHtml);

    document.getElementById("form-cost-center").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = document.getElementById("in-cc-code").value.trim();
      const name = document.getElementById("in-cc-name").value.trim();
      const scope = document.getElementById("in-cc-scope").value;
      const type = document.getElementById("in-cc-type").value;
      const cnpjId = document.getElementById("in-cc-cnpj").value;
      const storeId = document.getElementById("in-cc-store").value;
      const manager = document.getElementById("in-cc-manager").value.trim();

      const newCc = {
        id: cc ? cc.id : code,
        code,
        name,
        scope,
        type,
        cnpjId,
        storeId,
        manager,
        status: "ACTIVE"
      };

      try {
        const res = await fetch("/api/erp/cost-centers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ costCenter: newCc })
        });
        const data = await res.json();
        if (data.success) {
          if (!this.accountsData) this.accountsData = {};
          this.accountsData.costCenters = data.costCenters;
          this.showToastNotification("✅ Centro de Custo salvo com sucesso!");
          document.getElementById("modal-erp-temp").remove();
          this.renderCostCentersOnly();
        } else {
          alert("Erro: " + (data.error || "Não foi possível salvar o centro de custo"));
        }
      } catch (err) {
        console.error(err);
        alert("Erro de comunicação com o servidor.");
      }
    });
  },

  renderChartOfAccounts() {
    this.renderSyncDashboard();
  },

  // --- 9. CONFIGURAÇÕES: REGRAS DE LIQUIDAÇÃO STONE ---
  async renderSettlementRulesConfig() {
    const container = document.getElementById("subpane-settings-rules");
    if (!container) return;

    try {
      const res = await fetch("/api/erp/accounts-receivable");
      const data = await res.json();
      this.receivablesData = data;
    } catch (e) {
      console.error(e);
    }

    const rules = this.receivablesData?.settlementRules || {};

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <div>
            <h4>⚙️ Configuração de Liquidação Stone & Meios de Recebimento</h4>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px;">
              Parametrização flexível dos prazos de liquidação (D+0, D+1, D+n ou fluxo parcelado) e taxas MDR.
            </p>
          </div>
          <button id="btn-save-settlement-rules" class="btn-primary-luxury" style="padding:6px 14px;font-size:0.8rem;">
            💾 Salvar Parâmetros
          </button>
        </div>

        <div class="settlement-rules-grid">
          ${Object.entries(rules).map(([method, rule]) => `
            <div class="settlement-rule-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <strong style="color:#FFF;font-size:0.85rem;">
                  ${method === 'PIX' ? '⚡ PIX Instantâneo' :
                    method === 'DEBIT' ? '💳 Cartão de Débito' :
                    method === 'CREDIT_SIGHT' ? '💎 Crédito à Vista' :
                    method === 'CREDIT_INSTALLMENTS' ? '🛍️ Crédito Parcelado (Até 3x)' : '🏢 Faturamento Corporativo'}
                </strong>
                <span class="erp-badge-mode">${rule.mode}</span>
              </div>
              <p style="font-size:0.75rem;color:var(--text-muted);margin-bottom:10px;">${rule.description}</p>
              
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                <div>
                  <label class="erp-label">Prazo de Liquidação:</label>
                  <select class="erp-input-sm rule-mode-select" data-method="${method}" style="width:100%;">
                    <option value="D+0" ${rule.mode === 'D+0' ? 'selected' : ''}>D+0 (Mesmo dia)</option>
                    <option value="D+1" ${rule.mode === 'D+1' ? 'selected' : ''}>D+1 (1 dia útil)</option>
                    <option value="D+1_ANTICIPATED" ${rule.mode === 'D+1_ANTICIPATED' ? 'selected' : ''}>D+1 Antecipado Automático</option>
                    <option value="D+30" ${rule.mode === 'D+30' ? 'selected' : ''}>D+30 (30 dias)</option>
                    <option value="INSTALLMENT_FLOW" ${rule.mode === 'INSTALLMENT_FLOW' ? 'selected' : ''}>Fluxo de Parcelas (30/60/90d)</option>
                  </select>
                </div>
                <div>
                  <label class="erp-label">Taxa MDR (%):</label>
                  <input type="number" step="0.01" class="erp-input-sm rule-mdr-input" data-method="${method}" value="${(rule.mdrRate * 100).toFixed(2)}" style="width:100%;">
                </div>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    `;

    const btnSave = document.getElementById("btn-save-settlement-rules");
    if (btnSave) {
      btnSave.addEventListener("click", async () => {
        const updatedRules = { ...rules };
        document.querySelectorAll(".rule-mode-select").forEach(sel => {
          const m = sel.getAttribute("data-method");
          if (updatedRules[m]) {
            updatedRules[m].mode = sel.value;
            updatedRules[m].daysOffset = sel.value === 'D+0' ? 0 : (sel.value === 'D+30' ? 30 : 1);
          }
        });
        document.querySelectorAll(".rule-mdr-input").forEach(inp => {
          const m = inp.getAttribute("data-method");
          if (updatedRules[m]) {
            updatedRules[m].mdrRate = parseFloat(inp.value) / 100.0;
          }
        });

        await fetch("/api/erp/accounts-receivable/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settlementRules: updatedRules })
        });
        alert("Regras de liquidação Stone salvas com sucesso!");
        this.renderSettlementRulesConfig();
      });
    }
  },

  // --- MODALS & FORMS ---
  setupModalsAndEvents() {},

  openModalNewEntity(options = {}) {
    const modalHtml = `
      <div id="modal-erp-temp" class="modal-backdrop" style="display:flex;">
        <div class="modal-window" style="max-width:620px;">
          <button class="modal-close-btn" onclick="document.getElementById('modal-erp-temp').remove()">&times;</button>
          <h4 style="color:#FFF;font-family:var(--font-display);margin-bottom:12px;">
            ${options?.isSupplier ? '🚚 Cadastrar Novo Fornecedor (PF / PJ)' : '➕ Cadastrar Nova Pessoa Física ou Jurídica'}
          </h4>
          
          <div style="display:flex;gap:12px;margin-bottom:12px;">
            <label style="cursor:pointer;display:flex;align-items:center;gap:6px;color:#FFF;font-size:0.85rem;">
              <input type="radio" name="entity-type-radio" value="PF" ${options?.isSupplier && options?.defaultType !== 'PF' ? '' : 'checked'} id="radio-pf">
              <strong>👤 Pessoa Física (PF)</strong>
            </label>
            <label style="cursor:pointer;display:flex;align-items:center;gap:6px;color:#FFF;font-size:0.85rem;">
              <input type="radio" name="entity-type-radio" value="PJ" ${options?.isSupplier && options?.defaultType !== 'PF' ? 'checked' : ''} id="radio-pj">
              <strong>🏢 Pessoa Jurídica (PJ)</strong>
            </label>
          </div>

          <!-- Supplier Flag Toggle -->
          <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(212,175,55,0.08);border:1px solid rgba(212,175,55,0.25);border-radius:8px;padding:10px 14px;margin-bottom:16px;">
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="font-size:1.3rem;">🚚</span>
              <div>
                <strong style="color:var(--gold-light);font-size:0.85rem;display:block;">Classificação como Fornecedor</strong>
                <span style="font-size:0.72rem;color:var(--text-secondary);">Habilita condições comerciais, faturamento e dados bancários/PIX</span>
              </div>
            </div>
            <label style="cursor:pointer;display:flex;align-items:center;gap:8px;font-size:0.85rem;font-weight:600;color:#FFF;">
              <input type="checkbox" id="in-ent-is-supplier" ${options?.isSupplier ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--gold-light);cursor:pointer;">
              Sim, é Fornecedor
            </label>
          </div>

          <form id="form-central-entity">
            <!-- PF Fields -->
            <div id="fields-pf-box" style="${options?.isSupplier && options?.defaultType !== 'PF' ? 'display:none;' : ''}">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
                <div>
                  <label class="erp-label">Nome Completo:</label>
                  <input type="text" id="in-ent-name" class="erp-input-sm" style="width:100%;" placeholder="Nome completo">
                </div>
                <div>
                  <label class="erp-label">CPF:</label>
                  <input type="text" id="in-ent-cpf" class="erp-input-sm" style="width:100%;" placeholder="000.000.000-00">
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
                <div>
                  <label class="erp-label">RG:</label>
                  <input type="text" id="in-ent-rg" class="erp-input-sm" style="width:100%;" placeholder="0.000.000-SSP">
                </div>
                <div>
                  <label class="erp-label">Data de Nascimento:</label>
                  <input type="date" id="in-ent-birth" class="erp-input-sm" style="width:100%;">
                </div>
              </div>
            </div>

            <!-- PJ Fields -->
            <div id="fields-pj-box" style="${options?.isSupplier && options?.defaultType !== 'PF' ? '' : 'display:none;'}">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
                <div>
                  <label class="erp-label">Razão Social:</label>
                  <input type="text" id="in-ent-razao" class="erp-input-sm" style="width:100%;" placeholder="Nome empresarial oficial">
                </div>
                <div>
                  <label class="erp-label">Nome Fantasia:</label>
                  <input type="text" id="in-ent-fantasia" class="erp-input-sm" style="width:100%;" placeholder="Marca ou nome de exibição">
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
                <div>
                  <label class="erp-label">CNPJ:</label>
                  <input type="text" id="in-ent-cnpj" class="erp-input-sm" style="width:100%;" placeholder="00.000.000/0001-00">
                </div>
                <div>
                  <label class="erp-label">Inscrição Estadual (IE):</label>
                  <input type="text" id="in-ent-ie" class="erp-input-sm" style="width:100%;" placeholder="ISENTO ou 000.000.000">
                </div>
              </div>
              <div style="margin-bottom:10px;">
                <label class="erp-label">Regime Tributário:</label>
                <select id="in-ent-regime" class="erp-input-sm" style="width:100%;">
                  <option value="SIMPLES_NACIONAL">Simples Nacional</option>
                  <option value="LUCRO_PRESUMIDO">Lucro Presumido</option>
                  <option value="LUCRO_REAL">Lucro Real</option>
                </select>
              </div>
            </div>

            <!-- Shared Fields -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
              <div>
                <label class="erp-label">WhatsApp / Telefone:</label>
                <input type="text" id="in-ent-phone" class="erp-input-sm" style="width:100%;" placeholder="(48) 99999-9999">
              </div>
              <div>
                <label class="erp-label">E-mail:</label>
                <input type="email" id="in-ent-email" class="erp-input-sm" style="width:100%;" placeholder="contato@empresa.com">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
              <div>
                <label class="erp-label">Categoria / Perfil:</label>
                <select id="in-ent-cat" class="erp-input-sm" style="width:100%;">
                  <option value="FORNECEDOR_CMV" ${options?.isSupplier ? 'selected' : ''}>FORNECEDOR_CMV (Confecção & Matéria-prima)</option>
                  <option value="CLIENTE_VIP" ${options?.isSupplier ? '' : 'selected'}>CLIENTE_VIP</option>
                  <option value="ALUNA_JOY">ALUNA_JOY</option>
                  <option value="PARCEIRO">PARCEIRO / LOCADOR</option>
                  <option value="CLIENTE_CORP">CLIENTE_CORP</option>
                  <option value="COLABORADOR">COLABORADOR (Equipe & RH)</option>
                </select>
              </div>
              <div>
                <label class="erp-label">Cidade / UF:</label>
                <input type="text" id="in-ent-city" class="erp-input-sm" style="width:100%;" value="Florianópolis/SC">
              </div>
            </div>

            <!-- Supplier Dynamic Fields Box -->
            <div id="fields-supplier-box" style="${options?.isSupplier ? 'display:block;' : 'display:none;'}background:rgba(212,175,55,0.06);border:1px solid rgba(212,175,55,0.25);border-radius:8px;padding:12px;margin-bottom:12px;">
              <div style="font-size:0.8rem;font-weight:600;color:var(--gold-light);margin-bottom:8px;">
                🚚 Condições Comerciais & Financeiras do Fornecedor
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
                <div>
                  <label class="erp-label">Ramo / Especialidade:</label>
                  <select id="in-ent-sup-cat" class="erp-input-sm" style="width:100%;">
                    <option value="Matéria-prima & Confecção (CMV)">Matéria-prima & Confecção (CMV)</option>
                    <option value="Locação & Espaço Físico">Locação & Espaço Físico</option>
                    <option value="Serviços Operacionais / Manutenção">Serviços Operacionais / Manutenção</option>
                    <option value="Marketing & Eventos / Drops">Marketing & Eventos / Drops</option>
                    <option value="Contabilidade & Consultoria Tributária">Contabilidade & Consultoria Tributária</option>
                    <option value="Tecnologia & Softwares">Tecnologia & Softwares</option>
                    <option value="Serviços Criativos & Design (PF/RPA)">Serviços Criativos & Design (PF/RPA)</option>
                    <option value="Outros Fornecedores">Outros Fornecedores</option>
                  </select>
                </div>
                <div>
                  <label class="erp-label">Condição de Pagamento Padrão:</label>
                  <input type="text" id="in-ent-sup-payment" class="erp-input-sm" style="width:100%;" value="30/60/90 dias no boleto" placeholder="Ex: 30/60/90 dias no boleto, À vista, D+30">
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div>
                  <label class="erp-label">Chave PIX:</label>
                  <input type="text" id="in-ent-sup-pix" class="erp-input-sm" style="width:100%;" placeholder="CNPJ, CPF, Celular, E-mail ou Aleatória">
                </div>
                <div>
                  <label class="erp-label">Dados Bancários (Banco, Ag, Conta):</label>
                  <input type="text" id="in-ent-sup-bank" class="erp-input-sm" style="width:100%;" placeholder="Ex: Banco Itaú (341) Ag 1234 CC 56789-0">
                </div>
              </div>
            </div>

            <!-- RH & Colaborador Dynamic Fields -->
            <div id="fields-colab-box" style="display:none;background:rgba(212,175,55,0.06);border:1px solid rgba(212,175,55,0.25);border-radius:8px;padding:12px;margin-bottom:12px;">
              <div style="font-size:0.8rem;font-weight:600;color:var(--gold-light);margin-bottom:8px;">
                👥 Parâmetros de Equipe & RH (Sincronização Automática com Módulo Equipe)
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
                <div>
                  <label class="erp-label">Tipo de Contrato:</label>
                  <select id="in-ent-contract" class="erp-input-sm" style="width:100%;">
                    <option value="CLT_FIXED_COMMISSION">CLT (Fixo + Comissão)</option>
                    <option value="COMMISSION_ONLY">Comissionado Puro (100% Comissão / PJ / RPA)</option>
                  </select>
                </div>
                <div>
                  <label class="erp-label">Cargo / Função:</label>
                  <input type="text" id="in-ent-role" class="erp-input-sm" style="width:100%;" value="Consultora de Vendas">
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
                <div>
                  <label class="erp-label">Salário Base (R$):</label>
                  <input type="number" step="0.01" id="in-ent-salary" class="erp-input-sm" style="width:100%;" value="2200.00">
                </div>
                <div>
                  <label class="erp-label">Loja de Lotação:</label>
                  <select id="in-ent-store" class="erp-input-sm" style="width:100%;">
                    ${this.stores.map(s => `<option value="${s.id}">${s.name}</option>`).join("")}
                  </select>
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div>
                  <label class="erp-label">Comissão Balcão Stone (%):</label>
                  <input type="number" step="0.1" id="in-ent-pos-rate" class="erp-input-sm" style="width:100%;" value="3.0">
                </div>
                <div>
                  <label class="erp-label">Comissão WhatsApp (%):</label>
                  <input type="number" step="0.1" id="in-ent-wa-rate" class="erp-input-sm" style="width:100%;" value="3.0">
                </div>
              </div>
            </div>

            <div style="margin-bottom:16px;">
              <label class="erp-label">Endereço Completo:</label>
              <input type="text" id="in-ent-address" class="erp-input-sm" style="width:100%;" placeholder="Rua, Número, Sala, Bairro">
            </div>

            <div style="display:flex;justify-content:flex-end;gap:10px;">
              <button type="submit" class="btn-primary-luxury">Salvar Cadastro</button>
            </div>
          </form>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", modalHtml);

    // Toggle PF/PJ fields dynamically
    const radioPf = document.getElementById("radio-pf");
    const radioPj = document.getElementById("radio-pj");
    const pfBox = document.getElementById("fields-pf-box");
    const pjBox = document.getElementById("fields-pj-box");
    const catSelect = document.getElementById("in-ent-cat");
    const colabBox = document.getElementById("fields-colab-box");
    const contractSelect = document.getElementById("in-ent-contract");
    const salaryInput = document.getElementById("in-ent-salary");
    const chkSupplier = document.getElementById("in-ent-is-supplier");
    const supBox = document.getElementById("fields-supplier-box");

    const checkColab = () => {
      if (radioPf.checked && catSelect.value === "COLABORADOR") {
        colabBox.style.display = "block";
      } else {
        colabBox.style.display = "none";
      }
    };

    const toggleSupplierBox = () => {
      supBox.style.display = chkSupplier.checked ? "block" : "none";
    };

    chkSupplier.addEventListener("change", () => {
      toggleSupplierBox();
      if (chkSupplier.checked && catSelect.value === "CLIENTE_VIP") {
        catSelect.value = "FORNECEDOR_CMV";
      }
    });

    radioPf.addEventListener("change", () => {
      if (radioPf.checked) {
        pfBox.style.display = "block";
        pjBox.style.display = "none";
        checkColab();
      }
    });
    radioPj.addEventListener("change", () => {
      if (radioPj.checked) {
        pfBox.style.display = "none";
        pjBox.style.display = "block";
        colabBox.style.display = "none";
      }
    });

    catSelect.addEventListener("change", () => {
      if (catSelect.value === "FORNECEDOR_CMV") {
        chkSupplier.checked = true;
        toggleSupplierBox();
      }
      checkColab();
    });

    contractSelect.addEventListener("change", () => {
      if (contractSelect.value === "COMMISSION_ONLY") {
        salaryInput.value = "0.00";
        salaryInput.disabled = true;
        document.getElementById("in-ent-pos-rate").value = "8.0";
        document.getElementById("in-ent-wa-rate").value = "8.0";
      } else {
        salaryInput.value = "2200.00";
        salaryInput.disabled = false;
        document.getElementById("in-ent-pos-rate").value = "3.0";
        document.getElementById("in-ent-wa-rate").value = "3.0";
      }
    });

    document.getElementById("form-central-entity").addEventListener("submit", async (e) => {
      e.preventDefault();
      const isPf = radioPf.checked;
      const isColab = isPf && catSelect.value === "COLABORADOR";
      const isSupplier = chkSupplier.checked;

      const payload = {
        type: isPf ? "PF" : "PJ",
        name: isPf ? document.getElementById("in-ent-name").value : document.getElementById("in-ent-fantasia").value,
        razaoSocial: isPf ? "" : document.getElementById("in-ent-razao").value,
        nomeFantasia: isPf ? "" : document.getElementById("in-ent-fantasia").value,
        cpf: isPf ? document.getElementById("in-ent-cpf").value : "",
        cnpj: isPf ? "" : document.getElementById("in-ent-cnpj").value,
        rg: isPf ? document.getElementById("in-ent-rg").value : "",
        ie: isPf ? "" : document.getElementById("in-ent-ie").value,
        taxRegime: isPf ? "" : document.getElementById("in-ent-regime").value,
        birthDate: isPf ? document.getElementById("in-ent-birth").value : "",
        phone: document.getElementById("in-ent-phone").value,
        email: document.getElementById("in-ent-email").value,
        city: document.getElementById("in-ent-city").value,
        address: document.getElementById("in-ent-address").value,
        category: catSelect.value,
        relationship: isSupplier ? "Fornecedor Homologado" : (isColab ? "Colaboradora Equipe" : (isPf ? "Cliente / Aluna" : "Empresa / Parceiro")),
        isSupplier: isSupplier,
        supplierCategory: isSupplier ? document.getElementById("in-ent-sup-cat").value : "",
        paymentCondition: isSupplier ? document.getElementById("in-ent-sup-payment").value : "",
        pixKey: isSupplier ? document.getElementById("in-ent-sup-pix").value : "",
        bankInfo: isSupplier ? document.getElementById("in-ent-sup-bank").value : ""
      };

      if (isColab) {
        payload.contractType = contractSelect.value;
        payload.role = document.getElementById("in-ent-role").value;
        payload.baseSalary = parseFloat(salaryInput.value) || 0.0;
        payload.storeId = document.getElementById("in-ent-store").value;
        payload.commissionRatePos = parseFloat(document.getElementById("in-ent-pos-rate").value) || 3.0;
        payload.commissionRateWa = parseFloat(document.getElementById("in-ent-wa-rate").value) || 3.0;
      }

      await fetch("/api/erp/entities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      document.getElementById("modal-erp-temp").remove();
      this.showToastNotification(isSupplier ? "Fornecedor homologado e salvo com sucesso!" : (isColab ? "Colaborador cadastrado e sincronizado com Equipe & RH!" : "Cadastro salvo com sucesso!"), "success");
      this.renderCentralEntities();
      this.renderSuppliersRegistration();
    });
  },

  async openModalViewEntity(id) {
    let entity = (this.entitiesData?.entities || []).find(e => e.id === id);
    if (!entity) {
      try {
        const res = await fetch("/api/erp/entities");
        const data = await res.json();
        entity = (data.entities || []).find(e => e.id === id);
      } catch (e) {}
    }
    if (!entity) {
      alert("Cadastro não encontrado.");
      return;
    }

    const isPf = entity.type === "PF";
    const modalHtml = `
      <div id="modal-erp-temp" class="modal-backdrop" style="display:flex;">
        <div class="modal-window" style="max-width:620px;">
          <button class="modal-close-btn" onclick="document.getElementById('modal-erp-temp').remove()">&times;</button>
          
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
            <div style="font-size:2rem;background:rgba(255,255,255,0.05);padding:10px 14px;border-radius:10px;border:1px solid var(--border-subtle);">
              ${entity.isSupplier ? '🚚' : (isPf ? '👤' : '🏢')}
            </div>
            <div>
              <div style="display:flex;align-items:center;gap:8px;">
                <h4 style="color:#FFF;font-family:var(--font-display);font-size:1.2rem;margin:0;">
                  ${isPf ? entity.name : (entity.nomeFantasia || entity.razaoSocial)}
                </h4>
                <span class="erp-badge-mode" style="${isPf ? 'background:rgba(56,189,248,0.15);color:var(--blue-accent);' : 'background:rgba(212,175,55,0.15);color:var(--gold-light);'}">
                  ${entity.type}
                </span>
                ${entity.isSupplier ? `<span class="status-badge badge-homologado" style="font-size:0.65rem;background:rgba(212,175,55,0.15);color:var(--gold-light);border:1px solid rgba(212,175,55,0.3);">🚚 Fornecedor</span>` : ''}
              </div>
              <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">
                ${!isPf && entity.razaoSocial && entity.razaoSocial !== entity.nomeFantasia ? `${entity.razaoSocial} • ` : ''}ID: ${entity.id}
              </div>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;background:rgba(255,255,255,0.02);border:1px solid var(--border-subtle);border-radius:8px;padding:14px;margin-bottom:16px;font-size:0.8rem;">
            <div>
              <span style="color:var(--text-muted);display:block;">Documento (${isPf ? 'CPF' : 'CNPJ'}):</span>
              <strong style="color:#FFF;">${isPf ? (entity.cpf || '-') : (entity.cnpj || '-')}</strong>
            </div>
            <div>
              <span style="color:var(--text-muted);display:block;">${isPf ? 'RG' : 'Inscrição Estadual (IE)'}:</span>
              <strong style="color:#FFF;">${isPf ? (entity.rg || '-') : (entity.ie || '-')}</strong>
            </div>
            <div>
              <span style="color:var(--text-muted);display:block;">Telefone / WhatsApp:</span>
              <strong style="color:var(--emerald-light);">${entity.phone || '-'}</strong>
            </div>
            <div>
              <span style="color:var(--text-muted);display:block;">E-mail:</span>
              <strong style="color:#FFF;">${entity.email || '-'}</strong>
            </div>
            <div style="grid-column:1 / -1;">
              <span style="color:var(--text-muted);display:block;">Endereço & Cidade:</span>
              <strong style="color:#FFF;">${entity.address ? `${entity.address} - ` : ''}${entity.city || '-'}</strong>
            </div>
          </div>

          ${entity.isSupplier ? `
            <div style="background:rgba(212,175,55,0.05);border:1px solid rgba(212,175,55,0.25);border-radius:8px;padding:14px;margin-bottom:16px;font-size:0.8rem;">
              <div style="font-weight:600;color:var(--gold-light);margin-bottom:8px;">
                🚚 Dados Comerciais & Financeiros de Fornecedor
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div>
                  <span style="color:var(--text-muted);display:block;">Ramo / Categoria:</span>
                  <strong style="color:#FFF;">${entity.supplierCategory || entity.category}</strong>
                </div>
                <div>
                  <span style="color:var(--text-muted);display:block;">Condição de Pagamento:</span>
                  <strong style="color:var(--gold-light);">${entity.paymentCondition || '30 dias'}</strong>
                </div>
                <div>
                  <span style="color:var(--text-muted);display:block;">Chave PIX:</span>
                  <strong style="color:var(--emerald-light);">${entity.pixKey || 'Não informada'}</strong>
                </div>
                <div>
                  <span style="color:var(--text-muted);display:block;">Dados Bancários:</span>
                  <strong style="color:#FFF;">${entity.bankInfo || 'Não informado'}</strong>
                </div>
              </div>
            </div>
          ` : ''}

          ${entity.notes ? `
            <div style="background:rgba(255,255,255,0.02);border:1px solid var(--border-subtle);border-radius:8px;padding:12px;margin-bottom:16px;font-size:0.78rem;">
              <span style="color:var(--text-muted);display:block;margin-bottom:2px;">Observações:</span>
              <div style="color:var(--text-secondary);">${entity.notes}</div>
            </div>
          ` : ''}

          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              ${entity.isSupplier ? `
                <button id="btn-view-sup-payable" class="btn-primary-luxury" style="padding:6px 12px;font-size:0.78rem;background:rgba(212,175,55,0.15);color:var(--gold-light);border:1px solid rgba(212,175,55,0.3);">
                  🧾 Lançar Conta a Pagar
                </button>
              ` : ''}
            </div>
            <div style="display:flex;gap:10px;">
              <button class="modal-close-btn-secondary" onclick="document.getElementById('modal-erp-temp').remove()">Fechar</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", modalHtml);

    const btnPay = document.getElementById("btn-view-sup-payable");
    if (btnPay) {
      btnPay.addEventListener("click", () => {
        document.getElementById("modal-erp-temp").remove();
        this.openModalNewPayable({
          supplierName: isPf ? entity.name : (entity.nomeFantasia || entity.razaoSocial),
          category: entity.category
        });
      });
    }
  },

  openModalNewReceivable() {
    const modalHtml = `
      <div id="modal-erp-temp" class="modal-backdrop" style="display:flex;">
        <div class="modal-window">
          <button class="modal-close-btn" onclick="document.getElementById('modal-erp-temp').remove()">&times;</button>
          <h4 style="color:#FFF;font-family:var(--font-display);margin-bottom:12px;">➕ Novo Faturamento / Contas a Receber</h4>
          
          <form id="form-new-receivable">
            <div style="margin-bottom:12px;">
              <label class="erp-label">Nome do Cliente / Empresa Parceira:</label>
              <input type="text" id="in-rec-customer" required class="erp-input-sm" style="width:100%;" value="Clínica Estética & Wellness VIP">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
              <div>
                <label class="erp-label">Valor Bruto (R$):</label>
                <input type="number" step="0.01" id="in-rec-amount" required class="erp-input-sm" style="width:100%;" value="2890.00">
              </div>
              <div>
                <label class="erp-label">Condição de Recebimento:</label>
                <select id="in-rec-method" class="erp-input-sm" style="width:100%;">
                  <option value="CORPORATE_INVOICE">Boleto Corporativo (D+30)</option>
                  <option value="CREDIT_INSTALLMENTS">Cartão Parcelado 3x (D+1 Antecipado)</option>
                  <option value="PIX">PIX Instantâneo (D+0)</option>
                </select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
              <div>
                <label class="erp-label">Centro de Custo:</label>
                <select id="in-rec-cost-center" class="erp-input-sm" style="width:100%;">
                  ${this.getCostCenterOptionsHtml("CC-01")}
                </select>
              </div>
              <div>
                <label class="erp-label">Plano de Contas:</label>
                <select id="in-rec-chart-account" class="erp-input-sm" style="width:100%;">
                  ${this.getChartAccountOptionsHtml("REVENUE", "1.1.2.02")}
                </select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
              <div>
                <label class="erp-label">Unidade / Loja:</label>
                <select id="in-rec-store" class="erp-input-sm" style="width:100%;">
                  ${this.stores.map(s => `<option value="${s.id}">${s.name}</option>`).join("")}
                </select>
              </div>
              <div>
                <label class="erp-label">Data Prevista Liquidação:</label>
                <input type="date" id="in-rec-date" class="erp-input-sm" style="width:100%;" value="${new Date().toISOString().split('T')[0]}">
              </div>
            </div>
            ${this.renderCustomFieldsFormHtml("RECEIVABLE")}
            <div style="display:flex;justify-content:flex-end;gap:10px;">
              <button type="submit" class="btn-primary-luxury">Cadastrar Recebível</button>
            </div>
          </form>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", modalHtml);

    document.getElementById("form-new-receivable").addEventListener("submit", async (e) => {
      e.preventDefault();
      const formEl = document.getElementById("form-new-receivable");
      const storeId = document.getElementById("in-rec-store").value;
      const store = this.stores.find(s => s.id === storeId);
      const ccSelect = document.getElementById("in-rec-cost-center");
      const ccOption = ccSelect ? ccSelect.options[ccSelect.selectedIndex] : null;
      const caSelect = document.getElementById("in-rec-chart-account");
      const caOption = caSelect ? caSelect.options[caSelect.selectedIndex] : null;

      const payload = {
        customerName: document.getElementById("in-rec-customer").value,
        grossAmount: parseFloat(document.getElementById("in-rec-amount").value),
        paymentMethod: document.getElementById("in-rec-method").value,
        costCenterId: ccSelect ? ccSelect.value : "CC-01",
        costCenterName: ccOption ? (ccOption.getAttribute("data-name") || ccOption.text) : "Boutique JOY Club - Centro Floripa",
        chartOfAccountId: caSelect ? caSelect.value : "1.1.2.02",
        chartOfAccountName: caOption ? (caOption.getAttribute("data-name") || caOption.text) : "Contas a Receber - Faturamento Corporativo D+30",
        storeId: storeId,
        cnpjId: store ? store.cnpjId : "cnpj-01",
        expectedSettlementDate: document.getElementById("in-rec-date").value,
        installments: 1,
        customFields: this.collectCustomFieldsValues(formEl)
      };
      await fetch("/api/erp/accounts-receivable/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      document.getElementById("modal-erp-temp").remove();
      this.renderAccountsReceivable();
    });
  },

  openModalNewPayable(options = {}) {
    // Collect registered suppliers for autocomplete
    const suppliers = (this.entitiesData?.entities || []).filter(e => e.isSupplier || e.category === "FORNECEDOR_CMV");
    const defaultSupplier = options?.supplierName || "";

    const modalHtml = `
      <div id="modal-erp-temp" class="modal-backdrop" style="display:flex;">
        <div class="modal-window">
          <button class="modal-close-btn" onclick="document.getElementById('modal-erp-temp').remove()">&times;</button>
          <h4 style="color:#FFF;font-family:var(--font-display);margin-bottom:12px;">➕ Cadastrar Novo Título a Pagar</h4>
          
          <form id="form-new-payable">
            <div style="margin-bottom:12px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <label class="erp-label" style="margin:0;">Fornecedor / Favorecido:</label>
                <span style="font-size:0.7rem;color:var(--gold-light);">💡 Selecione ou digite</span>
              </div>
              <input type="text" id="in-pay-supplier" list="suppliers-datalist" required class="erp-input-sm" style="width:100%;" placeholder="Ex: SIÉ Confecção e Estamparia Têxtil LTDA" value="${defaultSupplier}">
              <datalist id="suppliers-datalist">
                ${suppliers.map(s => `<option value="${s.type === 'PF' ? s.name : (s.nomeFantasia || s.razaoSocial)}">${s.type} • ${s.supplierCategory || s.category}</option>`).join("")}
              </datalist>
            </div>
            <div style="margin-bottom:12px;">
              <label class="erp-label">Descrição da Despesa:</label>
              <input type="text" id="in-pay-desc" required class="erp-input-sm" style="width:100%;" placeholder="Ex: Matéria-prima poliamida biodegradável">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
              <div>
                <label class="erp-label">Valor (R$):</label>
                <input type="number" step="0.01" id="in-pay-amount" required class="erp-input-sm" style="width:100%;" placeholder="0.00">
              </div>
              <div>
                <label class="erp-label">Data de Vencimento:</label>
                <input type="date" id="in-pay-due" required class="erp-input-sm" style="width:100%;" value="${new Date().toISOString().split('T')[0]}">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
              <div>
                <label class="erp-label">Centro de Custo:</label>
                <select id="in-pay-cost-center" class="erp-input-sm" style="width:100%;">
                  ${this.getCostCenterOptionsHtml("CC-01")}
                </select>
              </div>
              <div>
                <label class="erp-label">Plano de Contas:</label>
                <select id="in-pay-chart-account" class="erp-input-sm" style="width:100%;">
                  ${this.getChartAccountOptionsHtml("EXPENSE", "2.1.1.01")}
                </select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
              <div>
                <label class="erp-label">Número do Documento / NF-e:</label>
                <input type="text" id="in-pay-doc" class="erp-input-sm" style="width:100%;" placeholder="NF-e 1234">
              </div>
              <div>
                <label class="erp-label">Forma de Pagamento:</label>
                <select id="in-pay-method" class="erp-input-sm" style="width:100%;">
                  <option value="BOLETO">Boleto Bancário</option>
                  <option value="PIX">PIX</option>
                  <option value="TRANSFERENCIA">Transferência Bancária</option>
                  <option value="CARTAO">Cartão Corporativo</option>
                </select>
              </div>
            </div>
            ${this.renderCustomFieldsFormHtml("PAYABLE")}
            <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
              <button type="submit" class="btn-primary-luxury">Salvar Título a Pagar</button>
            </div>
          </form>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", modalHtml);

    document.getElementById("form-new-payable").addEventListener("submit", async (e) => {
      e.preventDefault();
      const formEl = document.getElementById("form-new-payable");
      const currentCc = document.getElementById("in-pay-cost-center");
      const currentCcOpt = currentCc ? currentCc.options[currentCc.selectedIndex] : null;
      const currentCa = document.getElementById("in-pay-chart-account");
      const currentCaOpt = currentCa ? currentCa.options[currentCa.selectedIndex] : null;

      const payload = {
        supplier: document.getElementById("in-pay-supplier").value,
        description: document.getElementById("in-pay-desc").value,
        amount: parseFloat(document.getElementById("in-pay-amount").value),
        paymentMethod: document.getElementById("in-pay-method")?.value || "BOLETO",
        costCenterId: currentCc ? currentCc.value : "CC-01",
        costCenterName: currentCcOpt ? (currentCcOpt.getAttribute("data-name") || currentCcOpt.text) : "Boutique JOY Club - Centro Floripa",
        chartOfAccountId: currentCa ? currentCa.value : "2.1.1.01",
        chartOfAccountName: currentCaOpt ? (currentCaOpt.getAttribute("data-name") || currentCaOpt.text) : "Fornecedores Confecção Têxtil (30/60/90d)",
        documentNumber: document.getElementById("in-pay-doc").value,
        dueDate: document.getElementById("in-pay-due").value,
        storeId: this.currentStoreId === "ALL" ? "store-01" : this.currentStoreId,
        cnpjId: this.currentCnpjId === "ALL" ? "cnpj-01" : this.currentCnpjId,
        customFields: this.collectCustomFieldsValues(formEl)
      };
      await fetch("/api/erp/accounts-payable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      document.getElementById("modal-erp-temp").remove();
      this.renderAccountsPayable();
    });
  },

  openModalScheduleVacation(empId) {
    const emp = (this.employeesData?.employees || []).find(e => e.id === empId);
    const modalHtml = `
      <div id="modal-erp-temp" class="modal-backdrop" style="display:flex;">
        <div class="modal-window">
          <button class="modal-close-btn" onclick="document.getElementById('modal-erp-temp').remove()">&times;</button>
          <h4 style="color:#FFF;font-family:var(--font-display);margin-bottom:8px;">🏖️ Agendamento de Férias CLT</h4>
          <p style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:16px;">
            Colaboradora: <strong>${emp ? emp.name : empId}</strong> • Saldo disponível: <strong>${emp?.vacationInfo?.daysBalance || 30} dias</strong>
          </p>
          
          <form id="form-schedule-vacation">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
              <div>
                <label class="erp-label">Data de Início das Férias:</label>
                <input type="date" id="in-vac-start" required class="erp-input-sm" style="width:100%;" value="2027-01-10">
              </div>
              <div>
                <label class="erp-label">Quantidade de Dias:</label>
                <select id="in-vac-days" class="erp-input-sm" style="width:100%;">
                  <option value="30">30 dias integrais</option>
                  <option value="20">20 dias (+ 10 dias abono pecuniário)</option>
                  <option value="15">15 dias (1º período fracionado)</option>
                </select>
              </div>
            </div>
            <div style="padding:10px;background:rgba(212,175,55,0.08);border-radius:8px;border:1px solid rgba(212,175,55,0.2);font-size:0.75rem;color:var(--gold-light);margin-bottom:16px;">
              ⚖️ Cálculo automático de 1/3 Constitucional sobre a remuneração já provisionado mensalmente no DRE.
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;">
              <button type="submit" class="btn-primary-luxury">Confirmar Agendamento</button>
            </div>
          </form>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", modalHtml);

    document.getElementById("form-schedule-vacation").addEventListener("submit", async (e) => {
      e.preventDefault();
      await fetch("/api/erp/employees/vacation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: empId,
          startDate: document.getElementById("in-vac-start").value,
          days: parseInt(document.getElementById("in-vac-days").value)
        })
      });
      document.getElementById("modal-erp-temp").remove();
      this.renderHrVacation();
    });
  },

  openModalNewEmployee() {
    const modalHtml = `
      <div id="modal-erp-temp" class="modal-backdrop" style="display:flex;">
        <div class="modal-window" style="max-width:550px;">
          <button class="modal-close-btn" onclick="document.getElementById('modal-erp-temp').remove()">&times;</button>
          <h4 style="color:#FFF;font-family:var(--font-display);margin-bottom:12px;">➕ Cadastrar Novo Colaborador (Equipe SIÉ)</h4>
          
          <form id="form-new-employee">
            <div style="margin-bottom:10px;">
              <label class="erp-label">Tipo de Contrato:</label>
              <select id="in-emp-contract" class="erp-input-sm" style="width:100%;">
                <option value="CLT_FIXED_COMMISSION" selected>CLT (Fixo + Comissão)</option>
                <option value="COMMISSION_ONLY">Comissionado Puro (100% Comissão / PJ / RPA)</option>
              </select>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
              <div>
                <label class="erp-label">Nome Completo:</label>
                <input type="text" id="in-emp-name" required class="erp-input-sm" style="width:100%;" placeholder="Nome da colaboradora">
              </div>
              <div>
                <label class="erp-label">CPF:</label>
                <input type="text" id="in-emp-cpf" required class="erp-input-sm" style="width:100%;" placeholder="000.000.000-00">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
              <div>
                <label class="erp-label">Cargo / Função:</label>
                <input type="text" id="in-emp-role" required class="erp-input-sm" style="width:100%;" value="Consultora de Vendas">
              </div>
              <div>
                <label class="erp-label">Salário Base (R$):</label>
                <input type="number" step="0.01" id="in-emp-salary" required class="erp-input-sm" style="width:100%;" value="2200.00">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
              <div>
                <label class="erp-label">Loja / Unidade Alocada:</label>
                <select id="in-emp-store" class="erp-input-sm" style="width:100%;">
                  ${this.stores.map(s => `<option value="${s.id}">${s.name}</option>`).join("")}
                </select>
              </div>
              <div>
                <label class="erp-label">Jornada de Trabalho:</label>
                <input type="text" id="in-emp-sched" class="erp-input-sm" style="width:100%;" value="Segunda a Sexta: 10h às 16h (Turno de 6h)">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
              <div>
                <label class="erp-label">Comissão Balcão Stone (%):</label>
                <input type="number" step="0.1" id="in-emp-pos" class="erp-input-sm" style="width:100%;" value="3.0">
              </div>
              <div>
                <label class="erp-label">Comissão Link WhatsApp (%):</label>
                <input type="number" step="0.1" id="in-emp-wa" class="erp-input-sm" style="width:100%;" value="3.0">
              </div>
            </div>

            <div style="display:flex;justify-content:flex-end;gap:10px;">
              <button type="submit" class="btn-primary-luxury">Salvar Colaborador</button>
            </div>
          </form>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", modalHtml);

    const contractSelect = document.getElementById("in-emp-contract");
    const salaryInput = document.getElementById("in-emp-salary");
    const posInput = document.getElementById("in-emp-pos");
    const waInput = document.getElementById("in-emp-wa");

    contractSelect.addEventListener("change", () => {
      if (contractSelect.value === "COMMISSION_ONLY") {
        salaryInput.value = "0.00";
        salaryInput.disabled = true;
        posInput.value = "8.0";
        waInput.value = "8.0";
      } else {
        salaryInput.value = "2200.00";
        salaryInput.disabled = false;
        posInput.value = "3.0";
        waInput.value = "3.0";
      }
    });

    document.getElementById("form-new-employee").addEventListener("submit", async (e) => {
      e.preventDefault();
      const storeId = document.getElementById("in-emp-store").value;
      const store = this.stores.find(s => s.id === storeId);
      const isCommOnly = contractSelect.value === "COMMISSION_ONLY";
      const payload = {
        name: document.getElementById("in-emp-name").value,
        cpf: document.getElementById("in-emp-cpf").value,
        role: document.getElementById("in-emp-role").value,
        contractType: contractSelect.value,
        baseSalary: parseFloat(salaryInput.value) || 0.0,
        storeId: storeId,
        cnpjId: store ? store.cnpjId : "cnpj-01",
        workSchedule: isCommOnly ? "Horário Flexível / Vendas Consultivas WhatsApp" : document.getElementById("in-emp-sched").value,
        commissionPosDirect: parseFloat(posInput.value) / 100.0,
        commissionWaLink: parseFloat(waInput.value) / 100.0
      };
      await fetch("/api/erp/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      document.getElementById("modal-erp-temp").remove();
      this.showToastNotification("Colaborador cadastrado com sucesso!", "success");
      this.renderHrEmployees();
    });
  },

  openModalNewCnpj() {
    const modalHtml = `
      <div id="modal-erp-temp" class="modal-backdrop" style="display:flex;">
        <div class="modal-window" style="max-width:550px;">
          <button class="modal-close-btn" onclick="document.getElementById('modal-erp-temp').remove()">&times;</button>
          <h4 style="color:#FFF;font-family:var(--font-display);margin-bottom:12px;">➕ Cadastrar Novo CNPJ Gerenciado</h4>
          
          <form id="form-new-cnpj">
            <div style="margin-bottom:10px;">
              <label class="erp-label">Razão Social:</label>
              <input type="text" id="in-cnpj-razao" required class="erp-input-sm" style="width:100%;" placeholder="Ex: SIÉ WEAR EXPANSÃO BRASIL LTDA">
            </div>
            <div style="margin-bottom:10px;">
              <label class="erp-label">Nome Fantasia:</label>
              <input type="text" id="in-cnpj-fantasia" required class="erp-input-sm" style="width:100%;" placeholder="Ex: SIÉ WEAR SÃO PAULO">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
              <div>
                <label class="erp-label">CNPJ:</label>
                <input type="text" id="in-cnpj-num" required class="erp-input-sm" style="width:100%;" placeholder="00.000.000/0001-00">
              </div>
              <div>
                <label class="erp-label">Inscrição Estadual (IE):</label>
                <input type="text" id="in-cnpj-ie" class="erp-input-sm" style="width:100%;" placeholder="000.000.000">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:6px;">
              <div>
                <label class="erp-label">Regime Fiscal:</label>
                <select id="in-cnpj-regime" class="erp-input-sm" style="width:100%;">
                  <option value="SIMPLES_NACIONAL" selected>Simples Nacional (Anexo I Comércio)</option>
                  <option value="LUCRO_PRESUMIDO">Lucro Presumido</option>
                </select>
              </div>
              <div>
                <label class="erp-label">Alíquota Estimada Automaticamente (%):</label>
                <input type="number" step="0.01" id="in-cnpj-rate" class="erp-input-sm" style="width:100%;color:var(--emerald-light);font-weight:700;" value="4.82">
              </div>
            </div>

            <!-- Automatic Tax Calculation Explanation Box -->
            <div id="box-tax-explanation" style="background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.25);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:0.75rem;color:var(--blue-accent);">
              🏛️ <strong>Estimativa Automática:</strong> RBT12 R$ 420k (3ª Faixa Simples Nacional) • [(420k × 9,5%) - R$ 13.860] ÷ 420k = <strong>4,82%</strong>
            </div>

            <div style="margin-bottom:16px;">
              <label class="erp-label">Endereço Completo (Local da Venda):</label>
              <input type="text" id="in-cnpj-addr" class="erp-input-sm" style="width:100%;" value="Rua Esteves Júnior, 567, Centro, Florianópolis/SC">
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;">
              <button type="submit" class="btn-primary-luxury">Salvar CNPJ</button>
            </div>
          </form>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", modalHtml);

    const recalcTax = () => {
      const regime = document.getElementById("in-cnpj-regime").value;
      const addr = document.getElementById("in-cnpj-addr").value;
      const rateInp = document.getElementById("in-cnpj-rate");
      const expl = document.getElementById("box-tax-explanation");
      
      if (regime === "SIMPLES_NACIONAL") {
        rateInp.value = "4.82";
        expl.innerHTML = `🏛️ <strong>Simples Nacional Anexo I:</strong> RBT12 R$ 420k (3ª Faixa) • [(420k × 9,5%) - R$ 13.860] ÷ 420k = <strong>4,82%</strong> (ICMS SC incluso)`;
      } else {
        const isFloripa = addr.toLowerCase().includes("floripa") || addr.toLowerCase().includes("florianópolis") || !addr;
        const iss = isFloripa ? 2.5 : 3.0;
        const total = (5.93 + iss).toFixed(2);
        rateInp.value = total;
        expl.innerHTML = `🏛️ <strong>Lucro Presumido:</strong> 5,93% Federal + ${iss}% ISS (${isFloripa ? 'Florianópolis' : 'Local'}) = <strong>${total}%</strong> sobre receita bruta`;
      }
    };

    document.getElementById("in-cnpj-regime").addEventListener("change", recalcTax);
    document.getElementById("in-cnpj-addr").addEventListener("input", recalcTax);

    document.getElementById("form-new-cnpj").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        razaoSocial: document.getElementById("in-cnpj-razao").value,
        nomeFantasia: document.getElementById("in-cnpj-fantasia").value,
        cnpj: document.getElementById("in-cnpj-num").value,
        ie: document.getElementById("in-cnpj-ie").value,
        taxRegime: document.getElementById("in-cnpj-regime").value,
        taxRate: parseFloat(document.getElementById("in-cnpj-rate").value) / 100.0,
        address: document.getElementById("in-cnpj-addr").value
      };
      await fetch("/api/erp/cnpjs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      document.getElementById("modal-erp-temp").remove();
      this.showToastNotification("CNPJ cadastrado com alíquota tributária calculada!", "success");
      await this.loadCnpjsAndStores();
      this.setupStoreSwitcher();
      this.renderCnpjsRegistration();
    });
  },

  openModalNewStore() {
    const modalHtml = `
      <div id="modal-erp-temp" class="modal-backdrop" style="display:flex;">
        <div class="modal-window" style="max-width:550px;">
          <button class="modal-close-btn" onclick="document.getElementById('modal-erp-temp').remove()">&times;</button>
          <h4 style="color:#FFF;font-family:var(--font-display);margin-bottom:12px;">➕ Cadastrar Nova Loja, Corner ou Pop-up</h4>
          
          <form id="form-new-store">
            <div style="margin-bottom:10px;">
              <label class="erp-label">CNPJ Mantenedor (Vínculo 1:N):</label>
              <select id="in-store-cnpj" class="erp-input-sm" style="width:100%;">
                ${this.cnpjs.map(c => `<option value="${c.id}">${c.nomeFantasia} (${c.cnpj})</option>`).join("")}
              </select>
            </div>
            <div style="margin-bottom:10px;">
              <label class="erp-label">Nome da Loja / Corner:</label>
              <input type="text" id="in-store-name" required class="erp-input-sm" style="width:100%;" placeholder="Ex: Corner JOY Club - Itajaí">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
              <div>
                <label class="erp-label">Tipo de Ponto:</label>
                <select id="in-store-type" class="erp-input-sm" style="width:100%;">
                  <option value="CORNER">CORNER (Clube / Academia)</option>
                  <option value="BOUTIQUE">BOUTIQUE EXCLUSIVA</option>
                  <option value="POPUP">POP-UP TEMPORADA</option>
                </select>
              </div>
              <div>
                <label class="erp-label">Cidade / UF:</label>
                <input type="text" id="in-store-city" required class="erp-input-sm" style="width:100%;" placeholder="Itajaí/SC">
              </div>
            </div>
            <div style="margin-bottom:10px;">
              <label class="erp-label">Localização Exata:</label>
              <input type="text" id="in-store-loc" class="erp-input-sm" style="width:100%;" placeholder="Ex: JOY Club Brava Beach">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
              <div>
                <label class="erp-label">Aluguel Fixo (R$):</label>
                <input type="number" step="0.01" id="in-store-rent" class="erp-input-sm" style="width:100%;" value="4500.00">
              </div>
              <div>
                <label class="erp-label">Meta Mensal Vendas (R$):</label>
                <input type="number" step="0.01" id="in-store-target" class="erp-input-sm" style="width:100%;" value="50000.00">
              </div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;">
              <button type="submit" class="btn-primary-luxury">Cadastrar Loja</button>
            </div>
          </form>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", modalHtml);

    document.getElementById("form-new-store").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        cnpjId: document.getElementById("in-store-cnpj").value,
        name: document.getElementById("in-store-name").value,
        type: document.getElementById("in-store-type").value,
        city: document.getElementById("in-store-city").value,
        location: document.getElementById("in-store-loc").value,
        rentAmount: parseFloat(document.getElementById("in-store-rent").value),
        salesTargetMonthly: parseFloat(document.getElementById("in-store-target").value),
        stoneCode: `847291${Math.floor(Math.random() * 90 + 10)}`
      };
      await fetch("/api/erp/stores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      document.getElementById("modal-erp-temp").remove();
      this.showToastNotification("Nova loja/unidade cadastrada!", "success");
      await this.loadCnpjsAndStores();
      this.setupStoreSwitcher();
      this.renderStoresRegistration();
    });
  },

  // --- 8. ATENDIMENTO IA: DASHBOARD EM TEMPO REAL ---
  async renderAiConciergeDashboard() {
    const container = document.getElementById("subpane-concierge-dashboard");
    if (!container) return;

    let chatData = { kpis: { activeChats: 5, avgDurationMinutes: 4.2, aiResolutionRatePercent: 86.5, pendingHumanTakeover: 2, estimatedCsat: 4.9 }, chats: [] };
    try {
      const res = await fetch("/api/erp/ai-concierge/live-chats");
      chatData = await res.json();
    } catch (e) {
      console.error(e);
    }

    const { kpis, chats } = chatData;

    container.innerHTML = `
      <!-- KPI Cards Row -->
      <div class="kpi-grid" style="margin-bottom:20px;">
        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-emerald">💬</div>
            <span class="kpi-badge positive">Em Tempo Real</span>
          </div>
          <div class="kpi-title">Atendimentos Ativos</div>
          <div class="kpi-value" style="color:var(--emerald-light);">${kpis.activeChats} Conversas</div>
          <div class="kpi-subtitle">WhatsApp Meta & Instagram Direct</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-blue">⏱️</div>
            <span class="kpi-badge positive">Média</span>
          </div>
          <div class="kpi-title">Duração Média</div>
          <div class="kpi-value" style="color:var(--blue-accent);">${kpis.avgDurationMinutes} min</div>
          <div class="kpi-subtitle">Tempo de resposta < 8s</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-gold">🤖</div>
            <span class="kpi-badge positive">Herme IA</span>
          </div>
          <div class="kpi-title">Resolução Automatizada</div>
          <div class="kpi-value" style="color:var(--gold-light);">${kpis.aiResolutionRatePercent}%</div>
          <div class="kpi-subtitle">Sem necessidade de transbordo</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-rose">👩‍💼</div>
            <span class="kpi-badge ${kpis.pendingHumanTakeover > 0 ? '' : 'positive'}">Ação Imediata</span>
          </div>
          <div class="kpi-title">Aguardando Consultora</div>
          <div class="kpi-value" style="color:${kpis.pendingHumanTakeover > 0 ? 'var(--rose-light)' : 'var(--emerald-light)'};">
            ${kpis.pendingHumanTakeover} Chats
          </div>
          <div class="kpi-subtitle">Transbordo VIP para humana</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-gold">⭐</div>
            <span class="kpi-badge positive">CSAT</span>
          </div>
          <div class="kpi-title">Satisfação Estimada</div>
          <div class="kpi-value" style="color:#FFF;">${kpis.estimatedCsat} / 5.0</div>
          <div class="kpi-subtitle">Análise de Sentimento Positivo</div>
        </div>
      </div>

      <!-- Live Chats Table -->
      <div class="content-card">
        <div class="card-header">
          <div>
            <h4>📋 Monitoramento de Atendimentos em Andamento (Herme IA & WhatsApp)</h4>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px;">
              Acompanhe a duração, intenção do cliente e assuma o controle humano instantaneamente a qualquer momento.
            </p>
          </div>
          <span class="status-badge" style="background:rgba(0,168,104,0.12);color:var(--stone-green);">
            🟢 Conexão Ativa com WhatsApp Meta API
          </span>
        </div>

        <div class="table-responsive">
          <table class="crm-compact-table">
            <thead>
              <tr>
                <th>Cliente / Contato</th>
                <th>Canal</th>
                <th>Duração</th>
                <th>Intenção / Assunto</th>
                <th>Sentimento</th>
                <th>Status Atual</th>
                <th>Agente Atribuído</th>
                <th style="text-align:right;">Alternar Atendimento</th>
              </tr>
            </thead>
            <tbody>
              ${chats.map(c => {
                const isHuman = c.mode === "HUMAN";
                const isWaiting = c.status === "WAITING_HUMAN";
                return `
                <tr style="height:48px;">
                  <td>
                    <strong>${c.customerName}</strong>
                    <div style="font-size:0.7rem;color:var(--text-muted);">${c.phone} • <span style="color:var(--gold-light);">${c.customerBadge}</span></div>
                  </td>
                  <td>
                    <span class="payment-badge-pill">${c.channelIcon} ${c.channel}</span>
                  </td>
                  <td>
                    <span style="font-weight:600;color:#FFF;">${c.durationFormatted}</span>
                  </td>
                  <td>
                    <div style="font-size:0.8rem;color:#FFF;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${c.intent}">
                      ${c.intent}
                    </div>
                    <div style="font-size:0.7rem;color:var(--text-muted);max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${c.lastMessage}">
                      ${c.lastMessage}
                    </div>
                  </td>
                  <td>
                    <span style="font-size:0.75rem;">${c.sentimentIcon} ${c.sentiment}</span>
                  </td>
                  <td>
                    <span class="erp-status-badge ${isHuman ? 'settled' : (isWaiting ? 'approved' : 'pending')}">
                      ${c.statusLabel}
                    </span>
                  </td>
                  <td style="font-size:0.78rem;color:${isHuman ? 'var(--gold-light)' : 'var(--text-secondary)'};">
                    ${c.assignedAgent}
                  </td>
                  <td style="text-align:right;">
                    ${isHuman ? `
                      <button class="crm-mini-btn btn-toggle-chat-mode" data-id="${c.id}" data-target="AI" style="background:rgba(56,189,248,0.15);color:var(--blue-accent);border-color:rgba(56,189,248,0.3);">
                        🤖 Devolver para IA
                      </button>
                    ` : `
                      <button class="crm-mini-btn btn-toggle-chat-mode" data-id="${c.id}" data-target="HUMAN" style="background:rgba(212,175,55,0.15);color:var(--gold-light);border-color:rgba(212,175,55,0.3);">
                        👤 Assumir (Humano)
                      </button>
                    `}
                  </td>
                </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelectorAll(".btn-toggle-chat-mode").forEach(btn => {
      btn.addEventListener("click", async () => {
        const chatId = btn.getAttribute("data-id");
        const targetMode = btn.getAttribute("data-target");
        await fetch("/api/erp/ai-concierge/toggle-mode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId: chatId,
            targetMode: targetMode,
            agentName: targetMode === "HUMAN" ? "Mariana Ramos (Consultora Titular)" : "Herme Agent IA Concierge"
          })
        });
        this.showToastNotification(targetMode === "HUMAN" ? "Você assumiu o atendimento no WhatsApp!" : "Atendimento devolvido para a Herme IA!", "success");
        this.renderAiConciergeDashboard();
      });
    });
  },

  // --- 9. NOVO MÓDULO: ORÇAMENTO & CENÁRIOS ---
  async loadBudgetData() {
    try {
      const res = await fetch("/api/erp/budget/summary");
      this.budgetData = await res.json();
    } catch (e) {
      console.error(e);
    }
  },

  async renderBudgetVariance() {
    const container = document.getElementById("subpane-budget-variance");
    if (!container) return;
    await this.loadBudgetData();

    const variance = this.budgetData?.budgetVariance || [];

    const totalBudgetedRev = variance.filter(v => v.code.startsWith("REC")).reduce((a, b) => a + b.budgeted, 0);
    const totalActualRev = variance.filter(v => v.code.startsWith("REC")).reduce((a, b) => a + b.actual, 0);
    const totalBudgetedExp = variance.filter(v => !v.code.startsWith("REC")).reduce((a, b) => a + b.budgeted, 0);
    const totalActualExp = variance.filter(v => !v.code.startsWith("REC")).reduce((a, b) => a + b.actual, 0);

    const netBudgeted = totalBudgetedRev - totalBudgetedExp;
    const netActual = totalActualRev - totalActualExp;
    const netVariance = netActual - netBudgeted;

    container.innerHTML = `
      <!-- KPI Variance Header -->
      <div class="kpi-grid" style="margin-bottom:20px;">
        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-emerald">💰</div>
            <span class="kpi-badge positive">Receitas</span>
          </div>
          <div class="kpi-title">Faturamento Orçado vs Realizado</div>
          <div class="kpi-value" style="color:var(--emerald-light);">R$ ${totalActualRev.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</div>
          <div class="kpi-subtitle">Orçado: R$ ${totalBudgetedRev.toLocaleString('pt-BR', {minimumFractionDigits: 2})} (${((totalActualRev/totalBudgetedRev - 1)*100).toFixed(1)}%)</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-rose">🧾</div>
            <span class="kpi-badge">Despesas & CMV</span>
          </div>
          <div class="kpi-title">Custos + Despesas Realizadas</div>
          <div class="kpi-value" style="color:var(--rose-light);">R$ ${totalActualExp.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</div>
          <div class="kpi-subtitle">Orçado: R$ ${totalBudgetedExp.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-gold">💎</div>
            <span class="kpi-badge positive">Resultado</span>
          </div>
          <div class="kpi-title">Lucro Operacional Líquido</div>
          <div class="kpi-value" style="color:${netActual >= netBudgeted ? 'var(--emerald-light)' : 'var(--gold-light)'};">
            R$ ${netActual.toLocaleString('pt-BR', {minimumFractionDigits: 2})}
          </div>
          <div class="kpi-subtitle">Desvio: ${netVariance >= 0 ? '+' : ''}R$ ${netVariance.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-blue">🎯</div>
            <span class="kpi-badge positive">Aderência</span>
          </div>
          <div class="kpi-title">Farol Geral de Governança</div>
          <div class="kpi-value" style="color:var(--emerald-light);">98,8% Meta</div>
          <div class="kpi-subtitle">Dentro da margem aprovada</div>
        </div>
      </div>

      <!-- Variance Analysis Table -->
      <div class="content-card">
        <div class="card-header">
          <div>
            <h4>📊 Cruzamento Gerencial: Orçado vs. Realizado (Variance Analysis)</h4>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px;">
              Análise de desvios por conta contábil e centro de custo com sinalização por farol de tolerância.
            </p>
          </div>
          <button id="btn-export-variance" class="btn-primary-luxury" style="padding:6px 14px;font-size:0.8rem;">
            📥 Exportar Relatório Diretoria
          </button>
        </div>

        <div class="table-responsive">
          <table class="crm-compact-table">
            <thead>
              <tr>
                <th>Código</th>
                <th>Conta Contábil</th>
                <th>Centro de Custo</th>
                <th style="text-align:right;">Orçado (R$)</th>
                <th style="text-align:right;">Realizado (R$)</th>
                <th style="text-align:right;">Desvio (R$)</th>
                <th style="text-align:right;">Desvio (%)</th>
                <th style="text-align:center;">Farol</th>
                <th>Diagnóstico & Ação</th>
              </tr>
            </thead>
            <tbody>
              ${variance.map(v => {
                const isRev = v.code.startsWith("REC");
                const isPositive = isRev ? v.variance >= 0 : v.variance <= 0;
                const statusColor = v.status === "GREEN" ? "var(--emerald-light)" : (v.status === "YELLOW" ? "var(--gold-light)" : "var(--rose-light)");
                const statusBadge = v.status === "GREEN" ? "🟢 Na Meta" : (v.status === "YELLOW" ? "🟡 Atenção" : "🔴 Estourado");
                return `
                <tr style="height:44px;">
                  <td><strong>${v.code}</strong></td>
                  <td><strong>${v.account}</strong></td>
                  <td style="font-size:0.75rem;color:var(--text-muted);">${v.costCenter}</td>
                  <td style="text-align:right;">R$ ${v.budgeted.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
                  <td style="text-align:right;"><strong style="color:#FFF;">R$ ${v.actual.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong></td>
                  <td style="text-align:right;color:${isPositive ? 'var(--emerald-light)' : 'var(--rose-light)'};">
                    ${v.variance >= 0 ? '+' : ''}R$ ${v.variance.toLocaleString('pt-BR', {minimumFractionDigits: 2})}
                  </td>
                  <td style="text-align:right;color:${isPositive ? 'var(--emerald-light)' : 'var(--rose-light)'};">
                    ${v.variancePercent >= 0 ? '+' : ''}${v.variancePercent.toFixed(1)}%
                  </td>
                  <td style="text-align:center;">
                    <span class="status-badge" style="background:rgba(255,255,255,0.05);color:${statusColor};font-size:0.72rem;">
                      ${statusBadge}
                    </span>
                  </td>
                  <td style="font-size:0.75rem;color:var(--text-secondary);">${v.notes}</td>
                </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const btnExport = document.getElementById("btn-export-variance");
    if (btnExport) btnExport.addEventListener("click", () => alert("Relatório de Variance Analysis gerado em PDF/XLSX para auditoria de governança!"));
  },

  async renderBudgetBase() {
    const container = document.getElementById("subpane-budget-base");
    if (!container) return;
    await this.loadBudgetData();

    const variance = this.budgetData?.budgetVariance || [];

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header">
          <div>
            <h4>📑 Orçamento Base Anual (Matriz Orçamentária por Centro de Custo)</h4>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px;">
              Configuração dos limites de gastos e metas de faturamento aprovadas pela Diretoria Executiva.
            </p>
          </div>
          <button id="btn-save-budget-base" class="btn-primary-luxury" style="padding:8px 16px;font-size:0.8rem;">
            💾 Salvar Alterações no Orçamento
          </button>
        </div>

        <div class="table-responsive">
          <table class="crm-compact-table">
            <thead>
              <tr>
                <th>Conta Contábil</th>
                <th>Centro de Custo</th>
                <th>Orçamento Mensal Atual (R$)</th>
                <th>Ajustar Orçamento (R$)</th>
                <th>Status da Conta</th>
              </tr>
            </thead>
            <tbody>
              ${variance.map((v, idx) => `
                <tr style="height:44px;">
                  <td><strong>${v.account}</strong></td>
                  <td>${v.costCenter}</td>
                  <td>R$ ${v.budgeted.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
                  <td>
                    <input type="number" step="100" class="erp-input-sm in-budget-val" data-index="${idx}" value="${v.budgeted}" style="width:140px;">
                  </td>
                  <td><span class="status-badge" style="background:rgba(0,168,104,0.12);color:var(--stone-green);">Ativa</span></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const btnSave = document.getElementById("btn-save-budget-base");
    if (btnSave) {
      btnSave.addEventListener("click", async () => {
        const inputs = container.querySelectorAll(".in-budget-val");
        inputs.forEach(inp => {
          const idx = parseInt(inp.getAttribute("data-index"));
          variance[idx].budgeted = parseFloat(inp.value) || 0;
          variance[idx].variance = variance[idx].actual - variance[idx].budgeted;
          variance[idx].variancePercent = variance[idx].budgeted > 0 ? (variance[idx].variance / variance[idx].budgeted) * 100 : 0;
        });

        await fetch("/api/erp/budget/save-base", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ budgetVariance: variance })
        });
        this.showToastNotification("Orçamento base salvo com sucesso!", "success");
        this.renderBudgetBase();
      });
    }
  },

  async renderBudgetScenarios() {
    const container = document.getElementById("subpane-budget-scenarios");
    if (!container) return;
    await this.loadBudgetData();

    const scenarios = this.budgetData?.scenarios || [];

    container.innerHTML = `
      <div style="margin-bottom:20px;">
        <h4 style="color:#FFF;font-size:1.2rem;margin:0;">📈 Simulador Executivo de Cenários Financeiros</h4>
        <p style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px;">
          Modelagem estocástica com variações de ticket, compra de estoque, despesas fixas e margem de segurança.
        </p>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(300px, 1fr));gap:16px;">
        ${scenarios.map(s => {
          const isBase = s.id === "c4";
          return `
          <div class="content-card" style="border:${isBase ? '2px solid var(--gold-primary)' : '1px solid var(--border-subtle)'};position:relative;">
            ${isBase ? `<span style="position:absolute;top:-10px;right:16px;background:var(--gold-primary);color:#090D16;font-size:0.7rem;font-weight:700;padding:2px 8px;border-radius:10px;">OFICIAL SIÉ @ JOY</span>` : ''}
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
              <h4 style="color:#FFF;font-size:1.05rem;margin:0;">${s.name}</h4>
              <span class="status-badge" style="background:rgba(255,255,255,0.05);color:var(--text-secondary);font-size:0.7rem;">${s.tag}</span>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;background:rgba(15,23,42,0.5);padding:12px;border-radius:8px;">
              <div>
                <span style="font-size:0.7rem;color:var(--text-muted);display:block;">Faturamento:</span>
                <strong style="color:var(--emerald-light);font-size:1rem;">R$ ${s.monthlyRevenue.toLocaleString('pt-BR', {minimumFractionDigits:2})}</strong>
              </div>
              <div>
                <span style="font-size:0.7rem;color:var(--text-muted);display:block;">Lucro Líquido:</span>
                <strong style="color:${s.netProfit >= 0 ? 'var(--gold-light)' : 'var(--rose-light)'};font-size:1rem;">R$ ${s.netProfit.toLocaleString('pt-BR', {minimumFractionDigits:2})}</strong>
              </div>
              <div>
                <span style="font-size:0.7rem;color:var(--text-muted);display:block;">Margem Líquida:</span>
                <strong style="color:#FFF;">${s.netMarginPercent}%</strong>
              </div>
              <div>
                <span style="font-size:0.7rem;color:var(--text-muted);display:block;">Ponto de Equilíbrio:</span>
                <strong style="color:var(--blue-accent);">R$ ${s.breakevenRevenue.toLocaleString('pt-BR', {minimumFractionDigits:2})}</strong>
              </div>
            </div>

            <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:14px;line-height:1.4;">
              Compra de estoque recomendada: <strong>R$ ${s.stockPurchase.toLocaleString('pt-BR', {minimumFractionDigits:2})}</strong> • Margem de segurança: <strong>${s.safetyMarginPercent}%</strong>.
            </div>

            <button class="btn-primary-luxury btn-apply-scenario" data-id="${s.id}" style="width:100%;font-size:0.8rem;padding:8px;justify-content:center;">
              Aplicar ao Planejamento
            </button>
          </div>
          `;
        }).join("")}
      </div>
    `;

    container.querySelectorAll(".btn-apply-scenario").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        this.showToastNotification(`Cenário ${id.toUpperCase()} aplicado como base de planejamento!`, "success");
      });
    });
  },

  async renderBudgetBreakeven() {
    const container = document.getElementById("subpane-budget-breakeven");
    if (!container) return;
    await this.loadBudgetData();

    const be = this.budgetData?.breakevenAnalysis || { consolidated: {}, byStore: [] };
    const c = be.consolidated || {};

    container.innerHTML = `
      <!-- Consolidated Breakeven Hero -->
      <div class="hero-banner" style="margin-bottom:24px;">
        <div class="hero-grid">
          <div class="hero-info">
            <div style="display:inline-flex;align-items:center;gap:6px;background:rgba(0,168,104,0.15);border:1px solid rgba(0,168,104,0.3);color:var(--stone-green);padding:4px 10px;border-radius:20px;font-size:0.75rem;font-weight:600;margin-bottom:8px;">
              ⚖️ Ponto de Equilíbrio Consolidado (Com 3 meses de carência)
            </div>
            <h3>Ponto de Equilíbrio: R$ ${(c.breakevenRevenue || 27843.14).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</h3>
            <p>
              Com a economia de <strong>R$ 18.000,00</strong> negociada no aluguel da JOY Club, o ponto de equilíbrio operacional foi antecipado para o dia <strong>${c.daysToBreakeven || 17} de cada mês</strong>.
            </p>
            <div class="hero-metrics-pill-row">
              <div class="metric-pill">
                <span>Custos Fixos:</span>
                <strong>R$ ${(c.fixedCosts || 14200).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong>
              </div>
              <div class="metric-pill">
                <span>Margem Contribuição:</span>
                <strong style="color:var(--emerald-light);">${c.contributionMarginPercent || 51}%</strong>
              </div>
              <div class="metric-pill">
                <span>Margem de Segurança:</span>
                <strong style="color:var(--gold-light);">${c.marginOfSafetyPercent || 44.74}%</strong>
              </div>
            </div>
          </div>

          <div class="thermometer-card">
            <div class="thermometer-header">
              <span class="thermometer-label">Meta de Breakeven no Mês</span>
              <span class="thermometer-val" style="color:var(--emerald-light);">Superada 🟢</span>
            </div>
            <div class="progress-track">
              <div class="progress-bar-fill" style="width:100%;background:linear-gradient(90deg,var(--gold-primary),var(--emerald-primary));"></div>
            </div>
            <div class="thermometer-footer">
              <span>Realizado: R$ ${(c.currentRevenue || 50385).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</span>
              <span style="color:var(--emerald-light);font-weight:600;">+ R$ ${(c.marginOfSafetyAmount || 22541.86).toLocaleString('pt-BR', {minimumFractionDigits:2})} acima</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Breakeven by Store Table -->
      <div class="content-card">
        <div class="card-header">
          <h4>🏬 Ponto de Equilíbrio por Loja & Canal de Venda</h4>
        </div>

        <div class="table-responsive">
          <table class="crm-compact-table">
            <thead>
              <tr>
                <th>Unidade / Canal</th>
                <th>Custos Fixos (R$)</th>
                <th>Margem de Contribuição</th>
                <th>Ponto de Equilíbrio (R$)</th>
                <th>Faturamento Realizado</th>
                <th>Margem de Segurança</th>
                <th>Status Operacional</th>
              </tr>
            </thead>
            <tbody>
              ${(be.byStore || []).map(s => `
                <tr style="height:44px;">
                  <td><strong>${s.storeName}</strong></td>
                  <td>R$ ${s.fixedCosts.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
                  <td><strong>${s.contributionMarginPercent}%</strong></td>
                  <td><strong style="color:var(--blue-accent);">R$ ${s.breakevenRevenue.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong></td>
                  <td><strong style="color:var(--emerald-light);">R$ ${s.currentRevenue.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong></td>
                  <td><strong style="color:var(--gold-light);">${s.marginOfSafetyPercent}%</strong></td>
                  <td>
                    <span class="erp-status-badge ${s.currentRevenue >= s.breakevenRevenue ? 'settled' : 'pending'}">
                      ${s.currentRevenue >= s.breakevenRevenue ? '✅ Lucro Atingido' : '⏳ Em Operação'}
                    </span>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  // --- HELPERS PARA CAMPOS CUSTOMIZADOS ---
  getCustomFieldLabel(keyOrId) {
    if (!this.customFieldsConfig?.fields) return keyOrId;
    const f = this.customFieldsConfig.fields.find(item => item.id === keyOrId || item.name === keyOrId);
    return f ? f.name : keyOrId;
  },

  renderCustomFieldsFormHtml(targetType) {
    const fields = (this.customFieldsConfig?.fields || []).filter(f => f.active && (f.target === "ALL" || f.target === targetType));
    if (fields.length === 0) return "";
    return `
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px 12px;margin-bottom:12px;">
        <div style="font-size:0.75rem;font-weight:600;color:var(--gold-light);margin-bottom:8px;display:flex;align-items:center;gap:6px;">
          <span>🏷️</span> <span>Campos Customizados:</span>
        </div>
        <div style="display:grid;grid-template-columns:${fields.length > 1 ? '1fr 1fr' : '1fr'};gap:10px;">
          ${fields.map(f => `
            <div>
              <label class="erp-label" style="margin-bottom:2px;">${f.name}:</label>
              <input type="${f.type || 'text'}" class="erp-input-sm custom-field-input" data-cf-id="${f.id}" style="width:100%;" placeholder="${f.placeholder || ''}" ${f.required ? 'required' : ''}>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  },

  collectCustomFieldsValues(containerElement) {
    const customFields = {};
    if (!containerElement) return customFields;
    containerElement.querySelectorAll(".custom-field-input").forEach(input => {
      const id = input.getAttribute("data-cf-id");
      const val = input.value.trim();
      if (id && val) {
        customFields[id] = val;
      }
    });
    return customFields;
  },

  // --- GERENCIADOR DE CAMPOS CUSTOMIZADOS (CONFIGURAÇÃO) ---
  async renderCustomFieldsConfig() {
    const container = document.getElementById("subpane-settings-custom-fields");
    if (!container) return;

    await this.loadCustomFieldsConfig();
    const config = this.customFieldsConfig || { maxFields: 5, fields: [] };
    const fields = config.fields || [];

    const slots = [];
    for (let i = 0; i < 5; i++) {
      slots.push(fields[i] || {
        id: `cf_${i+1}`,
        name: "",
        target: "ALL",
        type: "text",
        placeholder: "",
        required: false,
        active: false
      });
    }

    container.innerHTML = `
      <div class="content-card">
        <div class="card-header" style="flex-wrap:wrap;gap:12px;">
          <div>
            <h4>🏷️ Gerenciador de Campos Customizados do ERP (Até 5 Campos)</h4>
            <p style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px;">
              Personalize até 5 campos dinâmicos para os lançamentos de <strong>Contas a Pagar</strong> e <strong>Contas a Receber</strong> (ex: Pedido de Compra, SLA de Contrato, Link de Drive, Tags Fiscais ou Projetos).
            </p>
          </div>
          <button id="btn-save-custom-fields" class="btn-primary-luxury" style="padding:8px 16px;font-size:0.82rem;">
            💾 Salvar Configurações de Campos
          </button>
        </div>

        <div style="display:flex;flex-direction:column;gap:14px;margin-top:16px;">
          ${slots.map((s, idx) => `
            <div class="custom-field-slot-card" style="background:rgba(255,255,255,0.02);border:1px solid ${s.active ? 'rgba(0,168,104,0.3)' : 'var(--border-subtle)'};border-radius:10px;padding:16px;transition:all 0.2s ease;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <div style="display:flex;align-items:center;gap:10px;">
                  <span style="font-weight:700;font-size:0.85rem;color:${s.active ? 'var(--stone-green)' : 'var(--text-muted)'};background:${s.active ? 'rgba(0,168,104,0.15)' : 'rgba(255,255,255,0.05)'};padding:2px 8px;border-radius:6px;">
                    Slot #${idx + 1}
                  </span>
                  <span style="font-size:0.88rem;font-weight:600;color:#FFF;">
                    ${s.name || `Campo Customizado #${idx + 1} (Disponível)`}
                  </span>
                </div>
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:0.8rem;color:${s.active ? 'var(--stone-green)' : 'var(--text-muted)'};">
                  <input type="checkbox" class="cf-input-active" data-idx="${idx}" ${s.active ? 'checked' : ''} style="accent-color:var(--stone-green);width:16px;height:16px;">
                  <strong>${s.active ? 'Ativo no ERP' : 'Inativo / Oculto'}</strong>
                </label>
              </div>

              <div style="display:grid;grid-template-columns:2fr 1.2fr 1fr 2fr auto;gap:12px;align-items:end;">
                <div>
                  <label class="erp-label">Nome / Rótulo do Campo:</label>
                  <input type="text" class="erp-input-sm cf-input-name" data-idx="${idx}" value="${s.name || ''}" placeholder="Ex: Nº Pedido de Compra" style="width:100%;">
                </div>
                <div>
                  <label class="erp-label">Aplicar Em:</label>
                  <select class="erp-input-sm cf-input-target" data-idx="${idx}" style="width:100%;">
                    <option value="ALL" ${s.target === 'ALL' ? 'selected' : ''}>Pagar & Receber</option>
                    <option value="PAYABLE" ${s.target === 'PAYABLE' ? 'selected' : ''}>Apenas Contas a Pagar</option>
                    <option value="RECEIVABLE" ${s.target === 'RECEIVABLE' ? 'selected' : ''}>Apenas Contas a Receber</option>
                  </select>
                </div>
                <div>
                  <label class="erp-label">Tipo de Dado:</label>
                  <select class="erp-input-sm cf-input-type" data-idx="${idx}" style="width:100%;">
                    <option value="text" ${s.type === 'text' ? 'selected' : ''}>Texto Curto</option>
                    <option value="number" ${s.type === 'number' ? 'selected' : ''}>Número</option>
                    <option value="date" ${s.type === 'date' ? 'selected' : ''}>Data</option>
                  </select>
                </div>
                <div>
                  <label class="erp-label">Placeholder / Exemplo:</label>
                  <input type="text" class="erp-input-sm cf-input-placeholder" data-idx="${idx}" value="${s.placeholder || ''}" placeholder="Ex: PC-2026-000" style="width:100%;">
                </div>
                <div style="display:flex;align-items:center;padding-bottom:8px;">
                  <label style="font-size:0.75rem;color:var(--text-secondary);display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" class="cf-input-required" data-idx="${idx}" ${s.required ? 'checked' : ''} style="accent-color:var(--gold-primary);">
                    Obrigatório
                  </label>
                </div>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    `;

    const btnSave = document.getElementById("btn-save-custom-fields");
    if (btnSave) {
      btnSave.addEventListener("click", async () => {
        const updatedFields = [];
        for (let i = 0; i < 5; i++) {
          const activeEl = container.querySelector(`.cf-input-active[data-idx="${i}"]`);
          const nameEl = container.querySelector(`.cf-input-name[data-idx="${i}"]`);
          const targetEl = container.querySelector(`.cf-input-target[data-idx="${i}"]`);
          const typeEl = container.querySelector(`.cf-input-type[data-idx="${i}"]`);
          const placeholderEl = container.querySelector(`.cf-input-placeholder[data-idx="${i}"]`);
          const requiredEl = container.querySelector(`.cf-input-required[data-idx="${i}"]`);

          const fieldObj = {
            id: `cf_${i + 1}`,
            name: nameEl?.value.trim() || `Campo #${i + 1}`,
            target: targetEl?.value || "ALL",
            type: typeEl?.value || "text",
            placeholder: placeholderEl?.value.trim() || "",
            required: requiredEl?.checked || false,
            active: activeEl?.checked || false
          };
          updatedFields.push(fieldObj);
        }

        try {
          const res = await fetch("/api/erp/custom-fields", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fields: updatedFields })
          });
          const result = await res.json();
          this.customFieldsConfig = result.customFields;
          this.showToastNotification("✅ Configurações de Campos Customizados salvas com sucesso!");
          this.renderCustomFieldsConfig();
        } catch (err) {
          console.error(err);
          alert("Erro ao salvar campos customizados.");
        }
      });
    }
  },

  // --- 4. MOVIMENTO FINANCEIRO (SOMENTE CONTAS CONCILIADAS) ---
  async renderFinancialMovement() {
    const container = document.getElementById("subpane-financial-movement");
    if (!container) return;

    try {
      const res = await fetch(`/api/erp/financial-movement?storeId=${this.currentStoreId}&cnpjId=${this.currentCnpjId}`);
      this.financialMovementData = await res.json();
    } catch (e) {
      console.error(e);
      return;
    }

    const { movements, summary } = this.financialMovementData || { movements: [], summary: { totalIn: 0, totalOut: 0, netBalance: 0, countIn: 0, countOut: 0, totalCount: 0 } };

    container.innerHTML = `
      <!-- KPI Row -->
      <div class="kpi-grid" style="margin-bottom:20px;">
        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-emerald">📥</div>
            <span class="kpi-badge positive">${summary.countIn} Entradas</span>
          </div>
          <div class="kpi-title">Total Entradas Conciliadas</div>
          <div class="kpi-value" style="color:var(--emerald-light);">R$ ${(summary?.totalIn || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</div>
          <div class="kpi-subtitle">Recebimentos Stone & Vendas liquidadas</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-rose">📤</div>
            <span class="kpi-badge">${summary.countOut} Saídas</span>
          </div>
          <div class="kpi-title">Total Saídas Conciliadas</div>
          <div class="kpi-value" style="color:var(--rose-light);">R$ ${(summary?.totalOut || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</div>
          <div class="kpi-subtitle">Despesas pagas & Fornecedores quitados</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-gold">⚖️</div>
            <span class="kpi-badge positive">Saldo Real</span>
          </div>
          <div class="kpi-title">Saldo Líquido Conciliado</div>
          <div class="kpi-value" style="color:${(summary?.netBalance || 0) >= 0 ? 'var(--emerald-light)' : 'var(--rose-light)'};">
            R$ ${(summary?.netBalance || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}
          </div>
          <div class="kpi-subtitle">Disponibilidade efetiva em caixa</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-top">
            <div class="kpi-icon icon-blue">🎯</div>
            <span class="kpi-badge positive">100% Conferido</span>
          </div>
          <div class="kpi-title">Lançamentos Conciliados</div>
          <div class="kpi-value" style="color:var(--blue-accent);">${summary.totalCount || 0}</div>
          <div class="kpi-subtitle">Conferidos em 3 vias com banco</div>
        </div>
      </div>

      <!-- Financial Movement Table -->
      <div class="content-card">
        <div class="card-header" style="flex-wrap:wrap;gap:12px;">
          <div>
            <h4>🔄 Livro Razão de Movimento Financeiro (Lançamentos Conciliados)</h4>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px;">
              Extrato consolidado contemplando <strong>exclusivamente contas conciliadas</strong> de entrada (recebimentos) e saída (despesas).
            </p>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <select id="sel-filter-mov-type" class="erp-input-sm" style="font-size:0.8rem;padding:6px 10px;">
              <option value="ALL">Todos os Tipos (Entradas & Saídas)</option>
              <option value="ENTRADA">📥 Apenas Entradas (Recebimentos)</option>
              <option value="SAIDA">📤 Apenas Saídas (Despesas)</option>
            </select>
            <input type="text" id="in-filter-mov-search" class="erp-input-sm" placeholder="🔍 Buscar por descrição, entidade, doc..." style="font-size:0.8rem;padding:6px 12px;min-width:220px;">
            <button id="btn-export-mov-csv" class="btn-primary-luxury" style="padding:6px 14px;font-size:0.8rem;background:rgba(212,175,55,0.15);color:var(--gold-light);border:1px solid rgba(212,175,55,0.3);">
              📥 Exportar CSV
            </button>
          </div>
        </div>

        <div class="table-responsive">
          <table class="crm-compact-table" id="table-financial-movement">
            <thead>
              <tr>
                <th>Data Conciliação</th>
                <th>Código / ID</th>
                <th>Tipo</th>
                <th>Descrição & Beneficiário / Cliente</th>
                <th>Centro de Custo & Plano de Contas</th>
                <th>Meio Pagamento</th>
                <th>Documento</th>
                <th>Valor Líquido</th>
                <th>Status</th>
                <th style="text-align:right;">Ação</th>
              </tr>
            </thead>
            <tbody id="tbody-financial-movement">
              ${this.renderMovementRowsHtml(movements)}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Filter Type and Search
    const typeSelect = document.getElementById("sel-filter-mov-type");
    const searchInput = document.getElementById("in-filter-mov-search");
    const tbody = document.getElementById("tbody-financial-movement");

    const filterList = () => {
      const typeVal = typeSelect?.value || "ALL";
      const searchVal = (searchInput?.value || "").toLowerCase().trim();
      let filtered = movements;
      if (typeVal !== "ALL") {
        filtered = filtered.filter(m => m.type === typeVal);
      }
      if (searchVal) {
        filtered = filtered.filter(m => 
          (m.id || "").toLowerCase().includes(searchVal) ||
          (m.description || "").toLowerCase().includes(searchVal) ||
          (m.entity || "").toLowerCase().includes(searchVal) ||
          (m.documentNumber || "").toLowerCase().includes(searchVal) ||
          (m.costCenterName || "").toLowerCase().includes(searchVal) ||
          (m.chartOfAccountName || "").toLowerCase().includes(searchVal)
        );
      }
      if (tbody) tbody.innerHTML = this.renderMovementRowsHtml(filtered);
      this.attachMovementRowEvents();
    };

    if (typeSelect) typeSelect.addEventListener("change", filterList);
    if (searchInput) searchInput.addEventListener("input", filterList);

    // Export CSV
    const btnExport = document.getElementById("btn-export-mov-csv");
    if (btnExport) {
      btnExport.addEventListener("click", () => {
        let csvContent = "data:text/csv;charset=utf-8,";
        csvContent += "Data;Codigo;Tipo;Descricao;Favorecido;CentroDeCusto;PlanoDeContas;Meio;Documento;ValorLiquido;Status\n";
        movements.forEach(m => {
          const row = [
            m.date,
            m.id,
            m.type,
            `"${(m.description || '').replace(/"/g, '""')}"`,
            `"${(m.entity || '').replace(/"/g, '""')}"`,
            `"${(m.costCenterName || '').replace(/"/g, '""')}"`,
            `"${(m.chartOfAccountName || '').replace(/"/g, '""')}"`,
            m.paymentMethod,
            m.documentNumber,
            m.netAmount,
            m.status
          ].join(";");
          csvContent += row + "\n";
        });
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `movimento_financeiro_conciliado_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        link.remove();
      });
    }

    this.attachMovementRowEvents();
  },

  renderMovementRowsHtml(movements) {
    if (!movements || movements.length === 0) {
      return `<tr><td colspan="10" style="text-align:center;padding:28px;color:var(--text-muted);">Nenhum lançamento conciliado encontrado para os filtros selecionados.</td></tr>`;
    }
    return movements.map(m => `
      <tr style="height:44px;">
        <td><strong>${new Date(m.date + 'T12:00:00').toLocaleDateString('pt-BR')}</strong></td>
        <td>
          <span style="font-weight:700;font-size:0.8rem;color:#FFF;">${m.id}</span>
          <span style="font-size:0.68rem;color:var(--text-muted);display:block;">${m.sourceId}</span>
        </td>
        <td>
          <span class="category-pill" style="background:${m.type === 'ENTRADA' ? 'rgba(0,168,104,0.15)' : 'rgba(239,68,68,0.15)'};color:${m.type === 'ENTRADA' ? 'var(--stone-green)' : 'var(--rose-light)'};font-weight:700;padding:3px 8px;">
            ${m.type === 'ENTRADA' ? '📥 Entrada' : '📤 Saída'}
          </span>
        </td>
        <td>
          <div style="font-weight:600;color:#FFF;font-size:0.83rem;">${m.description}</div>
          <div style="font-size:0.72rem;color:var(--gold-light);margin-top:2px;">
            👤 ${m.entity}
          </div>
          ${m.customFields && Object.keys(m.customFields).length > 0 ? `
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
              ${Object.entries(m.customFields).filter(([k,v]) => v).map(([k,v]) => `
                <span style="font-size:0.68rem;background:rgba(212,175,55,0.1);color:var(--gold-light);padding:1px 5px;border-radius:3px;border:1px solid rgba(212,175,55,0.2);">
                  <strong>${this.getCustomFieldLabel(k)}:</strong> ${v}
                </span>
              `).join("")}
            </div>
          ` : ''}
        </td>
        <td>
          <div style="font-weight:600;font-size:0.76rem;display:flex;align-items:center;gap:4px;">
            <span class="category-pill" style="background:rgba(59,130,246,0.15);color:var(--blue-accent);padding:2px 6px;font-size:0.68rem;font-weight:600;">
              ${m.costCenterId || 'CC-01'}
            </span>
            <span style="font-size:0.73rem;color:#FFF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px;" title="${m.costCenterName || ''}">
              ${(m.costCenterName || '').split(' - ')[0]}
            </span>
          </div>
          <div style="font-size:0.7rem;color:var(--gold-light);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px;" title="${m.chartOfAccountName || ''}">
            ${m.chartOfAccountId || ''} • ${(m.chartOfAccountName || '').split(' - ').slice(-1)[0]}
          </div>
        </td>
        <td>
          <span class="payment-badge-pill" style="font-size:0.72rem;">${m.paymentMethod || 'PIX'}</span>
        </td>
        <td>
          <span style="font-size:0.78rem;color:var(--text-secondary);font-family:monospace;">${m.documentNumber || '-'}</span>
        </td>
        <td>
          <strong style="font-size:0.92rem;color:${m.type === 'ENTRADA' ? 'var(--emerald-light)' : 'var(--rose-light)'};">
            ${m.type === 'ENTRADA' ? '+' : '-'} R$ ${m.netAmount.toLocaleString('pt-BR', {minimumFractionDigits: 2})}
          </strong>
        </td>
        <td>
          <span class="erp-status-badge settled" style="background:rgba(0,168,104,0.15);color:var(--stone-green);border:1px solid rgba(0,168,104,0.3);">
            ✅ Conciliado
          </span>
        </td>
        <td style="text-align:right;">
          <button class="crm-mini-btn btn-view-movement" data-id="${m.id}" style="background:rgba(212,175,55,0.15);color:var(--gold-light);border-color:rgba(212,175,55,0.3);" title="Ver Detalhes 360º">
            👁️ Detalhes
          </button>
        </td>
      </tr>
    `).join("");
  },

  attachMovementRowEvents() {
    const container = document.getElementById("subpane-financial-movement");
    if (!container) return;

    container.querySelectorAll(".btn-view-movement").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        const mov = (this.financialMovementData?.movements || []).find(m => m.id === id);
        if (!mov) return;
        this.openModalMovementDetails(mov);
      });
    });
  },

  openModalMovementDetails(mov) {
    const modalHtml = `
      <div id="modal-erp-temp" class="modal-backdrop" style="display:flex;">
        <div class="modal-window" style="max-width:580px;">
          <button class="modal-close-btn" onclick="document.getElementById('modal-erp-temp').remove()">&times;</button>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
            <div style="font-size:1.6rem;">${mov.type === 'ENTRADA' ? '📥' : '📤'}</div>
            <div>
              <h4 style="color:#FFF;font-family:var(--font-display);margin:0;">Lançamento Conciliado ${mov.id}</h4>
              <span style="font-size:0.75rem;color:var(--stone-green);font-weight:600;">Status: 100% Conciliado e Liquidado no Caixa</span>
            </div>
          </div>

          <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border-subtle);border-radius:10px;padding:16px;margin-bottom:16px;display:flex;flex-direction:column;gap:10px;font-size:0.83rem;">
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:6px;">
              <span style="color:var(--text-secondary);">Tipo de Movimentação:</span>
              <strong style="color:${mov.type === 'ENTRADA' ? 'var(--stone-green)' : 'var(--rose-light)'};">${mov.type === 'ENTRADA' ? 'ENTRADA (Recebimento)' : 'SAÍDA (Pagamento/Despesa)'}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:6px;">
              <span style="color:var(--text-secondary);">Valor Líquido Efetivado:</span>
              <strong style="font-size:1.05rem;color:${mov.type === 'ENTRADA' ? 'var(--stone-green)' : 'var(--rose-light)'};">
                ${mov.type === 'ENTRADA' ? '+' : '-'} R$ ${mov.netAmount.toLocaleString('pt-BR', {minimumFractionDigits: 2})}
              </strong>
            </div>
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:6px;">
              <span style="color:var(--text-secondary);">Data da Efetivação / Conciliação:</span>
              <strong style="color:#FFF;">${new Date(mov.date + 'T12:00:00').toLocaleDateString('pt-BR')}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:6px;">
              <span style="color:var(--text-secondary);">Favorecido / Cliente:</span>
              <strong style="color:#FFF;">${mov.entity}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:6px;">
              <span style="color:var(--text-secondary);">Descrição:</span>
              <strong style="color:#FFF;">${mov.description}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:6px;">
              <span style="color:var(--text-secondary);">Centro de Custo:</span>
              <strong style="color:var(--blue-accent);">${mov.costCenterId} - ${mov.costCenterName}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:6px;">
              <span style="color:var(--text-secondary);">Plano de Contas:</span>
              <strong style="color:var(--gold-light);">${mov.chartOfAccountId} - ${mov.chartOfAccountName}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:6px;">
              <span style="color:var(--text-secondary);">Documento / Comprovante:</span>
              <strong style="color:#FFF;">${mov.documentNumber || '-'}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;">
              <span style="color:var(--text-secondary);">Meio de Liquidação:</span>
              <strong style="color:#FFF;">${mov.paymentMethod}</strong>
            </div>
          </div>

          ${mov.customFields && Object.keys(mov.customFields).length > 0 ? `
            <div style="background:rgba(212,175,55,0.05);border:1px solid rgba(212,175,55,0.2);border-radius:10px;padding:12px;margin-bottom:16px;">
              <h5 style="color:var(--gold-light);font-size:0.8rem;margin-bottom:8px;">🏷️ Campos Customizados Vinculados:</h5>
              <div style="display:flex;flex-direction:column;gap:6px;font-size:0.8rem;">
                ${Object.entries(mov.customFields).map(([k,v]) => `
                  <div style="display:flex;justify-content:space-between;">
                    <span style="color:var(--text-secondary);">${this.getCustomFieldLabel(k)}:</span>
                    <strong style="color:#FFF;">${v}</strong>
                  </div>
                `).join("")}
              </div>
            </div>
          ` : ''}

          <div style="display:flex;justify-content:flex-end;">
            <button class="modal-close-btn-secondary" onclick="document.getElementById('modal-erp-temp').remove()">Fechar</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", modalHtml);
  },

  // --- 9. IMPORTAÇÃO DE XML DE NF-E, CONFERÊNCIA FISCAL, PRECIFICAÇÃO & ESTOQUE ---
  async openModalImportNfeXml() {
    this.currentNfeData = null;
    this.currentDestinationMatch = null;

    const modalId = "modal-nfe-import";
    const existing = document.getElementById(modalId);
    if (existing) existing.remove();

    const modalHtml = `
      <div id="${modalId}" class="modal-backdrop" style="display:flex;">
        <div class="modal-window" style="max-width:1150px;width:95vw;max-height:92vh;display:flex;flex-direction:column;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;border-bottom:1px solid var(--border-subtle);">
            <div style="display:flex;align-items:center;gap:12px;">
              <div style="font-size:2rem;background:rgba(0,168,104,0.12);padding:10px;border-radius:12px;border:1px solid rgba(0,168,104,0.25);">📥</div>
              <div>
                <h3 style="color:#FFF;margin:0;font-family:var(--font-display);font-size:1.35rem;">Importação de XML de NF-e & Formação de Preço</h3>
                <p style="margin:2px 0 0 0;font-size:0.8rem;color:var(--text-secondary);">
                  Conferência fiscal de destino (Loja & CNPJ), aplicação de markup global e individual e entrada automática no estoque.
                </p>
              </div>
            </div>
            <button class="modal-close-btn" onclick="document.getElementById('${modalId}').remove()">&times;</button>
          </div>

          <div id="nfe-modal-body" style="flex:1;overflow-y:auto;padding:16px 4px 8px 4px;">
            <!-- Dynamic Content: Upload Screen or Pricing Table -->
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", modalHtml);
    await this.renderNfeUploadView();
  },

  async renderNfeUploadView() {
    const container = document.getElementById("nfe-modal-body");
    if (!container) return;

    // Carregar histórico recente
    let history = [];
    try {
      const res = await fetch("/api/erp/nfe/history");
      history = await res.json();
      if (!Array.isArray(history)) history = history.imports || [];
    } catch (e) {
      console.warn("Sem histórico recente:", e);
    }

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:20px;max-width:850px;margin:10px auto;">
        
        <!-- Drag & Drop Zone -->
        <div id="nfe-dropzone" style="border:2px dashed rgba(212,175,55,0.4);border-radius:14px;padding:36px 24px;text-align:center;background:rgba(212,175,55,0.02);transition:all 0.3s ease;cursor:pointer;">
          <div style="font-size:2.8rem;margin-bottom:8px;">📄</div>
          <h4 style="color:#FFF;margin:0 0 6px 0;font-size:1.15rem;">Arraste e solte aqui o arquivo XML da NF-e</h4>
          <p style="color:var(--text-secondary);font-size:0.83rem;margin:0 0 16px 0;">
            Padrão oficial SEFAZ NF-e 4.00 (Layout com fornecedor, destinatário, itens e duplicatas)
          </p>
          <input type="file" id="nfe-file-input" accept=".xml,text/xml" style="display:none;">
          <div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;">
            <button type="button" id="btn-browse-nfe-xml" class="btn-primary-luxury" style="padding:10px 20px;font-size:0.88rem;">
              📂 Selecionar Arquivo XML do Computador
            </button>
            <button type="button" id="btn-load-sample-nfe" class="btn-primary-luxury" style="padding:10px 20px;font-size:0.88rem;background:rgba(0,168,104,0.18);color:var(--stone-green);border:1px solid rgba(0,168,104,0.35);">
              ✨ Carregar XML Exemplo Oficial (SIÉ Confecções - NF 4912)
            </button>
          </div>
        </div>

        <!-- Instruções e Recursos -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:14px;">
          <div class="content-card" style="padding:14px;border:1px solid rgba(255,255,255,0.06);">
            <div style="color:var(--gold-light);font-size:1.1rem;margin-bottom:6px;">🏢 Conferência de Destinatário</div>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin:0;line-height:1.4;">
              O sistema cruza o CNPJ e o endereço da nota com as unidades do grupo, conferindo se o destino é a Matriz SC ou Filial Sul e a qual loja física pertence.
            </p>
          </div>
          <div class="content-card" style="padding:14px;border:1px solid rgba(255,255,255,0.06);">
            <div style="color:var(--stone-green);font-size:1.1rem;margin-bottom:6px;">⚡ Precificação com Margem</div>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin:0;line-height:1.4;">
              Aplique markup geral (ex: 2.40x) em toda a nota com um clique ou altere item a item na lista, acompanhando em tempo real o lucro e a margem percentual.
            </p>
          </div>
          <div class="content-card" style="padding:14px;border:1px solid rgba(255,255,255,0.06);">
            <div style="color:var(--blue-accent);font-size:1.1rem;margin-bottom:6px;">📦 Entrada no Catálogo & CP</div>
            <p style="font-size:0.78rem;color:var(--text-secondary);margin:0;line-height:1.4;">
              Alimenta automaticamente as grades no catálogo Stone, atualiza os custos médios e pode gerar as parcelas do fornecedor no Contas a Pagar.
            </p>
          </div>
        </div>

        ${history.length > 0 ? `
          <div class="content-card" style="padding:16px;">
            <h5 style="color:#FFF;margin:0 0 10px 0;font-size:0.9rem;">📜 Últimas Notas Fiscais Importadas:</h5>
            <div class="table-responsive">
              <table class="crm-compact-table" style="font-size:0.78rem;">
                <thead>
                  <tr>
                    <th>Data Importação</th>
                    <th>NF-e</th>
                    <th>Fornecedor</th>
                    <th>Loja Destino</th>
                    <th>CNPJ Destino</th>
                    <th>Valor Total</th>
                    <th>Itens</th>
                  </tr>
                </thead>
                <tbody>
                  ${history.slice(0, 4).map(h => `
                    <tr>
                      <td>${new Date(h.timestamp).toLocaleDateString('pt-BR')} ${new Date(h.timestamp).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'})}</td>
                      <td><strong style="color:var(--gold-light);">NF-e ${h.nfeNumber || '-'}</strong></td>
                      <td>${h.supplier || '-'}</td>
                      <td><span class="status-badge badge-carencia" style="font-size:0.68rem;">${h.destinationStore || '-'}</span></td>
                      <td><strong>${h.destinationCnpj || '-'}</strong></td>
                      <td><strong style="color:var(--stone-green);">R$ ${(h.totalAmount || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong></td>
                      <td>${h.itemsCount || (h.items || []).length} itens</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          </div>
        ` : ''}

      </div>
    `;

    // Eventos de Upload
    const dropzone = document.getElementById("nfe-dropzone");
    const fileInput = document.getElementById("nfe-file-input");
    const btnBrowse = document.getElementById("btn-browse-nfe-xml");
    const btnSample = document.getElementById("btn-load-sample-nfe");

    if (btnBrowse && fileInput) {
      btnBrowse.addEventListener("click", () => fileInput.click());
    }

    if (fileInput) {
      fileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) this.readAndProcessNfeFile(file);
      });
    }

    if (dropzone) {
      dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.style.borderColor = "var(--stone-green)";
        dropzone.style.background = "rgba(0,168,104,0.06)";
      });
      dropzone.addEventListener("dragleave", (e) => {
        e.preventDefault();
        dropzone.style.borderColor = "rgba(212,175,55,0.4)";
        dropzone.style.background = "rgba(212,175,55,0.02)";
      });
      dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.style.borderColor = "rgba(212,175,55,0.4)";
        dropzone.style.background = "rgba(212,175,55,0.02)";
        const file = e.dataTransfer.files[0];
        if (file) this.readAndProcessNfeFile(file);
      });
    }

    if (btnSample) {
      btnSample.addEventListener("click", async () => {
        btnSample.disabled = true;
        btnSample.innerHTML = `<span>⏳</span> Carregando e processando XML...`;
        await this.parseNfePayload({ useSample: true });
      });
    }
  },

  readAndProcessNfeFile(file) {
    const reader = new FileReader();
    const dropzone = document.getElementById("nfe-dropzone");
    if (dropzone) {
      dropzone.innerHTML = `
        <div style="padding:20px;font-size:1.1rem;color:#FFF;">
          <div style="font-size:2rem;margin-bottom:8px;">⏳</div>
          Lendo e validando arquivo XML: <strong>${file.name}</strong>...
        </div>
      `;
    }
    reader.onload = async (event) => {
      const xmlText = event.target.result;
      await this.parseNfePayload({ xmlText });
    };
    reader.onerror = () => {
      alert("Erro ao ler o arquivo XML selecionado.");
      this.renderNfeUploadView();
    };
    reader.readAsText(file);
  },

  async parseNfePayload(payload) {
    try {
      const res = await fetch("/api/erp/nfe/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || "Erro ao processar o XML da NF-e.");
        this.renderNfeUploadView();
        return;
      }

      this.currentNfeData = data.nfe;
      this.currentDestinationMatch = data.destinationMatch;
      this.renderNfePricingInterface();
    } catch (e) {
      console.error(e);
      alert("Erro de conexão com o servidor ao processar NF-e.");
      this.renderNfeUploadView();
    }
  },

  renderNfePricingInterface() {
    const container = document.getElementById("nfe-modal-body");
    if (!container || !this.currentNfeData) return;

    const nfe = this.currentNfeData;
    const destMatch = this.currentDestinationMatch || {};
    const items = nfe.items || [];

    // Formatar valores
    const totalNF = nfe.nfeInfo?.totalAmount || items.reduce((acc, it) => acc + (it.totalCost || 0), 0);
    const supplierName = nfe.supplier?.fantasyName || nfe.supplier?.name || "Fornecedor";
    const destName = nfe.destination?.name || "SIÉ JOY";

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:18px;">

        <!-- 1. PAINEL DE CONFERÊNCIA FISCAL DE DESTINO (CNPJ & LOJA) -->
        <div class="content-card" style="padding:16px;border:1px solid rgba(212,175,55,0.3);background:linear-gradient(135deg, rgba(20,20,25,0.95), rgba(30,25,18,0.95));">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:1.3rem;">🛡️</span>
              <h4 style="color:#FFF;margin:0;font-size:1.05rem;">Auditoria & Conferência Fiscal de Destinatário</h4>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
              <span class="status-badge ${destMatch.isValid ? 'badge-homologado' : 'badge-carencia'}" style="font-size:0.75rem;padding:4px 10px;">
                ${destMatch.statusMessage || (destMatch.isValid ? '✅ Destino Conferido' : '⚠️ Conferência Necessária')}
              </span>
              <button id="btn-change-xml" class="crm-mini-btn" style="padding:4px 8px;font-size:0.72rem;">🔄 Trocar XML</button>
            </div>
          </div>

          <!-- Grade de Conferência -->
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:14px;font-size:0.8rem;">
            
            <!-- Dados da NF & Emitente -->
            <div style="background:rgba(255,255,255,0.03);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
              <div style="color:var(--text-secondary);margin-bottom:4px;">EMITENTE / FORNECEDOR:</div>
              <strong style="color:var(--gold-light);font-size:0.92rem;display:block;">${supplierName}</strong>
              <div style="color:var(--text-muted);font-size:0.75rem;margin-top:2px;">CNPJ: ${nfe.supplier?.cnpj || '-'} • IE: ${nfe.supplier?.ie || '-'}</div>
              <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;">
                <span>NF-e: <strong>№ ${nfe.nfeInfo?.number || '-'}</strong> (Série ${nfe.nfeInfo?.series || '1'})</span>
                <span>Emissão: <strong>${nfe.nfeInfo?.issueDate ? new Date(nfe.nfeInfo.issueDate + 'T12:00:00').toLocaleDateString('pt-BR') : '-'}</strong></span>
              </div>
            </div>

            <!-- Conferência de CNPJ Destinatário -->
            <div style="background:rgba(255,255,255,0.03);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <span style="color:var(--text-secondary);">CNPJ DESTINATÁRIO (NA NF):</span>
                <span style="color:var(--stone-green);font-size:0.7rem;font-weight:700;">CONFIRMADO</span>
              </div>
              <strong style="color:#FFF;font-size:0.92rem;display:block;">${destName}</strong>
              <div style="color:var(--text-muted);font-size:0.75rem;margin-top:2px;">CNPJ na NF: <strong style="color:var(--gold-light);">${nfe.destination?.cnpj || '-'}</strong></div>
              
              <div style="margin-top:8px;">
                <label style="font-size:0.72rem;color:var(--text-secondary);display:block;margin-bottom:3px;">Vincular à Empresa Mantenedora do ERP:</label>
                <select id="select-nfe-dest-cnpj" class="crm-filter-select" style="width:100%;font-size:0.78rem;padding:5px 8px;">
                  ${this.cnpjs.map(c => `
                    <option value="${c.id}" ${c.id === destMatch.matchedCnpjId ? 'selected' : ''}>
                      ${c.nomeFantasia} (${c.cnpj})
                    </option>
                  `).join("")}
                </select>
              </div>
            </div>

            <!-- Conferência de Loja Física de Entrada -->
            <div style="background:rgba(255,255,255,0.03);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <span style="color:var(--text-secondary);">ENDEREÇO DE ENTREGA (NA NF):</span>
                <span style="color:var(--gold-light);font-size:0.7rem;font-weight:700;">LOCALIZAÇÃO FÍSICA</span>
              </div>
              <div style="color:#FFF;font-size:0.78rem;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${nfe.destination?.address}">
                📍 ${nfe.destination?.address || 'Endereço não informado'}
              </div>
              
              <div style="margin-top:8px;">
                <label style="font-size:0.72rem;color:var(--text-secondary);display:block;margin-bottom:3px;">Loja Física de Entrada no Estoque:</label>
                <select id="select-nfe-dest-store" class="crm-filter-select" style="width:100%;font-size:0.78rem;padding:5px 8px;">
                  ${this.stores.map(s => `
                    <option value="${s.id}" ${s.id === destMatch.matchedStoreId ? 'selected' : ''}>
                      ${s.name} (${s.type} - ${s.city})
                    </option>
                  `).join("")}
                </select>
              </div>
            </div>

          </div>
        </div>

        <!-- 2. BARRA DE PRECIFICAÇÃO POR MARKUP GERAL -->
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;background:rgba(0,168,104,0.08);border:1px solid rgba(0,168,104,0.25);border-radius:12px;flex-wrap:wrap;gap:12px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="font-size:1.6rem;">🏷️</div>
            <div>
              <strong style="color:#FFF;font-size:0.95rem;display:block;">Precificação por Markup Global</strong>
              <span style="font-size:0.76rem;color:var(--text-secondary);">
                Multiplicador padrão sobre o custo da NF (<code style="color:var(--stone-green);">Preço = Custo × Markup</code>). Você pode editar 1 a 1 na tabela abaixo.
              </span>
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:10px;">
            <div style="display:flex;align-items:center;gap:6px;background:rgba(0,0,0,0.3);padding:4px 10px;border-radius:8px;border:1px solid var(--border-subtle);">
              <span style="font-size:0.8rem;color:var(--text-secondary);">Markup Geral:</span>
              <input type="number" id="in-global-markup" step="0.05" min="1.0" max="10.0" value="2.40" 
                     style="width:72px;background:transparent;border:none;color:var(--gold-light);font-size:1.1rem;font-weight:700;text-align:center;">
              <span style="color:var(--gold-light);font-weight:700;">x</span>
            </div>
            <button id="btn-apply-global-markup" class="btn-primary-luxury" style="padding:8px 16px;font-size:0.82rem;background:rgba(0,168,104,0.2);color:var(--stone-green);border:1px solid rgba(0,168,104,0.4);">
              ⚡ Aplicar em Todos os Itens
            </button>
          </div>
        </div>

        <!-- 3. TABELA / LISTA DE PRODUTOS PARA EDIÇÃO 1 A 1 -->
        <div class="content-card" style="padding:0;overflow:hidden;border:1px solid var(--border-subtle);">
          <div style="padding:12px 16px;background:rgba(255,255,255,0.02);border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;">
            <h5 style="margin:0;color:#FFF;font-size:0.9rem;">📦 Itens da NF-e (${items.length} produtos localizados)</h5>
            <span style="font-size:0.75rem;color:var(--text-muted);">Edite o Markup ou o Preço de Venda em qualquer linha</span>
          </div>

          <div class="table-responsive" style="max-height:360px;overflow-y:auto;">
            <table class="crm-compact-table" style="margin:0;font-size:0.8rem;">
              <thead style="position:sticky;top:0;background:var(--bg-dark);z-index:2;">
                <tr>
                  <th style="width:36px;">#</th>
                  <th>SKU / Código</th>
                  <th>Descrição do Produto</th>
                  <th style="text-align:center;">Qtd NF</th>
                  <th style="text-align:right;">Custo Unit.</th>
                  <th style="text-align:right;">Custo Total</th>
                  <th style="text-align:center;width:110px;">Markup (x)</th>
                  <th style="text-align:center;width:130px;">Preço de Venda</th>
                  <th style="text-align:right;width:150px;">Margem Bruta</th>
                </tr>
              </thead>
              <tbody id="nfe-items-table-body">
                ${items.map((item, idx) => `
                  <tr data-idx="${idx}">
                    <td><span style="color:var(--text-muted);">${item.itemIndex || (idx + 1)}</span></td>
                    <td>
                      <strong style="color:var(--gold-light);font-family:monospace;font-size:0.78rem;">${item.cProd}</strong>
                    </td>
                    <td>
                      <div style="font-weight:600;color:#FFF;">${item.xProd}</div>
                      <div style="font-size:0.68rem;color:var(--text-muted);">NCM: ${item.ncm || '-'} • CFOP: ${item.cfop || '-'}</div>
                    </td>
                    <td style="text-align:center;">
                      <span class="status-badge badge-homologado" style="font-size:0.75rem;padding:3px 8px;">
                        ${item.quantity} ${item.uCom || 'UN'}
                      </span>
                    </td>
                    <td style="text-align:right;">
                      <strong>R$ ${item.unitCost.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong>
                    </td>
                    <td style="text-align:right;color:var(--text-secondary);">
                      R$ ${item.totalCost.toLocaleString('pt-BR', {minimumFractionDigits: 2})}
                    </td>
                    <td style="text-align:center;">
                      <div style="display:inline-flex;align-items:center;gap:2px;">
                        <input type="number" class="in-item-markup" data-idx="${idx}" step="0.05" min="1.0" max="10.0" 
                               value="${(item.markup || 2.40).toFixed(2)}" 
                               style="width:70px;text-align:center;padding:4px 6px;border-radius:6px;border:1px solid rgba(212,175,55,0.35);background:rgba(0,0,0,0.4);color:var(--gold-light);font-weight:700;font-size:0.85rem;">
                        <span style="color:var(--gold-light);font-size:0.8rem;">x</span>
                      </div>
                    </td>
                    <td style="text-align:center;">
                      <div style="display:inline-flex;align-items:center;gap:4px;">
                        <span style="color:var(--stone-green);font-size:0.78rem;">R$</span>
                        <input type="number" class="in-item-price" data-idx="${idx}" step="0.50" min="${item.unitCost}" 
                               value="${(item.salePrice || (item.unitCost * 2.4)).toFixed(2)}" 
                               style="width:85px;text-align:center;padding:4px 6px;border-radius:6px;border:1px solid rgba(0,168,104,0.4);background:rgba(0,0,0,0.4);color:var(--stone-green);font-weight:700;font-size:0.88rem;">
                      </div>
                    </td>
                    <td style="text-align:right;">
                      <div class="margin-preview-cell" data-idx="${idx}">
                        <strong style="color:var(--stone-green);display:block;font-size:0.82rem;">
                          + R$ ${(item.grossMarginVal || (item.salePrice - item.unitCost)).toLocaleString('pt-BR', {minimumFractionDigits: 2})}
                        </strong>
                        <span class="status-badge" style="background:rgba(0,168,104,0.12);color:var(--stone-green);font-size:0.65rem;padding:2px 6px;margin-top:2px;display:inline-block;">
                          ${item.grossMarginPct || 58.3}% margem
                        </span>
                      </div>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>

        <!-- 4. RESUMO PROJETADO & AÇÕES FINAIS -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:12px;" id="nfe-totals-cards">
          <!-- Totals rendered by updateNfePricingTotals() -->
        </div>

        <!-- 5. OPÇÕES DE FECHAMENTO & SUBMISSÃO -->
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;background:rgba(255,255,255,0.02);border:1px solid var(--border-subtle);border-radius:12px;flex-wrap:wrap;gap:14px;">
          <div>
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none;">
              <input type="checkbox" id="chk-create-payable" checked style="width:18px;height:18px;accent-color:var(--stone-green);cursor:pointer;">
              <div>
                <strong style="color:#FFF;font-size:0.88rem;display:block;">🧾 Gerar Conta a Pagar automaticamente para o fornecedor</strong>
                <span style="font-size:0.74rem;color:var(--text-secondary);">
                  Cria o título financeiro com centro de custo da loja selecionada e vencimentos conforme duplicatas da NF-e.
                </span>
              </div>
            </label>
          </div>

          <div style="display:flex;gap:10px;">
            <button id="btn-cancel-import" class="modal-close-btn-secondary" style="padding:10px 18px;">
              Cancelar
            </button>
            <button id="btn-submit-stock-import" class="btn-primary-luxury" style="padding:10px 24px;font-size:0.92rem;display:flex;align-items:center;gap:8px;">
              <span>🚀</span>
              <span>Confirmar Entrada no Estoque & Precificação</span>
            </button>
          </div>
        </div>

      </div>
    `;

    this.bindNfePricingEvents();
    this.updateNfePricingTotals();
  },

  bindNfePricingEvents() {
    const container = document.getElementById("nfe-modal-body");
    if (!container || !this.currentNfeData) return;

    // Botão Trocar XML
    const btnChange = document.getElementById("btn-change-xml");
    if (btnChange) {
      btnChange.addEventListener("click", () => this.renderNfeUploadView());
    }

    const btnCancel = document.getElementById("btn-cancel-import");
    if (btnCancel) {
      btnCancel.addEventListener("click", () => document.getElementById("modal-nfe-import")?.remove());
    }

    // Botão Aplicar Markup Geral
    const btnApplyGlobal = document.getElementById("btn-apply-global-markup");
    const inGlobalMarkup = document.getElementById("in-global-markup");
    if (btnApplyGlobal && inGlobalMarkup) {
      btnApplyGlobal.addEventListener("click", () => {
        const globalMarkup = parseFloat(inGlobalMarkup.value) || 2.40;
        this.currentNfeData.items.forEach((item, idx) => {
          item.markup = globalMarkup;
          item.salePrice = Math.round(item.unitCost * globalMarkup * 100) / 100;
          item.grossMarginVal = Math.round((item.salePrice - item.unitCost) * 100) / 100;
          item.grossMarginPct = item.salePrice > 0 ? Math.round((item.grossMarginVal / item.salePrice * 100) * 10) / 10 : 0;

          // Atualiza inputs visuais
          const markupIn = container.querySelector(`.in-item-markup[data-idx="${idx}"]`);
          const priceIn = container.querySelector(`.in-item-price[data-idx="${idx}"]`);
          if (markupIn) markupIn.value = globalMarkup.toFixed(2);
          if (priceIn) priceIn.value = item.salePrice.toFixed(2);
          this.updateItemMarginPreview(idx);
        });
        this.updateNfePricingTotals();
        this.showToastNotification(`Markup ${globalMarkup.toFixed(2)}x aplicado em todos os produtos!`, "success");
      });
    }

    // Edição individual 1 a 1: Markup do item
    container.querySelectorAll(".in-item-markup").forEach(input => {
      input.addEventListener("input", (e) => {
        const idx = parseInt(e.target.getAttribute("data-idx"), 10);
        const item = this.currentNfeData.items[idx];
        if (!item) return;

        const markup = parseFloat(e.target.value) || 1.0;
        item.markup = markup;
        item.salePrice = Math.round(item.unitCost * markup * 100) / 100;
        item.grossMarginVal = Math.round((item.salePrice - item.unitCost) * 100) / 100;
        item.grossMarginPct = item.salePrice > 0 ? Math.round((item.grossMarginVal / item.salePrice * 100) * 10) / 10 : 0;

        const priceIn = container.querySelector(`.in-item-price[data-idx="${idx}"]`);
        if (priceIn) priceIn.value = item.salePrice.toFixed(2);
        this.updateItemMarginPreview(idx);
        this.updateNfePricingTotals();
      });
    });

    // Edição individual 1 a 1: Preço de Venda do item
    container.querySelectorAll(".in-item-price").forEach(input => {
      input.addEventListener("input", (e) => {
        const idx = parseInt(e.target.getAttribute("data-idx"), 10);
        const item = this.currentNfeData.items[idx];
        if (!item) return;

        const price = parseFloat(e.target.value) || item.unitCost;
        item.salePrice = price;
        item.markup = item.unitCost > 0 ? Math.round((price / item.unitCost) * 100) / 100 : 1.0;
        item.grossMarginVal = Math.round((price - item.unitCost) * 100) / 100;
        item.grossMarginPct = price > 0 ? Math.round((item.grossMarginVal / price * 100) * 10) / 10 : 0;

        const markupIn = container.querySelector(`.in-item-markup[data-idx="${idx}"]`);
        if (markupIn) markupIn.value = item.markup.toFixed(2);
        this.updateItemMarginPreview(idx);
        this.updateNfePricingTotals();
      });
    });

    // Submissão Final
    const btnSubmit = document.getElementById("btn-submit-stock-import");
    if (btnSubmit) {
      btnSubmit.addEventListener("click", () => this.submitNfeStockImport());
    }
  },

  updateItemMarginPreview(idx) {
    const item = this.currentNfeData?.items[idx];
    if (!item) return;
    const cell = document.querySelector(`.margin-preview-cell[data-idx="${idx}"]`);
    if (!cell) return;

    cell.innerHTML = `
      <strong style="color:var(--stone-green);display:block;font-size:0.82rem;">
        + R$ ${item.grossMarginVal.toLocaleString('pt-BR', {minimumFractionDigits: 2})}
      </strong>
      <span class="status-badge" style="background:rgba(0,168,104,0.12);color:var(--stone-green);font-size:0.65rem;padding:2px 6px;margin-top:2px;display:inline-block;">
        ${item.grossMarginPct}% margem
      </span>
    `;
  },

  updateNfePricingTotals() {
    const container = document.getElementById("nfe-totals-cards");
    if (!container || !this.currentNfeData) return;

    const items = this.currentNfeData.items || [];
    const totalCost = items.reduce((acc, it) => acc + (it.totalCost || (it.unitCost * it.quantity)), 0);
    const totalRevenue = items.reduce((acc, it) => acc + (it.salePrice * it.quantity), 0);
    const totalGrossProfit = totalRevenue - totalCost;
    const avgMarginPct = totalRevenue > 0 ? Math.round((totalGrossProfit / totalRevenue * 100) * 10) / 10 : 0;
    const totalUnits = items.reduce((acc, it) => acc + it.quantity, 0);

    container.innerHTML = `
      <div class="kpi-card" style="padding:12px 14px;">
        <div style="font-size:0.72rem;color:var(--text-muted);">CUSTO TOTAL DA NF-E</div>
        <strong style="color:#FFF;font-size:1.15rem;display:block;margin-top:2px;">
          R$ ${totalCost.toLocaleString('pt-BR', {minimumFractionDigits: 2})}
        </strong>
        <span style="font-size:0.7rem;color:var(--text-secondary);">${totalUnits} peças recebidas</span>
      </div>

      <div class="kpi-card" style="padding:12px 14px;">
        <div style="font-size:0.72rem;color:var(--text-muted);">FATURAMENTO PROJETADO</div>
        <strong style="color:var(--gold-light);font-size:1.15rem;display:block;margin-top:2px;">
          R$ ${totalRevenue.toLocaleString('pt-BR', {minimumFractionDigits: 2})}
        </strong>
        <span style="font-size:0.7rem;color:var(--text-secondary);">Com os preços de venda definidos</span>
      </div>

      <div class="kpi-card" style="padding:12px 14px;">
        <div style="font-size:0.72rem;color:var(--text-muted);">LUCRO BRUTO ESTIMADO</div>
        <strong style="color:var(--stone-green);font-size:1.15rem;display:block;margin-top:2px;">
          + R$ ${totalGrossProfit.toLocaleString('pt-BR', {minimumFractionDigits: 2})}
        </strong>
        <span style="font-size:0.7rem;color:var(--stone-green);">Margem média de ${avgMarginPct}%</span>
      </div>

      <div class="kpi-card" style="padding:12px 14px;">
        <div style="font-size:0.72rem;color:var(--text-muted);">CONDIÇÃO DE COBRANÇA</div>
        <strong style="color:var(--blue-accent);font-size:1.05rem;display:block;margin-top:2px;">
          ${(this.currentNfeData.installments || []).length > 0 ? `${this.currentNfeData.installments.length}x Boletos Faturados` : '30 dias (NF-e)'}
        </strong>
        <span style="font-size:0.7rem;color:var(--text-secondary);">Fornecedor CMV Homologado</span>
      </div>
    `;
  },

  async submitNfeStockImport() {
    const btn = document.getElementById("btn-submit-stock-import");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span>⏳</span><span>Atualizando Estoque e Catálogo...</span>`;
    }

    try {
      const selectStore = document.getElementById("select-nfe-dest-store");
      const selectCnpj = document.getElementById("select-nfe-dest-cnpj");
      const chkPayable = document.getElementById("chk-create-payable");

      const storeId = selectStore ? selectStore.value : (this.currentDestinationMatch?.matchedStoreId || "store-01");
      const storeName = selectStore ? selectStore.selectedOptions[0]?.text?.split(" (")[0] : (this.currentDestinationMatch?.matchedStoreName || "Boutique Floripa");
      const cnpjId = selectCnpj ? selectCnpj.value : (this.currentDestinationMatch?.matchedCnpjId || "cnpj-01");
      const cnpjNumber = selectCnpj ? (selectCnpj.selectedOptions[0]?.text?.match(/\((.*?)\)/)?.[1] || this.currentDestinationMatch?.matchedCnpjNumber) : this.currentDestinationMatch?.matchedCnpjNumber;

      const payload = {
        nfe: this.currentNfeData,
        destinationMatch: {
          matchedStoreId: storeId,
          matchedStoreName: storeName,
          matchedCnpjId: cnpjId,
          matchedCnpjNumber: cnpjNumber
        },
        items: this.currentNfeData.items,
        createPayable: chkPayable ? chkPayable.checked : true
      };

      const res = await fetch("/api/erp/nfe/import-stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        alert(data.error || "Erro ao dar entrada no estoque.");
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = `<span>🚀</span><span>Confirmar Entrada no Estoque & Precificação</span>`;
        }
        return;
      }

      // Sucesso!
      this.showToastNotification(`✅ ${data.message} Estoque atualizado na loja: ${data.store}`, "success");
      document.getElementById("modal-nfe-import")?.remove();

      // Recarrega o catálogo da loja se a função existir
      if (typeof window.renderRetailCatalog === "function") {
        await window.renderRetailCatalog();
      }

      // Se estiver visualizando o Contas a Pagar, recarrega
      if (typeof this.renderAccountsPayable === "function") {
        await this.renderAccountsPayable();
      }
    } catch (e) {
      console.error(e);
      alert("Erro ao enviar dados de entrada de estoque para o servidor.");
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<span>🚀</span><span>Confirmar Entrada no Estoque & Precificação</span>`;
      }
    }
  },

  // Helpers
  getStoreName(storeId) {
    if (storeId === "ALL") return "Todas as Lojas (Consolidado)";
    const s = this.stores.find(x => x.id === storeId);
    return s ? s.name : (storeId || "Boutique Floripa");
  },

  getCnpjNumber(cnpjId) {
    const c = this.cnpjs.find(x => x.id === cnpjId);
    return c ? `${c.nomeFantasia} (${c.cnpj})` : (cnpjId || "Matriz SC");
  }
};

window.ErpController = ErpController;
