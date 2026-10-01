# Registros de decisão de arquitetura (ADR)

Cada decisão relevante fica registrada com contexto, escolha e consequências. Formato curto; novas decisões entram como novo arquivo numerado
(nunca reescreva o histórico: marque a antiga como *Substituída por ADR-XXXX*).

| # | Decisão | Situação |
|---|---|---|
| [0001](0001-banco-como-sistema-de-registro-e-barramento.md) | Postgres (Supabase) é o sistema de registro e o barramento | Aceita |
| [0002](0002-rateio-na-baixa.md) | Rateio acontece na baixa (liquidação), não num menu à parte | Aceita |
| [0003](0003-rh-integrado-ao-financeiro-contabil-fiscal.md) | Módulo de RH completo, integrado ao financeiro, contábil e fiscal | Aceita |
| [0004](0004-pipeline-de-mensagens.md) | Pipeline de mensagens: webhook → fila → roteador → IA ou humano → envio | Aceita |
| [0005](0005-seguranca-do-agente-de-ia.md) | Segurança do agente de IA: ferramentas pelo banco, token de contexto, guardrails | Aceita |
| [0006](0006-privilegios-de-funcoes.md) | Privilégios de funções: nada executável por PUBLIC | Aceita |
| [0007](0007-entrega-e-infraestrutura.md) | CI/CD, imagens e infraestrutura (VPS + Coolify, banco no Supabase) | Aceita |
