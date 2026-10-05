-- =====================================================================
-- Administrador inicial (idempotente; roda em qualquer ambiente e a cada deploy pelo sie-migrate).
-- Só age se a empresa não tiver nenhum sócio ativo ou se a conta do e-mail existir sem vínculo; ver a migration 20261005000200.
-- A senha provisória vai como hash bcrypt; a troca é obrigatória no primeiro acesso.
-- =====================================================================
select private.ensure_initial_admin('pjaragaojr@gmail.com', '$2a$10$s6MPTgNmcYTdmG.auwsrm.UpNqmhCKZQjminTZQ03ZrCl/qyhwKj6');
