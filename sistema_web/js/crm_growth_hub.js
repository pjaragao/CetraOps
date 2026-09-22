/**
 * SIÉ Joy OS - CRM, Growth & Marketing Hub Controller
 * Gerencia CRM Kanban, Motores de Scraping (Apify + instagrapi), Meta Ads Granular,
 * Herme Agent WhatsApp ERP e Playbook de Engajamento Manual Anti-Ban.
 */

const CrmGrowthHub = {
  currentSubTab: "crm-kanban",
  crmViewMode: "list", // Default: compact list view as requested
  leads: [],
  targets: [],
  aiSuggestions: [],
  qualificationRules: null,
  metaAdsData: null,
  playbookData: null,
  catalog: [],
  timerRemaining: 180,
  timerInterval: null,
  isInitialized: false,

  async init() {
    await this.fetchLeads();
    await this.fetchTargets();
    await this.fetchQualificationRules();
    await this.fetchMetaAdsData();
    await this.fetchPlaybookData();
    await this.fetchCatalog();
    this.setupSubnavListeners();
    this.setupGlobalListeners();
    this.isInitialized = true;
    this.renderCrmView();
  },

  // --- CRM VIEW TOGGLING ---
  switchCrmView(mode) {
    this.crmViewMode = mode;
    const btnViewList = document.getElementById("btn-crm-view-list");
    const btnViewKanban = document.getElementById("btn-crm-view-kanban");
    const listView = document.getElementById("crm-list-view");
    const kanbanView = document.getElementById("crm-kanban-view");

    if (btnViewList) btnViewList.classList.toggle("active", mode === "list");
    if (btnViewKanban) btnViewKanban.classList.toggle("active", mode === "kanban");
    if (listView) listView.style.display = mode === "list" ? "block" : "none";
    if (kanbanView) kanbanView.style.display = mode === "kanban" ? "block" : "none";

    const searchVal = document.getElementById("crm-search-input")?.value?.trim() || "";
    this.renderCrmView(searchVal);
  },

  renderCrmView(searchQuery = "") {
    if (this.crmViewMode === "list") {
      this.renderCrmList(searchQuery);
    } else {
      this.renderCrmKanban(searchQuery);
    }
  },

  // =========================================================================
  // 1. CRM COMPACT LIST VIEW (DEFAULT)
  // =========================================================================
  renderCrmList(searchQuery = "") {
    const tbody = document.getElementById("crm-table-body");
    if (!tbody) return;

    const stagesMap = {
      "NOVO_LEAD": { name: "Novo Lead", icon: "🌱", color: "#94A3B8", bg: "rgba(148,163,184,0.15)" },
      "QUALIFICADO": { name: "Qualificado High-Ticket", icon: "⭐", color: "#F59E0B", bg: "rgba(245,158,11,0.15)" },
      "CAMPANHA_META": { name: "Em Campanha Meta", icon: "📈", color: "#38BDF8", bg: "rgba(56,189,248,0.15)" },
      "EM_CONTATO_IA": { name: "Em Atendimento IA", icon: "🤖", color: "#818CF8", bg: "rgba(129,140,248,0.15)" },
      "VISITA_AGENDADA": { name: "Armário VIP / Visita", icon: "🎀", color: "#D4AF37", bg: "rgba(212,175,55,0.15)" },
      "CONVERTIDO": { name: "Convertido Stone POS", icon: "💳", color: "#10B981", bg: "rgba(16,185,129,0.15)" },
      "RECOMPRA": { name: "Cliente VIP / Recompra", icon: "👑", color: "#EC4899", bg: "rgba(236,72,153,0.15)" }
    };

    const stageOrder = ["NOVO_LEAD", "QUALIFICADO", "CAMPANHA_META", "EM_CONTATO_IA", "VISITA_AGENDADA", "CONVERTIDO", "RECOMPRA"];

    let filteredLeads = this.leads;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filteredLeads = this.leads.filter(l =>
        l.name.toLowerCase().includes(q) ||
        l.instagram.toLowerCase().includes(q) ||
        l.bio.toLowerCase().includes(q) ||
        (l.city && l.city.toLowerCase().includes(q)) ||
        (l.tags && l.tags.some(t => t.toLowerCase().includes(q)))
      );
    }

    if (filteredLeads.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--text-muted);">Nenhum lead encontrado com os filtros atuais.</td></tr>`;
      return;
    }

    tbody.innerHTML = filteredLeads.map(lead => {
      const stageInfo = stagesMap[lead.stage] || { name: lead.stage, icon: "📌", color: "#FFF", bg: "rgba(255,255,255,0.1)" };
      const currentIdx = stageOrder.indexOf(lead.stage);
      const nextStage = currentIdx < stageOrder.length - 1 ? stageOrder[currentIdx + 1] : null;

      const phoneClean = (lead.phone || "").replace(/\D/g, "");
      const waLink = phoneClean ? `https://wa.me/55${phoneClean}?text=${encodeURIComponent("Olá " + lead.name + "! Sou da SIÉ Wear @ JOY Wellness Club...")}` : null;

      return `
        <tr data-lead-id="${lead.id}">
          <td>
            <div class="crm-lead-cell">
              <img src="${lead.avatar}" alt="${lead.name}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(lead.name)}&background=1E293B&color=D4AF37'">
              <div class="name-box">
                <span class="name">${lead.name}</span>
                <a href="https://instagram.com/${lead.instagram}" target="_blank" class="handle">@${lead.instagram}</a>
              </div>
            </div>
          </td>
          <td>
            <span class="crm-stage-pill" style="color:${stageInfo.color};background:${stageInfo.bg};border:1px solid ${stageInfo.color}40;">
              <span>${stageInfo.icon}</span>
              <span>${stageInfo.name}</span>
            </span>
          </td>
          <td>
            ${this.renderStars(lead.score)}
          </td>
          <td>
            <div style="display:flex;gap:4px;flex-wrap:wrap;max-width:260px;">
              ${(lead.tags || []).map(t => `<span class="lead-tag ${['Médica', 'High-Ticket', 'JOY Member'].includes(t) ? 'highlight' : ''}" style="font-size:0.68rem;padding:2px 6px;">${t}</span>`).join("")}
            </div>
          </td>
          <td>
            <span class="lead-tag" style="font-size:0.7rem;">${lead.source || "Scraping"}</span>
          </td>
          <td>
            ${phoneClean ? `
              <a href="${waLink}" target="_blank" class="crm-mini-btn btn-wa" title="Conversar no WhatsApp">
                <span>💬</span>
                <span>${lead.phone}</span>
              </a>
            ` : `<span style="color:var(--text-muted);font-size:0.75rem;">Sem número</span>`}
          </td>
          <td style="text-align:right;">
            <div class="crm-action-buttons" style="justify-content:flex-end;">
              <button class="crm-mini-btn btn-view-lead" data-lead-id="${lead.id}" title="Ver Ficha 360°">
                <span>🔍 Ficha</span>
              </button>
              ${nextStage ? `
                <button class="crm-mini-btn btn-move-stage-list" data-lead-id="${lead.id}" data-next-stage="${nextStage}" title="Avançar para próxima etapa">
                  <span>➔</span>
                </button>
              ` : ""}
            </div>
          </td>
        </tr>
      `;
    }).join("");

    // Wire clicks on list items
    tbody.querySelectorAll(".btn-view-lead").forEach(btn => {
      btn.addEventListener("click", () => {
        const leadId = btn.getAttribute("data-lead-id");
        this.showLeadDetailsModal(leadId);
      });
    });

    tbody.querySelectorAll(".btn-move-stage-list").forEach(btn => {
      btn.addEventListener("click", async () => {
        const leadId = btn.getAttribute("data-lead-id");
        const nextStage = btn.getAttribute("data-next-stage");
        await this.updateLeadStage(leadId, nextStage);
        this.renderCrmView(searchQuery);
      });
    });
  },

  // =========================================================================
  // 1B. CRM KANBAN BOARD (ALTERNATIVE VIEW)
  // =========================================================================
  renderCrmKanban(searchQuery = "") {
    const container = document.getElementById("kanban-board-container");
    if (!container) return;

    const stages = [
      { id: "NOVO_LEAD", name: "Novo Lead", icon: "🌱", color: "#94A3B8" },
      { id: "QUALIFICADO", name: "Qualificado High-Ticket", icon: "⭐", color: "#F59E0B" },
      { id: "CAMPANHA_META", name: "Em Campanha Meta", icon: "📈", color: "#38BDF8" },
      { id: "EM_CONTATO_IA", name: "Em Atendimento IA", icon: "🤖", color: "#818CF8" },
      { id: "VISITA_AGENDADA", name: "Armário VIP / Visita", icon: "🎀", color: "#D4AF37" },
      { id: "CONVERTIDO", name: "Convertido Stone POS", icon: "💳", color: "#10B981" },
      { id: "RECOMPRA", name: "Cliente VIP / Recompra", icon: "👑", color: "#EC4899" }
    ];

    let filteredLeads = this.leads;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filteredLeads = this.leads.filter(l => 
        l.name.toLowerCase().includes(q) ||
        l.instagram.toLowerCase().includes(q) ||
        l.bio.toLowerCase().includes(q) ||
        (l.city && l.city.toLowerCase().includes(q)) ||
        (l.tags && l.tags.some(t => t.toLowerCase().includes(q)))
      );
    }

    container.innerHTML = stages.map(stage => {
      const stageLeads = filteredLeads.filter(l => l.stage === stage.id);
      return `
        <div class="kanban-col" data-stage-id="${stage.id}">
          <div class="kanban-col-header">
            <span class="kanban-col-title" style="color:${stage.color};">
              <span>${stage.icon}</span>
              <span>${stage.name}</span>
            </span>
            <span class="kanban-col-count">${stageLeads.length}</span>
          </div>

          <div class="kanban-col-cards">
            ${stageLeads.map(lead => this.createLeadCardHtml(lead, stages)).join("")}
            ${stageLeads.length === 0 ? `<div style="text-align:center;padding:30px 10px;color:var(--text-muted);font-size:0.75rem;">Nenhum lead nesta etapa</div>` : ""}
          </div>
        </div>
      `;
    }).join("");

    // Wire clicks on cards
    container.querySelectorAll(".lead-card").forEach(card => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".lead-quick-actions") || e.target.closest("a")) return;
        const leadId = card.getAttribute("data-lead-id");
        this.showLeadDetailsModal(leadId);
      });
    });

    // Wire stage move buttons
    container.querySelectorAll(".btn-move-stage").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const leadId = btn.getAttribute("data-lead-id");
        const nextStage = btn.getAttribute("data-next-stage");
        await this.updateLeadStage(leadId, nextStage);
        this.renderCrmView(searchQuery);
      });
    });
  },

  // --- API CALLS ---
  async fetchLeads(stage = "", search = "") {
    try {
      let url = "/api/crm/leads";
      const params = [];
      if (stage) params.push(`stage=${encodeURIComponent(stage)}`);
      if (search) params.push(`search=${encodeURIComponent(search)}`);
      if (params.length > 0) url += `?${params.join("&")}`;

      const res = await fetch(url);
      const data = await res.json();
      this.leads = data.leads || [];
      return this.leads;
    } catch (e) {
      console.error("Erro ao carregar leads:", e);
      return [];
    }
  },

  async fetchTargets() {
    try {
      const res = await fetch("/api/scraping/targets");
      const data = await res.json();
      this.targets = data.targets || [];
      this.aiSuggestions = data.aiSuggestions || [];
      return data;
    } catch (e) {
      console.error("Erro ao carregar alvos de scraping:", e);
      return { targets: [], aiSuggestions: [] };
    }
  },

  async fetchQualificationRules() {
    try {
      const res = await fetch("/api/crm/qualification-rules");
      this.qualificationRules = await res.json();
      return this.qualificationRules;
    } catch (e) {
      console.error("Erro ao carregar regras de qualificação:", e);
      return null;
    }
  },

  async fetchMetaAdsData() {
    try {
      const res = await fetch("/api/meta-ads/data");
      this.metaAdsData = await res.json();
      return this.metaAdsData;
    } catch (e) {
      console.error("Erro ao carregar dados do Meta Ads:", e);
      return null;
    }
  },

  async fetchPlaybookData() {
    try {
      const res = await fetch("/api/playbook/safe-engagement");
      this.playbookData = await res.json();
      return this.playbookData;
    } catch (e) {
      console.error("Erro ao carregar playbook:", e);
      return null;
    }
  },

  async fetchCatalog() {
    try {
      const res = await fetch("/api/catalog");
      this.catalog = await res.json();
      return this.catalog;
    } catch (e) {
      console.error("Erro ao carregar catálogo ERP:", e);
      return [];
    }
  },

  // --- SUBNAV SWITCHING ---
  setupSubnavListeners() {
    const subnavBtns = document.querySelectorAll(".growth-subnav-btn");
    subnavBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        const subtab = btn.getAttribute("data-subtab");
        this.switchSubTab(subtab);
      });
    });
  },

  switchSubTab(subtabName) {
    this.currentSubTab = subtabName;
    document.querySelectorAll(".growth-subnav-btn").forEach(b => {
      b.classList.toggle("active", b.getAttribute("data-subtab") === subtabName);
    });
    document.querySelectorAll(".growth-subtab-pane").forEach(p => {
      p.classList.toggle("active", p.id === `pane-${subtabName}`);
    });

    if (subtabName === "crm-kanban") this.renderCrmKanban();
    if (subtabName === "scraping-engine") this.renderScrapingEngine();
    if (subtabName === "meta-ads") this.renderMetaAds();
    if (subtabName === "herme-agent") this.renderHermeAgent();
    if (subtabName === "qualification-rules") this.renderQualificationRules();
    if (subtabName === "safe-playbook") this.renderSafePlaybook();
  },

  render() {
    this.switchSubTab(this.currentSubTab);
  },

  // =========================================================================
  // 1. CRM KANBAN
  // =========================================================================
  renderCrmKanban(searchQuery = "") {
    const container = document.getElementById("kanban-board-container");
    if (!container) return;

    const stages = [
      { id: "NOVO_LEAD", name: "Novo Lead", icon: "🌱", color: "#94A3B8" },
      { id: "QUALIFICADO", name: "Qualificado High-Ticket", icon: "⭐", color: "#F59E0B" },
      { id: "CAMPANHA_META", name: "Em Campanha Meta", icon: "📈", color: "#38BDF8" },
      { id: "EM_CONTATO_IA", name: "Em Atendimento IA", icon: "🤖", color: "#818CF8" },
      { id: "VISITA_AGENDADA", name: "Armário VIP / Visita", icon: "🎀", color: "#D4AF37" },
      { id: "CONVERTIDO", name: "Convertido Stone POS", icon: "💳", color: "#10B981" },
      { id: "RECOMPRA", name: "Cliente VIP / Recompra", icon: "👑", color: "#EC4899" }
    ];

    let filteredLeads = this.leads;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filteredLeads = this.leads.filter(l => 
        l.name.toLowerCase().includes(q) ||
        l.instagram.toLowerCase().includes(q) ||
        l.bio.toLowerCase().includes(q) ||
        (l.city && l.city.toLowerCase().includes(q)) ||
        (l.tags && l.tags.some(t => t.toLowerCase().includes(q)))
      );
    }

    container.innerHTML = stages.map(stage => {
      const stageLeads = filteredLeads.filter(l => l.stage === stage.id);
      return `
        <div class="kanban-col" data-stage-id="${stage.id}">
          <div class="kanban-col-header">
            <span class="kanban-col-title" style="color:${stage.color};">
              <span>${stage.icon}</span>
              <span>${stage.name}</span>
            </span>
            <span class="kanban-col-count">${stageLeads.length}</span>
          </div>

          <div class="kanban-col-cards">
            ${stageLeads.map(lead => this.createLeadCardHtml(lead, stages)).join("")}
            ${stageLeads.length === 0 ? `<div style="text-align:center;padding:30px 10px;color:var(--text-muted);font-size:0.75rem;">Nenhum lead nesta etapa</div>` : ""}
          </div>
        </div>
      `;
    }).join("");

    // Wire clicks on cards
    container.querySelectorAll(".lead-card").forEach(card => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".lead-quick-actions") || e.target.closest("a")) return;
        const leadId = card.getAttribute("data-lead-id");
        this.showLeadDetailsModal(leadId);
      });
    });

    // Wire stage move buttons
    container.querySelectorAll(".btn-move-stage").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const leadId = btn.getAttribute("data-lead-id");
        const nextStage = btn.getAttribute("data-next-stage");
        await this.updateLeadStage(leadId, nextStage);
        this.renderCrmKanban(searchQuery);
      });
    });
  },

  createLeadCardHtml(lead, stages) {
    const currentIdx = stages.findIndex(s => s.id === lead.stage);
    const prevStage = currentIdx > 0 ? stages[currentIdx - 1].id : null;
    const nextStage = currentIdx < stages.length - 1 ? stages[currentIdx + 1].id : null;

    const phoneClean = (lead.phone || "").replace(/\D/g, "");
    const waLink = phoneClean ? `https://wa.me/55${phoneClean}?text=${encodeURIComponent("Olá " + lead.name + "! Sou da SIÉ Wear @ JOY Wellness...")}` : "#";

    return `
      <div class="lead-card" data-lead-id="${lead.id}">
        <div class="lead-card-top">
          <img src="${lead.avatar}" class="lead-avatar-img" alt="${lead.name}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(lead.name)}&background=1E293B&color=D4AF37'">
          <div class="lead-meta">
            <div class="lead-name">${lead.name}</div>
            <a href="https://instagram.com/${lead.instagram}" target="_blank" class="lead-insta-link">
              <span>📸</span> @${lead.instagram}
            </a>
          </div>
        </div>

        <div class="lead-bio-snippet">${lead.bio}</div>

        <div class="lead-tags-row">
          ${(lead.tags || []).map(t => `<span class="lead-tag ${['Médica', 'High-Ticket', 'JOY Member'].includes(t) ? 'highlight' : ''}">${t}</span>`).join("")}
        </div>

        <div class="lead-card-footer">
          <div class="lead-score-stars">${this.renderStars(lead.score)}</div>
          <div class="lead-quick-actions">
            ${phoneClean ? `<a href="${waLink}" target="_blank" class="btn-icon-xs wa" title="Abrir WhatsApp">💬</a>` : ""}
            ${prevStage ? `<button class="btn-icon-xs btn-move-stage" data-lead-id="${lead.id}" data-next-stage="${prevStage}" title="Mover para etapa anterior">←</button>` : ""}
            ${nextStage ? `<button class="btn-icon-xs btn-move-stage" data-lead-id="${lead.id}" data-next-stage="${nextStage}" title="Avançar etapa">➔</button>` : ""}
          </div>
        </div>
      </div>
    `;
  },

  // =========================================================================
  // 2. SCRAPING ENGINE (APIFY + INSTAGRAPI)
  // =========================================================================
  renderScrapingEngine() {
    const tableBody = document.getElementById("targets-table-body");
    const instagrapiSelect = document.getElementById("select-instagrapi-target");

    if (tableBody) {
      tableBody.innerHTML = this.targets.map(t => `
        <tr>
          <td>
            <strong>${t.displayName}</strong>
            <div style="font-size:0.72rem;color:var(--text-muted);">${t.target}</div>
          </td>
          <td><span class="lead-tag">${t.category}</span></td>
          <td><strong style="color:var(--gold-light);">${t.leadsFound.toLocaleString()}</strong></td>
          <td><span class="engine-pill-badge engine-apify">ATIVO</span></td>
        </tr>
      `).join("");
    }

    if (instagrapiSelect) {
      instagrapiSelect.innerHTML = this.targets.map(t => `
        <option value="${t.target}">${t.displayName} (${t.type})</option>
      `).join("");
    }

    // Render AI suggestions list
    const aiList = document.getElementById("ai-suggestions-list");
    if (aiList) {
      aiList.innerHTML = this.aiSuggestions.map(s => `
        <div style="display:flex;justify-content:space-between;align-items:center;background:rgba(0,0,0,0.25);padding:8px 12px;border-radius:8px;font-size:0.78rem;">
          <div>
            <strong style="color:#FFF;">${s.displayName}</strong> (${s.category})
            <p style="color:var(--text-secondary);font-size:0.72rem;margin-top:2px;">${s.reason}</p>
          </div>
          <button class="btn-primary-luxury btn-add-ai-target" data-target="${s.target}" data-name="${s.displayName}" data-cat="${s.category}" data-type="${s.type}" style="padding:4px 10px;font-size:0.72rem;">
            + Adicionar
          </button>
        </div>
      `).join("");

      aiList.querySelectorAll(".btn-add-ai-target").forEach(btn => {
        btn.addEventListener("click", async () => {
          const target = btn.getAttribute("data-target");
          const type = btn.getAttribute("data-type");
          const category = btn.getAttribute("data-cat");
          await this.addScrapingTarget(target, type, category);
          this.renderScrapingEngine();
          alert(`Alvo "${target}" adicionado com sucesso!`);
        });
      });
    }
  },

  // =========================================================================
  // 3. META ADS GRANULAR
  // =========================================================================
  renderMetaAds() {
    const kpiContainer = document.getElementById("meta-kpi-container");
    const campaignsContainer = document.getElementById("meta-campaigns-hierarchy");
    if (!this.metaAdsData) return;

    const s = this.metaAdsData.summary || {};

    if (kpiContainer) {
      kpiContainer.innerHTML = `
        <div class="meta-kpi-card emerald">
          <div class="meta-kpi-label">Faturamento Atribuído</div>
          <div class="meta-kpi-value">${this.formatCurrency(s.totalAttributedRevenue)}</div>
          <span style="font-size:0.72rem;color:var(--emerald-light);">Integração Stone POS</span>
        </div>

        <div class="meta-kpi-card">
          <div class="meta-kpi-label">Investimento (Spend)</div>
          <div class="meta-kpi-value">${this.formatCurrency(s.totalSpend)}</div>
          <span style="font-size:0.72rem;color:var(--text-muted);">${s.totalImpressions?.toLocaleString()} Impressões</span>
        </div>

        <div class="meta-kpi-card emerald">
          <div class="meta-kpi-label">ROAS Geral</div>
          <div class="meta-kpi-value" style="color:var(--emerald-light);">${s.globalRoas}x</div>
          <span style="font-size:0.72rem;color:var(--emerald-light);">Retorno Alto Padrão</span>
        </div>

        <div class="meta-kpi-card blue">
          <div class="meta-kpi-label">CTR Médio / CPC</div>
          <div class="meta-kpi-value">${s.averageCtr}% / ${this.formatCurrency(s.averageCpc)}</div>
          <span style="font-size:0.72rem;color:var(--text-muted);">${s.totalClicks?.toLocaleString()} Cliques no Link</span>
        </div>

        <div class="meta-kpi-card">
          <div class="meta-kpi-label">Compras Realizadas</div>
          <div class="meta-kpi-value">${s.totalPurchases}</div>
          <span style="font-size:0.72rem;color:var(--text-muted);">CPA: ${this.formatCurrency(s.costPerAcquisition)}</span>
        </div>
      `;
    }

    if (campaignsContainer) {
      const campaigns = this.metaAdsData.campaigns || [];
      campaignsContainer.innerHTML = campaigns.map(cmp => `
        <div class="meta-campaign-card">
          <div class="meta-campaign-header">
            <div class="meta-campaign-title">
              <span class="engine-pill-badge engine-apify">ATIVA</span>
              <span>${cmp.name}</span>
            </div>
            <div style="display:flex;align-items:center;gap:14px;">
              <span style="font-size:0.8rem;color:var(--text-muted);">Spend: <strong style="color:#FFF;">${this.formatCurrency(cmp.spend)}</strong></span>
              <span style="font-size:0.8rem;color:var(--text-muted);">Vendas: <strong style="color:var(--emerald-light);">${this.formatCurrency(cmp.revenue)}</strong></span>
              <span class="roas-tag-luxury">ROAS ${cmp.roas}x</span>
            </div>
          </div>

          <div class="meta-adsets-container">
            ${(cmp.adSets || []).map(adset => `
              <div class="meta-adset-box">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                  <strong style="color:#FFF;font-size:0.85rem;">📁 ${adset.name}</strong>
                  <div style="font-size:0.78rem;color:var(--text-muted);">
                    Spend: ${this.formatCurrency(adset.spend)} • Cliques: ${adset.clicks} (CTR ${adset.ctr}%) • ROAS: <strong style="color:var(--emerald-light);">${adset.roas}x</strong>
                  </div>
                </div>

                <div class="meta-ads-row">
                  ${(adset.ads || []).map(ad => `
                    <div class="meta-ad-card">
                      <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                        <strong style="color:var(--gold-light);">${ad.name}</strong>
                        <span class="roas-tag-luxury" style="font-size:0.68rem;">ROAS ${ad.roas}x</span>
                      </div>
                      <div style="color:var(--text-muted);font-size:0.72rem;margin-bottom:6px;">Formato: ${ad.format}</div>
                      <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:var(--text-secondary);">
                        <span>Cliques: ${ad.clicks} (CTR ${ad.ctr}%)</span>
                        <span>Vendas: <strong style="color:#FFF;">${this.formatCurrency(ad.revenue)}</strong></span>
                      </div>
                    </div>
                  `).join("")}
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      `).join("");
    }
  },

  // =========================================================================
  // 4. HERME AGENT & ERP VENDEDOR
  // =========================================================================
  renderHermeAgent() {
    const stockContainer = document.getElementById("erp-live-stock-container");
    const chatLog = document.getElementById("herme-chat-log");
    const chipsContainer = document.getElementById("herme-quick-chips");

    if (stockContainer) {
      stockContainer.innerHTML = this.catalog.map(p => {
        const total = Object.values(p.currentStock).reduce((a, b) => a + b, 0);
        const sizesStr = Object.entries(p.currentStock).map(([sz, qty]) => `${sz}:${qty}`).join(" | ");
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;background:rgba(15,23,42,0.6);padding:8px 12px;border-radius:8px;border:1px solid var(--border-subtle);font-size:0.78rem;">
            <div>
              <strong style="color:#FFF;">${p.name}</strong>
              <div style="color:var(--text-muted);font-size:0.7rem;">${p.stoneSku} • Grade: ${sizesStr}</div>
            </div>
            <div style="text-align:right;">
              <div style="color:var(--gold-light);font-weight:700;">${this.formatCurrency(p.price)}</div>
              <span style="font-size:0.7rem;color:${total > 10 ? 'var(--emerald-light)' : 'var(--amber-primary)'};">${total} un. em estoque</span>
            </div>
          </div>
        `;
      }).join("");
    }

    if (chatLog && chatLog.children.length === 0) {
      chatLog.innerHTML = `
        <div style="align-self:flex-start;max-width:85%;background:rgba(30,41,59,0.8);border:1px solid var(--border-subtle);padding:10px 14px;border-radius:12px;font-size:0.82rem;color:#FFF;line-height:1.4;">
          Olá! ✨ Sou o <strong>Herme Agent</strong>, Concierge de Luxo e Consultor de Vendas da <strong>SIÉ Wear @ JOY Wellness Club</strong>.<br><br>
          Estou conectado em tempo real ao estoque do clube. Como posso te vestir hoje?
        </div>
      `;
    }

    if (chipsContainer) {
      const suggestions = ["Pilates Reformer", "Musculação", "Calcular Entrega", "Reservar no Armário JOY", "Gerar Link Stone"];
      chipsContainer.innerHTML = suggestions.map(s => `
        <button class="btn-wa-chip btn-herme-suggestion" data-chip="${s}">${s}</button>
      `).join("");

      chipsContainer.querySelectorAll(".btn-herme-suggestion").forEach(btn => {
        btn.addEventListener("click", () => {
          const text = btn.getAttribute("data-chip");
          this.sendHermeMessage(text);
        });
      });
    }
  },

  async sendHermeMessage(text) {
    const chatLog = document.getElementById("herme-chat-log");
    if (!chatLog || !text.trim()) return;

    // Append user message
    chatLog.innerHTML += `
      <div style="align-self:flex-end;max-width:80%;background:rgba(212,175,55,0.2);border:1px solid var(--border-active);padding:10px 14px;border-radius:12px;font-size:0.82rem;color:#FFF;">
        ${text}
      </div>
    `;
    chatLog.scrollTop = chatLog.scrollHeight;

    try {
      const res = await fetch("/api/whatsapp/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          customerName: "Aluna VIP JOY",
          leadId: this.selectedLeadForChat
        })
      });
      const data = await res.json();

      chatLog.innerHTML += `
        <div style="align-self:flex-start;max-width:85%;background:rgba(30,41,59,0.8);border:1px solid var(--border-subtle);padding:10px 14px;border-radius:12px;font-size:0.82rem;color:#FFF;line-height:1.4;white-space:pre-line;">
          ${data.response}
        </div>
      `;
      chatLog.scrollTop = chatLog.scrollHeight;
    } catch (e) {
      console.error("Erro no chat Herme Agent:", e);
    }
  },

  // =========================================================================
  // 5. PARÂMETROS DE QUALIFICAÇÃO
  // =========================================================================
  renderQualificationRules() {
    if (!this.qualificationRules) return;

    const profBox = document.getElementById("tags-professions-box");
    const sportsBox = document.getElementById("tags-sports-box");
    const citiesBox = document.getElementById("tags-cities-box");

    if (profBox) {
      profBox.innerHTML = (this.qualificationRules.highTicketKeywords || []).map(kw => `
        <span class="tag-editable">
          <span>${kw}</span>
          <button class="tag-remove-btn" data-type="prof" data-val="${kw}">&times;</button>
        </span>
      `).join("");
    }

    if (sportsBox) {
      sportsBox.innerHTML = (this.qualificationRules.sportsAndLifestyleKeywords || []).map(kw => `
        <span class="tag-editable" style="border-color:rgba(56,189,248,0.4);color:var(--blue-accent);">
          <span>${kw}</span>
          <button class="tag-remove-btn" data-type="sport" data-val="${kw}">&times;</button>
        </span>
      `).join("");
    }

    if (citiesBox) {
      citiesBox.innerHTML = (this.qualificationRules.targetCities || []).map(city => `
        <span class="tag-editable" style="border-color:rgba(16,185,129,0.4);color:var(--emerald-light);">
          <span>${city}</span>
        </span>
      `).join("");
    }

    // Wire remove buttons
    document.querySelectorAll(".tag-remove-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const type = btn.getAttribute("data-type");
        const val = btn.getAttribute("data-val");
        if (type === "prof") {
          this.qualificationRules.highTicketKeywords = this.qualificationRules.highTicketKeywords.filter(k => k !== val);
        } else if (type === "sport") {
          this.qualificationRules.sportsAndLifestyleKeywords = this.qualificationRules.sportsAndLifestyleKeywords.filter(k => k !== val);
        }
        this.renderQualificationRules();
      });
    });
  },

  // =========================================================================
  // 6. PLAYBOOK ANTI-BAN MANUAL
  // =========================================================================
  renderSafePlaybook() {
    if (!this.playbookData) return;

    const c = this.playbookData.todayCounters || {};
    const countStories = document.getElementById("counter-stories");
    const countLikes = document.getElementById("counter-likes");
    const countFollows = document.getElementById("counter-follows");
    const countDirects = document.getElementById("counter-directs");

    if (countStories) countStories.innerText = `${c.storiesViewed || 0}/25`;
    if (countLikes) countLikes.innerText = `${c.postsLiked || 0}/25`;
    if (countFollows) countFollows.innerText = `${c.followed || 0}/25`;
    if (countDirects) countDirects.innerText = `${c.directsSent || 0}/10`;

    // Leads list for checklist
    const listContainer = document.getElementById("playbook-leads-list");
    if (listContainer) {
      const actionableLeads = this.leads.filter(l => l.score >= 4);
      listContainer.innerHTML = actionableLeads.map(lead => {
        const eng = lead.instagramEngagement || {};
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;background:rgba(26,36,56,0.7);padding:10px 14px;border-radius:10px;border:1px solid var(--border-subtle);">
            <div style="display:flex;align-items:center;gap:10px;">
              <img src="${lead.avatar}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(lead.name)}&background=1E293B&color=D4AF37'">
              <div>
                <strong style="color:#FFF;font-size:0.85rem;">${lead.name}</strong>
                <div>
                  <a href="https://instagram.com/${lead.instagram}" target="_blank" class="lead-insta-link">
                    @${lead.instagram} ↗
                  </a>
                </div>
              </div>
            </div>

            <div style="display:flex;gap:6px;">
              <button class="btn-playbook-action ${eng.storyViewed ? 'active' : ''}" data-action="storiesViewed" data-lead-id="${lead.id}" style="background:${eng.storyViewed ? 'var(--emerald-primary)' : 'rgba(255,255,255,0.08)'};border:none;color:#FFF;padding:4px 8px;border-radius:6px;font-size:0.72rem;cursor:pointer;">
                ${eng.storyViewed ? '✓ Story' : '👁️ Story'}
              </button>
              <button class="btn-playbook-action ${eng.postLiked ? 'active' : ''}" data-action="postsLiked" data-lead-id="${lead.id}" style="background:${eng.postLiked ? 'var(--emerald-primary)' : 'rgba(255,255,255,0.08)'};border:none;color:#FFF;padding:4px 8px;border-radius:6px;font-size:0.72rem;cursor:pointer;">
                ${eng.postLiked ? '✓ Like' : '❤️ Like'}
              </button>
              <button class="btn-playbook-action ${eng.followed ? 'active' : ''}" data-action="followed" data-lead-id="${lead.id}" style="background:${eng.followed ? 'var(--emerald-primary)' : 'rgba(255,255,255,0.08)'};border:none;color:#FFF;padding:4px 8px;border-radius:6px;font-size:0.72rem;cursor:pointer;">
                ${eng.followed ? '✓ Seguido' : '➕ Seguir'}
              </button>
            </div>
          </div>
        `;
      }).join("");

      listContainer.querySelectorAll(".btn-playbook-action").forEach(btn => {
        btn.addEventListener("click", async () => {
          const action = btn.getAttribute("data-action");
          const leadId = btn.getAttribute("data-lead-id");
          await this.logPlaybookAction(action, leadId);
          this.renderSafePlaybook();
        });
      });
    }
  },

  // =========================================================================
  // 7. LEAD 360° DOSSIER MODAL
  // =========================================================================
  showLeadDetailsModal(leadId) {
    const lead = this.leads.find(l => l.id === leadId);
    if (!lead) return;

    const modal = document.getElementById("modal-lead-details");
    const content = document.getElementById("lead-details-content");
    if (!modal || !content) return;

    const phoneClean = (lead.phone || "").replace(/\D/g, "");
    const waLink = phoneClean ? `https://wa.me/55${phoneClean}?text=${encodeURIComponent("Olá " + lead.name + "! Sou da SIÉ Wear @ JOY...")}` : "#";

    content.innerHTML = `
      <div style="display:flex;gap:16px;margin-bottom:20px;align-items:center;">
        <img src="${lead.avatar}" style="width:64px;height:64px;border-radius:50%;border:2px solid var(--gold-primary);object-fit:cover;">
        <div>
          <h3 style="font-family:var(--font-display);color:#FFF;font-size:1.3rem;">${lead.name}</h3>
          <a href="https://instagram.com/${lead.instagram}" target="_blank" class="lead-insta-link" style="font-size:0.85rem;">
            📸 @${lead.instagram} (Abrir no Instagram)
          </a>
          <div style="margin-top:4px;">${this.renderStars(lead.score)}</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;background:rgba(15,23,42,0.6);padding:14px;border-radius:10px;margin-bottom:16px;font-size:0.8rem;">
        <div>
          <span style="color:var(--text-muted);display:block;">WhatsApp / Telefone:</span>
          <strong style="color:#FFF;">${lead.phone || "Não informado"}</strong>
          ${phoneClean ? ` • <a href="${waLink}" target="_blank" style="color:#25D366;text-decoration:none;">Abrir Chat</a>` : ""}
        </div>
        <div>
          <span style="color:var(--text-muted);display:block;">E-mail:</span>
          <strong style="color:#FFF;">${lead.email || "Não informado"}</strong>
        </div>
        <div>
          <span style="color:var(--text-muted);display:block;">Cidade:</span>
          <strong style="color:#FFF;">${lead.city || "Florianópolis"}</strong>
        </div>
        <div>
          <span style="color:var(--text-muted);display:block;">Origem do Scraping:</span>
          <strong style="color:var(--gold-light);">${lead.source || "Instagram"}</strong>
        </div>
      </div>

      <div style="margin-bottom:16px;">
        <span style="color:var(--text-muted);font-size:0.75rem;display:block;margin-bottom:4px;">Bio do Instagram:</span>
        <div style="background:rgba(0,0,0,0.3);padding:10px;border-radius:8px;font-size:0.8rem;color:#FFF;line-height:1.4;">
          ${lead.bio}
        </div>
      </div>

      <div style="margin-bottom:16px;">
        <span style="color:var(--text-muted);font-size:0.75rem;display:block;margin-bottom:4px;">Estágio Atual no Funil:</span>
        <select id="modal-lead-stage-select" style="width:100%;padding:10px;background:#1E293B;border:1px solid var(--border-subtle);border-radius:8px;color:#FFF;font-size:0.85rem;outline:none;">
          <option value="NOVO_LEAD" ${lead.stage === 'NOVO_LEAD' ? 'selected' : ''}>🌱 Novo Lead</option>
          <option value="QUALIFICADO" ${lead.stage === 'QUALIFICADO' ? 'selected' : ''}>⭐ Qualificado High-Ticket</option>
          <option value="CAMPANHA_META" ${lead.stage === 'CAMPANHA_META' ? 'selected' : ''}>📈 Em Campanha Meta</option>
          <option value="EM_CONTATO_IA" ${lead.stage === 'EM_CONTATO_IA' ? 'selected' : ''}>🤖 Em Atendimento IA (Herme)</option>
          <option value="VISITA_AGENDADA" ${lead.stage === 'VISITA_AGENDADA' ? 'selected' : ''}>🎀 Armário VIP / Visita JOY</option>
          <option value="CONVERTIDO" ${lead.stage === 'CONVERTIDO' ? 'selected' : ''}>💳 Convertido Stone POS</option>
          <option value="RECOMPRA" ${lead.stage === 'RECOMPRA' ? 'selected' : ''}>👑 Cliente VIP / Recompra</option>
        </select>
      </div>

      ${(lead.stonePurchases && lead.stonePurchases.length > 0) ? `
        <div style="margin-bottom:16px;">
          <span style="color:var(--text-muted);font-size:0.75rem;display:block;margin-bottom:4px;">Compras no PDV Stone:</span>
          ${lead.stonePurchases.map(p => `
            <div style="display:flex;justify-content:space-between;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);padding:8px 12px;border-radius:8px;font-size:0.8rem;margin-bottom:4px;">
              <span>${p.product} (${p.date})</span>
              <strong style="color:var(--emerald-light);">${this.formatCurrency(p.amount)}</strong>
            </div>
          `).join("")}
        </div>
      ` : ""}

      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px;">
        <button id="btn-save-lead-stage" class="btn-primary-luxury">Salvar Alterações</button>
      </div>
    `;

    modal.classList.add("active");

    document.getElementById("btn-save-lead-stage").addEventListener("click", async () => {
      const newStage = document.getElementById("modal-lead-stage-select").value;
      await this.updateLeadStage(lead.id, newStage);
      modal.classList.remove("active");
      this.renderCrmKanban();
    });

    document.getElementById("btn-close-lead-modal").addEventListener("click", () => {
      modal.classList.remove("active");
    });
  },

  // =========================================================================
  // 8. GLOBAL LISTENERS SETUP
  // =========================================================================
  setupGlobalListeners() {
    // View Switcher (Lista vs Kanban)
    const btnViewList = document.getElementById("btn-crm-view-list");
    const btnViewKanban = document.getElementById("btn-crm-view-kanban");
    if (btnViewList) btnViewList.addEventListener("click", () => this.switchCrmView("list"));
    if (btnViewKanban) btnViewKanban.addEventListener("click", () => this.switchCrmView("kanban"));

    // Search input
    const searchInput = document.getElementById("crm-search-input");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        this.renderCrmView(e.target.value.trim());
      });
    }

    // Quick recalculate scores button
    const btnRecalc = document.getElementById("btn-recalc-scores-quick");
    if (btnRecalc) {
      btnRecalc.addEventListener("click", async () => {
        await this.recalculateScores();
        this.renderCrmView();
        alert("Scores recalculados com sucesso com base nas regras ativas!");
      });
    }

    // Quick sync Meta Ads button
    const btnSyncMeta = document.getElementById("btn-sync-meta-quick");
    const btnSyncMetaMain = document.getElementById("btn-sync-meta-ads");
    const syncHandler = async () => {
      const res = await this.syncMetaCustomAudience();
      alert(res.message || "Público Personalizado sincronizado com sucesso com o Meta Ads!");
    };
    if (btnSyncMeta) btnSyncMeta.addEventListener("click", syncHandler);
    if (btnSyncMetaMain) btnSyncMetaMain.addEventListener("click", syncHandler);

    // Add manual target
    const btnAddTarget = document.getElementById("btn-add-target");
    if (btnAddTarget) {
      btnAddTarget.addEventListener("click", async () => {
        const input = document.getElementById("input-new-target");
        const typeSelect = document.getElementById("select-target-type");
        const val = input.value.trim();
        if (!val) return;
        await this.addScrapingTarget(val, typeSelect.value);
        input.value = "";
        this.renderScrapingEngine();
        alert(`Alvo "${val}" adicionado à lista de extração!`);
      });
    }

    // AI Suggestions Toggle
    const btnAiSuggestions = document.getElementById("btn-show-ai-suggestions");
    if (btnAiSuggestions) {
      btnAiSuggestions.addEventListener("click", () => {
        const box = document.getElementById("ai-suggestions-container");
        if (box) box.style.display = box.style.display === "none" ? "block" : "none";
      });
    }

    // Manual instagrapi trigger
    const btnTriggerInstagrapi = document.getElementById("btn-trigger-instagrapi");
    if (btnTriggerInstagrapi) {
      btnTriggerInstagrapi.addEventListener("click", async () => {
        const target = document.getElementById("select-instagrapi-target").value;
        const batch = parseInt(document.getElementById("select-instagrapi-batch").value) || 5;
        const statusBox = document.getElementById("instagrapi-status-box");

        if (statusBox) {
          statusBox.style.display = "block";
          statusBox.innerHTML = `⏳ <strong>Executando instagrapi...</strong> Conectando a @${target} com delay humanizado (4.2s)...`;
        }

        const res = await this.executeInstagrapiManual(target, batch);

        if (statusBox) {
          statusBox.innerHTML = `✅ <strong>Sucesso!</strong> ${res.message}`;
        }
        this.renderCrmView();
      });
    }

    // Apify cloud trigger
    const btnTriggerApify = document.getElementById("btn-trigger-apify");
    if (btnTriggerApify) {
      btnTriggerApify.addEventListener("click", async () => {
        const statusBox = document.getElementById("apify-status-box");
        if (statusBox) {
          statusBox.style.display = "block";
          statusBox.innerHTML = `☁️ <strong>Job Apify disparado!</strong> Alocando proxies residenciais 4G para extração...`;
        }
        const res = await this.executeApifyCloud("trackfieldoficial");
        if (statusBox) {
          statusBox.innerHTML = `✅ <strong>Job Ativo no Apify:</strong> ${res.runId}. Webhook configurado.`;
        }
      });
    }

    // Herme Agent chat send
    const btnSendHerme = document.getElementById("btn-send-herme-msg");
    const inputHerme = document.getElementById("input-herme-msg");
    if (btnSendHerme && inputHerme) {
      const sendAction = () => {
        const val = inputHerme.value.trim();
        if (!val) return;
        inputHerme.value = "";
        this.sendHermeMessage(val);
      };
      btnSendHerme.addEventListener("click", sendAction);
      inputHerme.addEventListener("keypress", (e) => {
        if (e.key === "Enter") sendAction();
      });
    }

    // Qualification rules tags addition
    const btnAddProf = document.getElementById("btn-add-prof-tag");
    const inputProf = document.getElementById("input-new-prof-tag");
    if (btnAddProf && inputProf) {
      btnAddProf.addEventListener("click", () => {
        const val = inputProf.value.trim().toLowerCase();
        if (!val) return;
        if (!this.qualificationRules.highTicketKeywords.includes(val)) {
          this.qualificationRules.highTicketKeywords.push(val);
          inputProf.value = "";
          this.renderQualificationRules();
        }
      });
    }

    const btnAddSport = document.getElementById("btn-add-sport-tag");
    const inputSport = document.getElementById("input-new-sport-tag");
    if (btnAddSport && inputSport) {
      btnAddSport.addEventListener("click", () => {
        const val = inputSport.value.trim().toLowerCase();
        if (!val) return;
        if (!this.qualificationRules.sportsAndLifestyleKeywords.includes(val)) {
          this.qualificationRules.sportsAndLifestyleKeywords.push(val);
          inputSport.value = "";
          this.renderQualificationRules();
        }
      });
    }

    const btnSaveRules = document.getElementById("btn-save-recalc-rules");
    if (btnSaveRules) {
      btnSaveRules.addEventListener("click", async () => {
        await this.saveQualificationRules(this.qualificationRules);
        alert("Regras de qualificação salvas e scores da base recalculados com sucesso!");
      });
    }

    // Safe Playbook Interval Timer
    const btnTimer = document.getElementById("btn-start-timer");
    const timerDisplay = document.getElementById("timer-display");
    if (btnTimer && timerDisplay) {
      btnTimer.addEventListener("click", () => {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.timerRemaining = 180;

        btnTimer.disabled = true;
        btnTimer.innerText = "Contando...";

        this.timerInterval = setInterval(() => {
          this.timerRemaining--;
          const mins = Math.floor(this.timerRemaining / 60);
          const secs = this.timerRemaining % 60;
          timerDisplay.innerText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

          if (this.timerRemaining <= 0) {
            clearInterval(this.timerInterval);
            timerDisplay.innerText = "00:00 - SEGURO!";
            btnTimer.disabled = false;
            btnTimer.innerText = "Iniciar 180s";
            alert("Intervalo seguro concluído! Você pode realizar a próxima ação no Instagram.");
          }
        }, 1000);
      });
    }

    // Copy template button
    const btnCopyTemplate = document.getElementById("btn-copy-template-1");
    if (btnCopyTemplate) {
      btnCopyTemplate.addEventListener("click", () => {
        const text = "Olá! ✨ Que alegria ter você acompanhando a SIÉ Wear. Vimos seu treino em Floripa! Como estamos com boutique dentro da JOY Wellness Club no Centro, gostaríamos de te convidar para tomar um café com a gente e conhecer nossa nova coleção. Se quiser, separamos um look no seu tamanho para experimentar sem compromisso! 🎀";
        navigator.clipboard.writeText(text);
        btnCopyTemplate.innerText = "✓ Copiado para a Área de Transferência!";
        setTimeout(() => { btnCopyTemplate.innerText = "Copiar Modelo 1"; }, 3000);
      });
    }
  },

  renderStars(score) {
    const count = typeof score === 'number' ? score : (parseInt(score) || 0);
    const full = "★".repeat(Math.min(count, 5));
    const empty = "☆".repeat(Math.max(0, 5 - count));
    return `<span style="color:#D4AF37;letter-spacing:1px;">${full}${empty}</span>`;
  },

  formatCurrency(val) {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(val || 0);
  }
};

window.CrmGrowthHub = CrmGrowthHub;
