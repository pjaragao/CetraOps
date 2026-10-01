# ADR-0007 — Entrega e infraestrutura

**Decisão.**
- **Banco** no Supabase Cloud (sa-east-1, PITR); **web, worker, MCP e Hermes** numa VPS em São Paulo (Docker + Coolify + Traefik). Só o `web` é público; o resto fica na rede interna, sem portas publicadas.
- **Webhooks** entram pelas Edge Functions do Supabase (continuam no ar se a VPS cair).
- **CI** (GitHub Actions): typecheck, lint, Vitest e build; pgTAP; lint PL/pgSQL; Ruff; pytest (worker, MCP e contrato); testes das funções de webhook; build das imagens.
- **Release por tag**: imagens → **aprovação manual** (Environment `production`) → migrations + Edge Functions → promoção da tag `prod` → deploy no Coolify. **Rollback** reaponta `prod`; migrations só vão para frente.
- Infra versionada em `infra/` (compose, hardening, backup, runbook) para recriar a VPS em menos de 1 h; backups: PITR + dump lógico semanal verificado + snapshot da VPS; restauração testada por trimestre.

**Consequências.** Custo fixo e controle total da VPS; dados de negócio fora dela (quase *stateless*); produção só muda com aprovação humana.
