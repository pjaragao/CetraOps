# ADR-0006 — Privilégios de funções: nada executável por PUBLIC

**Contexto.** No PostgreSQL toda função nasce executável por `PUBLIC`; `alter default privileges` por schema não muda isso. Funções `SECURITY DEFINER` expostas pelo PostgREST seriam chamáveis por qualquer usuário (inclusive `anon`).

**Decisão.** `private.lock_functions()` (lista em `private.internal_functions`) revoga `PUBLIC` e `anon` em todas as funções dos schemas de aplicação, concede a `authenticated` e `service_role` e **retira do app as funções internas** (só `service_role`). **Toda migration que cria funções termina com `select private.lock_functions();`** e registra as internas. O teste pgTAP `008_privileges` falha se qualquer função de schema exposto ficar executável por PUBLIC.

**Consequências.** Segurança por padrão, verificada em CI; esquecer a chamada é pego pelo teste.
