# CetraOps: Gestão Operacional, Modelagem Financeira & Expansão (SIÉ Wear)

O **CetraOps** é a plataforma integrada de gestão operacional, inteligência financeira, PDV e planejamento de expansão territorial da **[SIÉ Wear](https://siewear.com/)**. 

O projeto contempla a modelagem econômico-financeira completa e diretrizes operacionais para a unidade piloto no clube de bem-estar **[JOY Wellness Club](https://www.founderjoy.com.br/)** (unidade Rua Esteves Júnior, 567 - Centro de Florianópolis/SC), além de um sistema web nativo de PDV (SIÉ Joy OS), esteira de automação documental, suporte a contêineres **Docker**, integração com banco de dados **Supabase** e roteiro de expansão regional.

---

## 📂 Estrutura do Repositório

```text
CetraOps/
├── README.md                              # Visão geral executiva e guia da plataforma
├── PROJECT_INSTRUCTIONS.md                # Diretrizes para IA, regras de governança e arquitetura
├── Dockerfile                             # Configuração do contêiner Docker para o sistema web
├── docker-compose.yml                     # Orquestração do serviço web com variáveis de ambiente
├── .dockerignore                          # Otimizações de build do Docker
├── .gitignore                             # Filtros de arquivos temporários, caches e ambientes
├── .env.example                           # Modelo de variáveis de ambiente (Porta, Supabase, etc.)
├── requirements.txt                       # Dependências Python (openpyxl, supabase, requests)
│
├── supabase/                              # Integração e Schemas do Banco de Dados
│   └── schema.sql                         # DDL completo (tabelas, índices e RLS) para o Supabase
│
├── sistema_web/                           # Sistema Operacional de PDV & Integração Stone (SIÉ Joy OS)
│   ├── server.py                          # Servidor HTTP com rotas REST e gateway de integração
│   ├── supabase_client.py                 # Cliente e adaptador de sincronização com o Supabase
│   ├── index.html                         # Interface web responsiva (Dark/Light mode, simulações)
│   ├── Dockerfile                         # Dockerfile específico da aplicação web
│   ├── requirements.txt                   # Dependências exclusivas do sistema web
│   ├── .env.example                       # Variáveis de ambiente para o sistema web
│   ├── README.md                          # Manual de execução e documentação das APIs
│   ├── css/                               # Estilização modular em Vanilla CSS
│   ├── js/                                # Regras de negócio, estado, simulações e Supabase bridge
│   │   └── supabase_client.js             # Bridge frontend para Supabase
│   └── data/                              # Repositório de dados e persistência JSON local (fallback)
│
├── primeira_unidade_joy/                  # Unidade Piloto: Florianópolis / JOY Wellness Club
│   ├── Plano_de_Negocios_SIE_JOY.xlsx     # Arquivo mestre ÚNICO em Excel (12 abas, 5.773 fórmulas)
│   ├── Descritivo_Empresa_SIE_Wear_CNAE.pdf # Parecer societário e matriz oficial de CNAEs em PDF
│   ├── DESCRITIVO_EMPRESA_CNAE.md         # Descritivo executivo para contabilidade / abertura
│   ├── README.md                          # Visão geral e métricas da primeira unidade
│   └── docs/                              # 9 Notas técnicas aprofundadas em Markdown
│
├── plano_de_expansao/                     # Planejamento Estratégico de Expansão Territorial
│   ├── Plano_de_Expansao_SIE_Wear.pdf     # Dossiê executivo diagramado em PDF (6 páginas A4)
│   ├── README.md                          # Índice, cobertura e metodologia de expansão
│   ├── 01_mapeamento_academias_high_ticket.md # Mapeamento completo de 14 cidades em SC e RS
│   ├── 02_modelos_de_negocio_e_parcerias.md # Formatos: Shop-in-Shop, Consignado e Drops
│   ├── 03_planejamento_tributario_e_societario_expansao.md # Rampa tributária e estrutura societária
│   └── generate_pdf_plano_expansao.py     # Script gerador do PDF via Edge headless
│
└── scripts/                               # Automação, Compilação e Validações
    ├── build_financial_model.py           # Gerador do arquivo Excel único com fórmulas nativas
    ├── generate_expansion_pdf.py          # Compilador do PDF do Plano de Expansão
    ├── generate_cnae_pdf.py               # Compilador do PDF de CNAE / Societário
    ├── validate_formulas.py               # Validador de integridade de fórmulas (5.773 verificadas)
    ├── dump_values.py                     # Extrator de métricas e relatório de remuneração
    ├── audit_model.py                     # Auditor de integridade do arquivo Excel
    └── README.md                          # Guia de execução dos scripts de automação
```

---

## 🐳 Executando com Docker

O sistema web está pronto para execução isolada em contêiner Docker via `docker-compose` ou comando direto.

### Opção 1: Usando Docker Compose (Recomendado)

1. Crie o arquivo `.env` baseado no `.env.example`:
   ```bash
   cp .env.example .env
   ```

2. Suba o contêiner com build automático:
   ```bash
   docker compose up --build -d
   ```

3. Acesse no navegador: **`http://localhost:3001`**

Para verificar os logs do contêiner:
```bash
docker compose logs -f web
```

Para parar o contêiner:
```bash
docker compose down
```

### Opção 2: Build e Execução Manual via Docker CLI

```bash
# Build da imagem
docker build -t cetraops-web .

# Execução do contêiner
docker run -d -p 3001:3001 --name cetraops_web --env-file .env cetraops-web
```

---

## ⚡ Integração com o Supabase

O **CetraOps** suporta persistência híbrida: opera tanto com fallback local em arquivos JSON (zero configuração) quanto integrado diretamente a uma instância do **[Supabase](https://supabase.com/)** (PostgreSQL na nuvem).

### 1. Configuração das Credenciais

Defina as variáveis no seu arquivo `.env` ou nas variáveis do contêiner Docker:

```env
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_ANON_KEY=sua-chave-anon-publica
SUPABASE_SERVICE_ROLE_KEY=sua-chave-service-role-secreta
```

### 2. Criação das Tabelas no Supabase

Copie o conteúdo do script SQL em **[supabase/schema.sql](file:///c:/Users/paulojr/Documents/SIE-Joy/supabase/schema.sql)** e execute-o no **SQL Editor** do painel do Supabase. O script provisiona:

- **`crm_leads`**: Base de leads e prospects qualificados.
- **`crm_qualification_rules`**: Pesos e palavras-chave para o score de clientes.
- **`scraping_targets`**: Alvos de prospecção e perfis monitorados.
- **`stone_catalog`**: Catálogo de produtos com controle de estoque e SKU Stone.
- **`stone_sales`**: Histórico de transações, comissões e emissão de NFC-e.
- **`accounts_payable` & `accounts_receivable`**: Módulos financeiro e ERP de contas.
- **`bank_reconciliation`**: Conciliação bancária de recebíveis Stone.
- **`employees_and_payroll`**: Equipe de vendas e folha de pagamento.
- **`cnpjs_and_stores`**: Estrutura multiloja e dados fiscais.
- Políticas de **Row Level Security (RLS)** e índices de performance pré-configurados.

### 3. Endpoints de Sincronização e Status

O servidor disponibiliza rotas automáticas para gerenciamento do Supabase:

- **`GET /api/supabase/status`**: Retorna se o Supabase está configurado e conectado.
- **`POST /api/supabase/test`**: Testa a latência e conectividade com a API REST do Supabase.
- **`POST /api/supabase/sync`**: Realiza o upload e sincronização de todos os dados locais para as tabelas do Supabase.

---

## 💻 Execução Local (Sem Docker)

### 1. Sistema Web
```bash
# Instalar dependências (opcional se não usar o cliente supabase-py)
pip install -r requirements.txt

# Executar o servidor HTTP
python sistema_web/server.py
```
Acesse: **`http://localhost:3001`**

### 2. Scripts de Automação & Modelagem Financeira
```bash
# Gerar o modelo financeiro em Excel (12 abas, fórmulas nativas)
python scripts/build_financial_model.py

# Validar integridade das 5.773 fórmulas
python scripts/validate_formulas.py

# Compilar PDFs executivos
python scripts/generate_expansion_pdf.py
python scripts/generate_cnae_pdf.py
```

---

## 🚀 Plano de Expansão High-Ticket & Governança Multi-Unidades

O projeto conta com inteligência completa de expansão em **[plano_de_expansao/](file:///c:/Users/paulojr/Documents/SIE-Joy/plano_de_expansao/)**, documentada no dossiê oficial **[Plano_de_Expansao_SIE_Wear.pdf](file:///c:/Users/paulojr/Documents/SIE-Joy/plano_de_expansao/Plano_de_Expansao_SIE_Wear.pdf)**:

1. **Alvos de Prioridade Máxima (Tier 1 & Rede JOY)**:
   - **[JOY Wellness Club](https://www.founderjoy.com.br/) (Esteves Júnior)**: Unidade Piloto Oficial (1.700 m², Centro de Floripa).
   - **[JOY Wellness Club](https://www.founderjoy.com.br/) (Mauro Ramos)**: Matriz original ao lado do Beiramar Shopping (Technogym, sauna, cold plunge). Prioridade imediata para replicação de rede.
   - **[F.Scherer Fitness](https://fscherer.com.br/) (Beiramar Shopping, 6º Piso)**: Academia boutique tradicional da família Scherer, com bike studio, yoga e Clínica K Sports (público feminino de alto ticket).
   - **Last Wellness Club** (Praia Brava / Itajaí) e **Wave Barra Sul** (Balneário Camboriú).
   - **INEEX Club** (Praça Japão / Porto Alegre) e **Just Burn Club** (Moinhos de Vento / POA).
2. **Modelos de Negócio Escaláveis**: Shop-in-Shop Integral (padrão JOY), Corner em Consignação com risco fixo zero (15-20% de comissão) e Pop-Up Drops.
3. **Planejamento Tributário & Societário**: Rampa do Simples Nacional (4% a 10,8%), sublimite estadual de ICMS (R$ 3,6M), transição para Lucro Presumido (> R$ 4,8M), blindagem patrimonial via Holding e parcerias locais via SCP.
