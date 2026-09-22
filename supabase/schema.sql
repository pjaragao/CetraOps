-- ========================================================
-- CetraOps / SIÉ Joy OS - Supabase Database Schema
-- Compatível com PostgreSQL 15+ (Supabase)
-- ========================================================

-- Habilitar extensões úteis
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Tabela: CRM Leads
CREATE TABLE IF NOT EXISTS public.crm_leads (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    instagram TEXT,
    avatar TEXT,
    bio TEXT,
    phone TEXT,
    email TEXT,
    city TEXT,
    followers INTEGER DEFAULT 0,
    score INTEGER DEFAULT 1 CHECK (score >= 1 AND score <= 5),
    stage TEXT DEFAULT 'NOVO' CHECK (stage IN ('NOVO', 'QUALIFICADO', 'CONTATADO', 'AGENDADO', 'CONVERTIDO', 'ARQUIVADO')),
    tags JSONB DEFAULT '[]'::jsonb,
    source TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Tabela: Regras de Qualificação do CRM
CREATE TABLE IF NOT EXISTS public.crm_qualification_rules (
    id TEXT PRIMARY KEY DEFAULT 'default',
    high_ticket_keywords JSONB DEFAULT '[]'::jsonb,
    sports_and_lifestyle_keywords JSONB DEFAULT '[]'::jsonb,
    target_cities JSONB DEFAULT '[]'::jsonb,
    scoring_weights JSONB DEFAULT '{}'::jsonb,
    last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Tabela: Alvos de Scraping & Prospecção
CREATE TABLE IF NOT EXISTS public.scraping_targets (
    id TEXT PRIMARY KEY,
    type TEXT DEFAULT 'PROFILE',
    target TEXT NOT NULL,
    display_name TEXT,
    category TEXT,
    status TEXT DEFAULT 'ATIVO',
    leads_found INTEGER DEFAULT 0,
    last_scraped TIMESTAMPTZ DEFAULT NOW(),
    is_ai_suggested BOOLEAN DEFAULT FALSE
);

-- 4. Tabela: Catálogo de Produtos & Estoque Stone
CREATE TABLE IF NOT EXISTS public.stone_catalog (
    id TEXT PRIMARY KEY,
    stone_sku TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT,
    color TEXT,
    price NUMERIC(10,2) NOT NULL,
    cost NUMERIC(10,2) NOT NULL,
    current_stock JSONB DEFAULT '{"P": 0, "M": 0, "G": 0, "GG": 0}'::jsonb,
    min_stock_target JSONB DEFAULT '{"P": 0, "M": 0, "G": 0, "GG": 0}'::jsonb,
    sales_velocity_weekly NUMERIC(10,2) DEFAULT 0,
    lead_time_days INTEGER DEFAULT 15,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Tabela: Vendas e Transações Stone
CREATE TABLE IF NOT EXISTS public.stone_sales (
    id TEXT PRIMARY KEY,
    stone_transaction_id TEXT UNIQUE,
    sale_date TIMESTAMPTZ DEFAULT NOW(),
    seller_type TEXT CHECK (seller_type IN ('TITULAR', 'PROPRIETARIA')),
    seller_name TEXT,
    gross_amount NUMERIC(10,2) NOT NULL,
    payment_method TEXT DEFAULT 'CREDIT_D1',
    rate_percentage NUMERIC(5,2) DEFAULT 3.18,
    net_amount NUMERIC(10,2) NOT NULL,
    commission_rate NUMERIC(5,2) DEFAULT 0,
    commission_amount NUMERIC(10,2) DEFAULT 0,
    items JSONB DEFAULT '[]'::jsonb,
    nfce_number TEXT,
    nfce_status TEXT DEFAULT 'EMITIDA',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Tabela: Contas a Receber (ERP)
CREATE TABLE IF NOT EXISTS public.accounts_receivable (
    id TEXT PRIMARY KEY,
    cnpj_id TEXT,
    store_id TEXT,
    description TEXT,
    client_name TEXT,
    gross_amount NUMERIC(10,2) NOT NULL,
    net_amount NUMERIC(10,2) NOT NULL,
    fee_amount NUMERIC(10,2) DEFAULT 0,
    payment_method TEXT,
    due_date DATE,
    status TEXT DEFAULT 'RECEBIDO',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Tabela: Contas a Pagar (ERP)
CREATE TABLE IF NOT EXISTS public.accounts_payable (
    id TEXT PRIMARY KEY,
    cnpj_id TEXT,
    store_id TEXT,
    supplier_name TEXT NOT NULL,
    category TEXT,
    description TEXT,
    amount NUMERIC(10,2) NOT NULL,
    due_date DATE NOT NULL,
    status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'PAID', 'OVERDUE')),
    barcode TEXT,
    payment_method TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Tabela: Conciliação Bancária
CREATE TABLE IF NOT EXISTS public.bank_reconciliation (
    id TEXT PRIMARY KEY,
    date DATE NOT NULL,
    description TEXT NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    type TEXT CHECK (type IN ('CREDIT', 'DEBIT')),
    status TEXT DEFAULT 'CONCILIADO' CHECK (status IN ('CONCILIADO', 'DIVERGENCIA', 'PENDENTE')),
    stone_reference TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Tabela: Colaboradores e Folha
CREATE TABLE IF NOT EXISTS public.employees_and_payroll (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    contract_type TEXT DEFAULT 'CLT_6H',
    store_id TEXT,
    base_salary NUMERIC(10,2) NOT NULL,
    commission_pct NUMERIC(5,2) DEFAULT 0,
    vt_allowance NUMERIC(10,2) DEFAULT 0,
    active BOOLEAN DEFAULT TRUE,
    hire_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Tabela: CNPJs e Lojas / Unidades
CREATE TABLE IF NOT EXISTS public.cnpjs_and_stores (
    id TEXT PRIMARY KEY,
    razao_social TEXT NOT NULL,
    nome_fantasia TEXT,
    cnpj TEXT UNIQUE NOT NULL,
    regime_tributario TEXT DEFAULT 'SIMPLES_NACIONAL',
    cnae_principal TEXT,
    stores JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Tabela: Metas Financeiras e Orçamento
CREATE TABLE IF NOT EXISTS public.financial_targets (
    id TEXT PRIMARY KEY DEFAULT 'current',
    targets JSONB DEFAULT '{}'::jsonb,
    scenarios JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. Tabela: Campanhas de Drops & Eventos
CREATE TABLE IF NOT EXISTS public.drops_campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    launch_date DATE,
    theme TEXT,
    status TEXT DEFAULT 'PLANEJADO',
    budget NUMERIC(10,2) DEFAULT 0,
    revenue_target NUMERIC(10,2) DEFAULT 0,
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 13. Tabela: Configurações Fiscais e Tributárias
CREATE TABLE IF NOT EXISTS public.tax_settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    regimes JSONB DEFAULT '{}'::jsonb,
    current_forecast JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 14. Tabela: Plano de Contas e Centros de Custo
CREATE TABLE IF NOT EXISTS public.chart_of_accounts (
    id TEXT PRIMARY KEY DEFAULT 'default',
    accounts JSONB DEFAULT '[]'::jsonb,
    cost_centers JSONB DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 15. Tabela: Contatos e Entidades (Fornecedores / Clientes)
CREATE TABLE IF NOT EXISTS public.contacts_entities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    category TEXT,
    name TEXT NOT NULL,
    cpf_cnpj TEXT,
    email TEXT,
    phone TEXT,
    city TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices de Performance
CREATE INDEX IF NOT EXISTS idx_crm_leads_stage ON public.crm_leads(stage);
CREATE INDEX IF NOT EXISTS idx_crm_leads_score ON public.crm_leads(score);
CREATE INDEX IF NOT EXISTS idx_stone_catalog_sku ON public.stone_catalog(stone_sku);
CREATE INDEX IF NOT EXISTS idx_stone_sales_date ON public.stone_sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_payables_due ON public.accounts_payable(due_date);
CREATE INDEX IF NOT EXISTS idx_receivables_due ON public.accounts_receivable(due_date);

-- Habilitar Row Level Security (RLS)
ALTER TABLE public.crm_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_qualification_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scraping_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stone_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stone_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts_receivable ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts_payable ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees_and_payroll ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cnpjs_and_stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drops_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts_entities ENABLE ROW LEVEL SECURITY;

-- Políticas de Acesso Permissivas para Aplicação Autenticada / Anon
DO $$
BEGIN
    DROP POLICY IF EXISTS "Allow full access to anon and authenticated" ON public.crm_leads;
    CREATE POLICY "Allow full access to anon and authenticated" ON public.crm_leads FOR ALL USING (true) WITH CHECK (true);
    
    DROP POLICY IF EXISTS "Allow full access to anon and authenticated" ON public.stone_catalog;
    CREATE POLICY "Allow full access to anon and authenticated" ON public.stone_catalog FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Allow full access to anon and authenticated" ON public.stone_sales;
    CREATE POLICY "Allow full access to anon and authenticated" ON public.stone_sales FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Allow full access to anon and authenticated" ON public.accounts_payable;
    CREATE POLICY "Allow full access to anon and authenticated" ON public.accounts_payable FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Allow full access to anon and authenticated" ON public.accounts_receivable;
    CREATE POLICY "Allow full access to anon and authenticated" ON public.accounts_receivable FOR ALL USING (true) WITH CHECK (true);

    DROP POLICY IF EXISTS "Allow full access to anon and authenticated" ON public.bank_reconciliation;
    CREATE POLICY "Allow full access to anon and authenticated" ON public.bank_reconciliation FOR ALL USING (true) WITH CHECK (true);
END $$;
