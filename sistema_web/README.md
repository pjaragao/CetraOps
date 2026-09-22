# 💻 Sistema Web & Ponto de Venda (SIÉ Joy OS)

Este diretório contém a aplicação web interativa de controle de PDV, simulação financeira, monitoramento de vendas em tempo real e integração com o ecossistema de pagamentos **Stone**.

---

## 📂 Arquitetura da Aplicação

```text
sistema_web/
├── server.py       # Servidor HTTP nativo em Python (Zero dependências externas, porta 3001)
├── index.html      # Interface responsiva de alta estética (Dark/Light mode, gráficos e métricas)
├── css/            # Folhas de estilo modularizadas em Vanilla CSS
├── js/             # Lógica de controle, roteamento de estado e simulações em Vanilla JS
└── data/           # Repositório de dados e persistência em arquivos JSON locais
```

---

## 🚀 Como Executar o Sistema Web

Para iniciar o servidor localmente sem necessidade de instalar pacotes externos:

```bash
# A partir da raiz do projeto:
python sistema_web/server.py

# Ou entrando na pasta:
cd sistema_web
python server.py
```

Acesse no seu navegador:
👉 **[http://localhost:3001](http://localhost:3001)**

---

## 🛠️ Principais Módulos Integrados

1.  **Dashboard Financeiro em Tempo Real:** Visualização da DRE mensal, ponto de equilíbrio, faturamento acumulado e margem líquida.
2.  **Terminal de PDV & Registro de Vendas:** Emissão simulada de NFC-e, controle de comissionamento de vendedora (60% titular / 40% proprietária) e divisão de formas de pagamento (Crédito D+1 Stone).
3.  **Simulador de Cenários Interativo:** Parametrização em tempo real de variações de aluguel, taxa de markup e volume de compras com cálculo automático de payback.
4.  **Gateway de Webhooks Stone:** Endpoints prontos para escuta de confirmação de transações e conciliação bancária automática via Stone.
